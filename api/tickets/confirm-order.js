/* ═══════════════════════════════════════════════════════════════
   POST /api/tickets/confirm-order
   The single deduction trigger. Called ONLY once a payment has been
   confirmed successful.

   Two accepted callers, both authenticated server-side:

   1. Admin approval (manual bank-transfer verification)
      Authorization: Bearer <Firebase ID token> of an admin listed in
      the ADMIN_EMAILS env var. The tier quantities are NOT taken from
      the request body — they are read from the order document in
      Firestore, so a tampered client cannot move arbitrary stock.

   2. Payment provider webhook (Selar or equivalent)
      Authorization: x-webhook-secret matching SELAR_WEBHOOK_SECRET.
      The reference comes from the verified payload only.

   Idempotency is keyed on the payment/order reference. Replaying the
   same reference is a no-op that still returns 200.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const { db, requireAdmin } = require('../_lib/firebase-admin');
const {
  commitDeduction,
  SoldOutError,
  normaliseTierKey
} = require('../_lib/ticket-inventory');

const CHECKOUTS = 'checkouts';

/**
 * States that mean "the money is in, stock may move".
 * Both fields are checked because the site has historically written
 * either one (payment.html sets paymentStatus, admin.html sets both).
 */
const PAID_STATES = new Set(['approved', 'verified']);

function isPaid(order) {
  if (!order) return false;
  return PAID_STATES.has(String(order.paymentStatus || '').toLowerCase()) ||
         PAID_STATES.has(String(order.status || '').toLowerCase());
}

/** Pulls { key, qty } lines out of a checkout document. */
function linesFromOrder(order) {
  const raw = order && order.tickets;
  const lines = [];

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [tier, qty] of Object.entries(raw)) {
      const key = normaliseTierKey(tier);
      const n = Number(qty);
      if (key && Number.isInteger(n) && n > 0) lines.push({ key, qty: n });
    }
  }

  // Fallback: derive one line per attendee record.
  if (lines.length === 0 && Array.isArray(order && order.attendees)) {
    const counts = new Map();
    for (const attendee of order.attendees) {
      const key = normaliseTierKey(attendee.ticketTier || attendee.ticketTierName);
      if (!key) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    counts.forEach((qty, key) => lines.push({ key, qty }));
  }

  return lines;
}

/** Selar sends the purchased product title; map it to a tier. */
function linesFromWebhook(payload) {
  const lines = [];
  const raw = payload.items || payload.products || payload.order_items || [];
  const list = Array.isArray(raw) ? raw : [];

  for (const item of list) {
    const key =
      normaliseTierKey(item.ticket_type || item.name || item.title || item.product_name);
    const qty = Number(item.quantity || item.qty || 1);
    if (key && Number.isInteger(qty) && qty > 0) lines.push({ key, qty });
  }
  return lines;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = req.body || {};
  const webhookSecret = process.env.SELAR_WEBHOOK_SECRET;
  const presentedSecret = req.headers['x-webhook-secret'];

  const isWebhook =
    !!webhookSecret && presentedSecret && presentedSecret === webhookSecret;

  let orderId = String(body.reference || body.orderId || body.transactionRef || '').trim();
  let lines = [];
  let actor = 'webhook';

  try {
    if (isWebhook) {
      // ── Provider callback ──────────────────────────────────────
      lines = linesFromWebhook(body);
      if (lines.length === 0) {
        return res.status(400).json({ error: 'Webhook payload contained no ticket lines' });
      }
      if (body.status && !/paid|success|complete/i.test(String(body.status))) {
        // Not a successful payment — never deduct.
        return res.status(200).json({ ok: true, skipped: true, reason: 'payment_not_successful' });
      }
    } else {
      // ── Admin approval ─────────────────────────────────────────
      const admin = await requireAdmin(req);
      if (!admin) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!admin.isAdmin) {
        return res.status(403).json({ error: 'Admin access required' });
      }
      actor = admin.uid;
      if (!orderId) {
        return res.status(400).json({ error: 'orderId is required' });
      }

      // Read the order from the database. Quantities are NEVER taken
      // from the client payload.
      const orderSnap = await db().collection(CHECKOUTS).doc(orderId).get();
      if (!orderSnap.exists) {
        return res.status(404).json({ error: `Order ${orderId} not found` });
      }
      const order = orderSnap.data();

      // Rejected orders never deduct and are not an error.
      if (String(order.paymentStatus || '').toLowerCase() === 'rejected') {
        return res.status(200).json({ ok: true, skipped: true, reason: 'order_rejected' });
      }

      // The payment must already be marked paid in Firestore. Without
      // this gate an admin token could be used to decrement stock for an
      // order that was never paid for.
      if (!isPaid(order)) {
        return res.status(409).json({
          error: 'Order is not marked as paid',
          code: 'PAYMENT_NOT_CONFIRMED',
          paymentStatus: order.paymentStatus || null
        });
      }

      lines = linesFromOrder(order);
      if (lines.length === 0) {
        return res.status(400).json({ error: 'Order contains no ticket quantities' });
      }
    }

    const result = await commitDeduction({ orderId, lines, actor });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof SoldOutError || err.code === 'SOLD_OUT') {
      return res.status(err.status || 409).json({
        error: err.message,
        code: 'SOLD_OUT',
        shortages: err.lines
      });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('[confirm-order] failed', err);
    return res.status(500).json({ error: 'Unable to commit ticket deduction' });
  }
};

/* ═══════════════════════════════════════════════════════════════
   POST /api/tickets/reserve
   Deducts inventory the instant a checkout/registration is created.

   WHY THIS EXISTS
   ---------------
   A ticket is counted as taken the moment the buyer submits the
   checkout form — not when they pay and not when an admin approves.
   This endpoint is called by checkout.html immediately after the
   `checkouts/{orderId}` document is written, which is the successful
   creation event.

   Safety
   ------
   * The quantities are read back from the order document in Firestore,
     not trusted from the request body — the caller can only pass an
     orderId, never a tier or a quantity.
   * commitDeduction is idempotent on orderId via the
     ticket_inventory_ledger, so a duplicate request (double click,
     retry, page refresh) can only ever deduct once.
   * Firestore transactions keep remainingQuantity from going negative,
     and the whole order is rejected if any tier is short.

   This does NOT gate the buyer: the order already exists, and a failed
   count is settled later by the admin/approval path, which shares the
   same idempotency ledger so it will not double-deduct either.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const { db } = require('../_lib/firebase-admin');
const {
  commitDeduction,
  SoldOutError,
  normaliseTierKey,
  ensureSeeded,
  readInventory
} = require('../_lib/ticket-inventory');

const CHECKOUTS = 'checkouts';

/**
 * Derives the tier lines from a stored order. Mirrors the helper in
 * review-order.js so the checkout-time and approval-time paths always
 * agree on what a given order contains.
 */
function linesFromOrder(order) {
  const lines = [];
  const raw = order && order.tickets;

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [tier, qty] of Object.entries(raw)) {
      const key = normaliseTierKey(tier);
      const n = Number(qty);
      if (key && Number.isInteger(n) && n > 0) lines.push({ key, qty: n });
    }
  }

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

function remainingMap(tiers) {
  return tiers.reduce((acc, t) => {
    acc[t.key] = t.remainingQuantity;
    return acc;
  }, {});
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const orderId = String((req.body && req.body.orderId) || '').trim();
  if (!orderId) {
    return res.status(400).json({ error: 'orderId is required' });
  }

  try {
    const snap = await db().collection(CHECKOUTS).doc(orderId).get();
    if (!snap.exists) {
      return res.status(404).json({ error: `Order ${orderId} not found` });
    }

    const lines = linesFromOrder(snap.data());
    if (lines.length === 0) {
      return res.status(400).json({
        error: 'Order contains no ticket quantities',
        code: 'NO_TICKET_LINES'
      });
    }

    await ensureSeeded();

    const result = await commitDeduction({
      orderId,
      lines,
      actor: 'checkout'
    });

    const tiers = await readInventory();

    return res.status(200).json({
      ok: true,
      orderId,
      lines: result.lines,
      alreadyProcessed: result.alreadyProcessed,
      remaining: remainingMap(tiers)
    });
  } catch (err) {
    if (err instanceof SoldOutError || err.code === 'SOLD_OUT') {
      return res.status(err.status || 409).json({
        error: err.message,
        code: 'SOLD_OUT',
        shortages: err.lines,
        orderId
      });
    }
    console.error('[reserve] failed', err);
    return res.status(500).json({ error: 'Unable to reserve ticket inventory' });
  }
};
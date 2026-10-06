/* ═══════════════════════════════════════════════════════════════
   POST /api/tickets/review-order
   Admin-only status transition for a checkout order.

   WHY THIS EXISTS
   ---------------
   admin.html used to write the approval straight to Firestore from the
   browser. That is wrong twice over:

   1. It does not work. firestore.rules only lets a client move an order
      between 'pending' and 'awaiting_verification', precisely so that
      a buyer can never declare their own payment successful. An admin
      browser is still a browser, so the write was denied.

   2. Even if the rules were relaxed to allow it, the rule would be
      satisfiable by any authenticated buyer — which would let anyone
      approve their own order and have stock deducted.

   So the transition is done here instead: the Admin SDK bypasses the
   rules, and the caller is checked against ADMIN_EMAILS by
   requireAdmin(). Approving here also commits the inventory deduction
   in the same request, so stock can never be left un-deducted behind a
   client that failed halfway.

   Delivery metadata (who the ticket was emailed/WhatsApped to) is
   accepted from the caller but is a fixed, allowlisted set of fields —
   it is a note about the admin's own action, not a quantity, so it
   cannot move stock.

   Request body:
     { orderId, decision: 'approve' | 'reject', delivery?: {
         channel: 'email' | 'whatsapp', to: string } }
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const { db, requireAdmin, Timestamp } = require('../_lib/firebase-admin');
const {
  commitDeduction,
  SoldOutError,
  normaliseTierKey
} = require('../_lib/ticket-inventory');

const CHECKOUTS = 'checkouts';

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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const admin = await requireAdmin(req);
  if (!admin) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!admin.isAdmin) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const body = req.body || {};
  const orderId = String(body.orderId || '').trim();
  const decision = String(body.decision || '').trim().toLowerCase();

  if (!orderId) return res.status(400).json({ error: 'orderId is required' });
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ error: "decision must be 'approve' or 'reject'" });
  }

  const ref = db().collection(CHECKOUTS).doc(orderId);
  const orderSnap = await ref.get();
  if (!orderSnap.exists) {
    return res.status(404).json({ error: `Order ${orderId} not found` });
  }
  const order = orderSnap.data();

  const current = String(order.paymentStatus || '').toLowerCase();
  const alreadyPaid = current === 'approved' || current === 'verified';

  // ── Reject ────────────────────────────────────────────────────
  // No inventory is touched. Re-approving a rejected order is allowed,
  // so an admin who rejected by mistake can undo it.
  if (decision === 'reject') {
    await ref.update({
      paymentStatus: 'rejected',
      status: 'rejected',
      adminActionDate: Timestamp.now(),
      reviewedBy: admin.email || admin.uid
    });
    return res.status(200).json({ ok: true, orderId, paymentStatus: 'rejected' });
  }

  // ── Approve ───────────────────────────────────────────────────
  const patch = {
    paymentStatus: 'approved',
    status: 'approved',
    adminActionDate: Timestamp.now(),
    reviewedBy: admin.email || admin.uid
  };

  // Fixed allowlist of note fields only.
  const delivery = body.delivery;
  if (delivery && typeof delivery === 'object') {
    const channel = String(delivery.channel || '').toLowerCase();
    const to = String(delivery.to || '').trim().slice(0, 320);
    if ((channel === 'email' || channel === 'whatsapp') && to) {
      patch.sentVia = channel;
      patch.ticketsSentTo = to;
      patch.ticketsSentAt = Timestamp.now();
    }
  }
  if (body.approvedWithoutMessage === true) {
    patch.approvedWithoutMessage = true;
  }

  // Mark it paid first so the deduction is gated on a real status
  // transition. commitDeduction is idempotent on orderId, so a retry
  // after a network error cannot deduct twice.
  await ref.update(patch);

  const lines = linesFromOrder(order);
  if (lines.length === 0) {
    return res.status(400).json({
      error: 'Order contains no ticket quantities',
      code: 'NO_TICKET_LINES',
      paymentStatus: 'approved'
    });
  }

  try {
    const result = await commitDeduction({ orderId, lines, actor: admin.uid });
    return res.status(200).json({
      ok: true,
      orderId,
      paymentStatus: 'approved',
      alreadyProcessed: alreadyPaid && result.alreadyProcessed,
      ...result
    });
  } catch (err) {
    if (err instanceof SoldOutError || err.code === 'SOLD_OUT') {
      return res.status(err.status || 409).json({
        // The approval itself succeeded; only the stock move failed, so
        // the admin can resolve it without re-approving.
        error: err.message,
        code: 'SOLD_OUT',
        shortages: err.lines,
        orderId,
        paymentStatus: 'approved'
      });
    }
    throw err;
  }
};
/* ═══════════════════════════════════════════════════════════════
   POST /api/selar/webhook
   Selar payment callback → ticket inventory deduction.

   This route already existed in vercel.json but the handler was not in
   the repository; it is implemented here so the existing route resolves
   and, crucially, so a paid Selar order decrements stock exactly once.

   Requires the shared secret in the x-webhook-secret header.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const { commitDeduction, SoldOutError, normaliseTierKey } = require('../_lib/ticket-inventory');

/** Maps a Selar product title onto one of our tier keys. */
function tierFromTitle(title) {
  const t = String(title || '').toLowerCase();
  if (t.includes('founder')) return 'founders_inner_circle';
  if (t.includes('executive')) return 'executive';
  if (t.includes('growth')) return 'growth';
  if (t.includes('essential') || t.includes('general') || t.includes('regular')) {
    return 'essential';
  }
  return normaliseTierKey(title);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const expected = process.env.SELAR_WEBHOOK_SECRET;
  const presented = req.headers['x-webhook-secret'];
  if (!expected || presented !== expected) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }

  const body = req.body || {};
  const reference = String(
    body.reference || body.order_id || body.transaction_id || body.checkout_id || ''
  ).trim();

  if (!reference) {
    return res.status(400).json({ error: 'Missing payment reference' });
  }

  const status = String(body.status || body.payment_status || '').toLowerCase();
  if (status && !['paid', 'success', 'successful', 'complete', 'completed'].includes(status)) {
    // Failed / pending payments never move stock.
    return res.status(200).json({ ok: true, skipped: true, reason: 'payment_not_successful' });
  }

  const rawItems = body.items || body.products || body.order_items || [];
  const items = Array.isArray(rawItems) ? rawItems : [];

  const lines = [];
  for (const item of items) {
    const key = tierFromTitle(item.name || item.title || item.product_name || item.ticket_type);
    const qty = Number(item.quantity || item.qty || 1);
    if (key && Number.isInteger(qty) && qty > 0) lines.push({ key, qty });
  }

  if (lines.length === 0) {
    return res.status(400).json({ error: 'No recognised ticket lines in payload' });
  }

  try {
    const result = await commitDeduction({ orderId: reference, lines, actor: 'selar-webhook' });
    return res.status(200).json(result);
  } catch (err) {
    if (err instanceof SoldOutError || err.code === 'SOLD_OUT') {
      // Record it loudly but acknowledge, so the provider stops retrying.
      console.error('[selar-webhook] oversold for', reference, err.lines);
      return res.status(409).json({ error: err.message, code: 'SOLD_OUT', shortages: err.lines });
    }
    console.error('[selar-webhook] failed', err);
    return res.status(500).json({ error: 'Webhook processing failed' });
  }
};

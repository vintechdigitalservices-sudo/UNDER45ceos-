/* ═══════════════════════════════════════════════════════════════
   POST /api/tickets/claim
   Availability check for checkout. Does NOT reduce stock — it only
   reports whether the requested quantities are currently obtainable,
   so a sold-out tier can be rejected before the user pays anything.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const {
  readInventory,
  createClaim,
  releaseClaim,
  SoldOutError
} = require('../_lib/ticket-inventory');

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    // Convenience alias so the checkout page can do one call.
    try {
      return res.status(200).json({ tiers: await readInventory() });
    } catch (err) {
      console.error('[claim] read failed', err);
      return res.status(500).json({ error: 'Unable to read ticket inventory' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { action, claimId } = req.body || {};

  try {
    if (action === 'release') {
      await releaseClaim({ claimId });
      return res.status(200).json({ ok: true });
    }

    const { lines } = req.body || {};
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ error: 'lines is required' });
    }

    await createClaim({ orderId: String(req.body.orderId || ''), lines });
    return res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof SoldOutError || err.code === 'SOLD_OUT') {
      return res.status(409).json({
        error: err.message,
        code: 'SOLD_OUT',
        shortages: err.lines
      });
    }
    console.error('[claim] failed', err);
    return res.status(500).json({ error: 'Unable to check ticket availability' });
  }
};

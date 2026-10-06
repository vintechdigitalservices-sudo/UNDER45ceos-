/* ═══════════════════════════════════════════════════════════════
   GET /api/tickets/inventory
   Public read of live ticket availability. This is the ONLY source
   the ticket page uses for "N Tickets Left" / SOLD OUT. No secrets
   are exposed — remaining counts only.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const { readInventory } = require('../_lib/ticket-inventory');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const tiers = await readInventory();
    return res.status(200).json({
      tiers,
      // Convenience map for the frontend: { essential: 49, growth: 25, ... }
      remaining: tiers.reduce((acc, t) => {
        acc[t.key] = t.remainingQuantity;
        return acc;
      }, {}),
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    console.error('[inventory] read failed', err);
    return res.status(500).json({ error: 'Unable to read ticket inventory' });
  }
};

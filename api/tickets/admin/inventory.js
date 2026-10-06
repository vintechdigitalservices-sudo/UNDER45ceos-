/* ═══════════════════════════════════════════════════════════════
   POST /api/tickets/admin/inventory
   Admin-only inventory management. Requires a Firebase ID token for a
   user whose email is listed in the ADMIN_EMAILS env var.

   Body: { action: "set" | "restore", key?, remainingQuantity?, orderId? }
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const { requireAdmin } = require('../../_lib/firebase-admin');
const {
  readInventory,
  setRemaining,
  restoreDeduction,
  SoldOutError
} = require('../../_lib/ticket-inventory');

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    try {
      return res.status(200).json({ tiers: await readInventory() });
    } catch (err) {
      console.error('[admin/inventory] read failed', err);
      return res.status(500).json({ error: 'Unable to read ticket inventory' });
    }
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const admin = await requireAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Authentication required' });
  if (!admin.isAdmin) return res.status(403).json({ error: 'Admin access required' });

  const { action, key, remainingQuantity, orderId } = req.body || {};

  try {
    if (action === 'restore') {
      if (!orderId) return res.status(400).json({ error: 'orderId is required' });
      const result = await restoreDeduction({ orderId, actor: admin.uid });
      return res.status(200).json(result);
    }

    if (action === 'set') {
      if (remainingQuantity === undefined) {
        return res.status(400).json({ error: 'remainingQuantity is required' });
      }
      const result = await setRemaining({
        key,
        remainingQuantity,
        actor: admin.uid
      });
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    if (err instanceof SoldOutError) {
      return res.status(err.status || 409).json({ error: err.message });
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('[admin/inventory] failed', err);
    return res.status(500).json({ error: 'Inventory update failed' });
  }
};

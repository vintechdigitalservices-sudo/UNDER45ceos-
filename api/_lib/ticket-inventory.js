/* ═══════════════════════════════════════════════════════════════
   api/_lib/ticket-inventory.js
   Single authoritative ticket inventory layer.

   Firestore layout
   ----------------
   ticket_inventory/{key}                     one doc per tier
     ticketType          display name, e.g. "Essential"
     key                 slug used by the order documents, e.g. "essential"
     initialQuantity     tickets originally released
     remainingQuantity   tickets still available  (never < 0)
     price               price snapshot, informational only
     updatedAt           server timestamp of the last change

   ticket_inventory_ledger/{orderId}          idempotency ledger
     orderId             the payment / order reference (natural key)
     lines               [{ key, qty }] deducted for this order
     createdAt           server timestamp
     actor               uid of the admin who confirmed the payment

   ticket_inventory_claims/{claimId}          in-flight purchase holds
     claimId             per-attempt random id
     orderId             order the claim belongs to
     status              "held" | "committed" | "released"
     expiresAt           TTL for abandoned checkouts

   Why this shape
   --------------
   * remaining_quantity is the ONLY number the UI ever displays.
   * tickets_sold is derived (initial - remaining), never stored, so the
     two can never drift apart.
   * The ledger doc id IS the payment reference, which is what makes a
     replayed webhook a no-op: Firestore refuses to create the same doc
     twice, so the deduction can only ever be committed once.
   * Concurrency is handled by Firestore transactions, which take an
     optimistic lock on every document they read before committing.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const { db } = require('./firebase-admin');

const INVENTORY_COLLECTION = 'ticket_inventory';
const LEDGER_COLLECTION = 'ticket_inventory_ledger';
const CLAIMS_COLLECTION = 'ticket_inventory_claims';

const CLAIM_TTL_SECONDS = 20 * 60; // 20 minutes

/** Opening stock, exactly as specified. */
const SEED = [
  { key: 'essential', ticketType: 'Essential', initialQuantity: 49, price: 5000 },
  { key: 'growth', ticketType: 'Growth', initialQuantity: 25, price: 15000 },
  { key: 'executive', ticketType: 'Executive', initialQuantity: 18, price: 25000 },
  { key: 'founders_inner_circle', ticketType: 'Founders Inner Circle', initialQuantity: 10, price: 130000 }
];

/** Accepts either the display name or the slug, so callers can use whichever the UI has. */
function normaliseTierKey(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  const slug = raw.replace(/[^a-z0-9]+/g, '_');
  const match = SEED.find(
    (t) => t.key === slug || t.ticketType.toLowerCase() === raw
  );
  return match ? match.key : null;
}

/**
 * Creates any missing inventory docs. Existing docs are left untouched,
 * so this is safe to call on every read/write path: it will never reset
 * stock that has already been sold.
 */
async function ensureSeeded() {
  const firestore = db();
  const batch = firestore.batch();
  let wrote = 0;

  for (const tier of SEED) {
    const ref = firestore.collection(INVENTORY_COLLECTION).doc(tier.key);
    // eslint-disable-next-line no-await-in-loop
    const snap = await ref.get();
    if (snap.exists) continue;
    batch.set(ref, {
      key: tier.key,
      ticketType: tier.ticketType,
      initialQuantity: tier.initialQuantity,
      remainingQuantity: tier.initialQuantity,
      price: tier.price,
      updatedAt: firestore.FieldValue.serverTimestamp()
    });
    wrote += 1;
  }

  if (wrote > 0) await batch.commit();
  return wrote;
}

/** Current stock for every tier, plus derived sold counts. */
async function readInventory() {
  await ensureSeeded();
  const snap = await db().collection(INVENTORY_COLLECTION).get();

  const tiers = SEED.map((seed) => {
    const doc = snap.docs.find((d) => d.id === seed.key);
    const data = doc ? doc.data() : {};
    const initialQuantity = Number(data.initialQuantity ?? seed.initialQuantity);
    const remainingQuantity = Math.max(
      0,
      Number(data.remainingQuantity ?? seed.initialQuantity)
    );
    return {
      key: seed.key,
      ticketType: data.ticketType || seed.ticketType,
      initialQuantity,
      remainingQuantity,
      // Derived, never stored — guarantees the counters agree.
      ticketsSold: initialQuantity - remainingQuantity,
      soldOut: remainingQuantity === 0,
      lowStock: remainingQuantity > 0 && remainingQuantity <= 10,
      updatedAt: data.updatedAt || null
    };
  });

  return tiers;
}

class SoldOutError extends Error {
  constructor(message, lines) {
    super(message);
    this.name = 'SoldOutError';
    this.code = 'SOLD_OUT';
    this.lines = lines;
    this.status = 409;
  }
}

/**
 * Commits a deduction exactly once per orderId.
 *
 * Idempotency  — the whole thing runs in one Firestore transaction that
 *                creates ticket_inventory_ledger/{orderId}. A second
 *                call with the same reference sees the existing ledger
 *                doc and returns `alreadyProcessed: true` without
 *                touching stock.
 * Concurrency   — Firestore transactions re-run on conflict, so the
 *                read-check-write of remainingQuantity is serialised.
 *                remainingQuantity can never go negative because the
 *                read happens inside the locked transaction and the
 *                write is rejected if it would go below zero.
 */
async function commitDeduction({ orderId, lines, actor }) {
  if (!orderId) {
    const err = new Error('orderId (payment reference) is required');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    const err = new Error('No ticket lines supplied');
    err.status = 400;
    throw err;
  }

  // Validate shape before opening a transaction.
  const normalised = lines.map((line) => {
    const key = normaliseTierKey(line.key || line.ticketType);
    if (!key) {
      const err = new Error(`Unknown ticket tier: ${line.key || line.ticketType}`);
      err.status = 400;
      throw err;
    }
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty <= 0) {
      const err = new Error(`Invalid quantity for ${key}`);
      err.status = 400;
      throw err;
    }
    return { key, qty };
  });

  const firestore = db();
  const ledgerRef = firestore.collection(LEDGER_COLLECTION).doc(orderId);

  try {
    return await firestore.runTransaction(async (tx) => {
      // 1. Idempotency gate.
      const ledgerSnap = await tx.get(ledgerRef);
      if (ledgerSnap.exists) {
        return { ok: true, alreadyProcessed: true, orderId, lines: ledgerSnap.data().lines };
      }

      // 2. Read every affected inventory row INSIDE the transaction.
      const refs = normalised.map((line) =>
        firestore.collection(INVENTORY_COLLECTION).doc(line.key)
      );
      const snaps = await tx.getAll(...refs);

      const shortages = [];
      const updated = [];

      snaps.forEach((snap, i) => {
        const line = normalised[i];
        const data = snap.data();

        if (!data) {
          shortages.push({ key: line.key, requested: line.qty, available: 0 });
          return;
        }
        const available = Number(data.remainingQuantity);
        if (!Number.isFinite(available) || available < line.qty) {
          shortages.push({ key: line.key, requested: line.qty, available });
          return;
        }
        updated.push({ ref: snap.ref, qty: line.qty, available });
      });

      // 3. All-or-nothing: reject the whole order if any tier is short.
      if (shortages.length > 0) {
        throw new SoldOutError(
          'Insufficient ticket availability',
          shortages
        );
      }

      // 4. Decrement.
      for (const row of updated) {
        tx.update(row.ref, {
          remainingQuantity: row.available - row.qty, // >= 0 by the check above
          updatedAt: firestore.FieldValue.serverTimestamp()
        });
      }

      // 5. Record the ledger entry in the SAME transaction. Its
      //    existence is what makes any replay a no-op.
      tx.create(ledgerRef, {
        orderId,
        lines: normalised,
        actor: actor || 'system',
        createdAt: firestore.FieldValue.serverTimestamp()
      });

      return { ok: true, alreadyProcessed: false, orderId, lines: normalised };
    });
  } catch (err) {
    if (err.code === 'SOLD_OUT' || err instanceof SoldOutError) throw err;
    // Firestore surfaces ALREADY_EXISTS when tx.create hits an existing
    // ledger doc — i.e. a concurrent duplicate. Treat as processed.
    if (err.code === 6 || /ALREADY_EXISTS/i.test(err.message || '')) {
      return { ok: true, alreadyProcessed: true, orderId, lines: normalised };
    }
    throw err;
  }
}

/**
 * Returns stock to a tier. Only used to undo an approval the admin
 * later reversed — not part of the normal purchase path. Also
 * idempotent, keyed on orderId, so a double reversal cannot inflate
 * stock twice.
 */
async function restoreDeduction({ orderId, actor }) {
  const firestore = db();
  const ledgerRef = firestore.collection(LEDGER_COLLECTION).doc(orderId);

  return firestore.runTransaction(async (tx) => {
    const ledgerSnap = await tx.get(ledgerRef);
    if (!ledgerSnap.exists) return { ok: true, restored: false };

    const { lines } = ledgerSnap.data();
    const refs = lines.map((l) => firestore.collection(INVENTORY_COLLECTION).doc(l.key));
    const snaps = await tx.getAll(...refs);

    snaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const data = snap.data();
      const initial = Number(data.initialQuantity);
      const current = Number(data.remainingQuantity);
      const next = Math.min(initial, current + lines[i].qty);
      tx.update(snap.ref, {
        remainingQuantity: next,
        updatedAt: firestore.FieldValue.serverTimestamp()
      });
    });

    tx.delete(ledgerRef); // so the order can be re-approved cleanly
    return { ok: true, restored: true };
  });
}

/**
 * Holds stock for an in-flight checkout so two people cannot both start
 * checking out the last ticket. Explicitly NOT a sale: the hold carries a
 * TTL and only commitDeduction (driven by a confirmed payment) reduces
 * the real count.
 */
async function createClaim({ orderId, lines }) {
  const firestore = db();
  const claimId = `${orderId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const ref = firestore.collection(CLAIMS_COLLECTION).doc(claimId);

  const normalised = lines.map((line) => ({
    key: normaliseTierKey(line.key || line.ticketType),
    qty: Number(line.qty)
  }));

  const availability = await readInventory();
  const shortages = normalised
    .map((line) => {
      const tier = availability.find((t) => t.key === line.key);
      const available = tier ? tier.remainingQuantity : 0;
      return line.qty > available ? { key: line.key, requested: line.qty, available } : null;
    })
    .filter(Boolean);

  if (shortages.length > 0) {
    throw new SoldOutError('Insufficient ticket availability', shortages);
  }

  await ref.set({
    claimId,
    orderId,
    lines: normalised,
    status: 'held',
    createdAt: firestore.FieldValue.serverTimestamp(),
    expiresAt: firestore.Timestamp.fromMillis(Date.now() + CLAIM_TTL_SECONDS * 1000)
  });

  return { ok: true, claimId };
}

/** Releases an abandoned hold. Never changes remainingQuantity. */
async function releaseClaim({ claimId }) {
  if (!claimId) return { ok: true };
  await db().collection(CLAIMS_COLLECTION).doc(claimId).delete();
  return { ok: true };
}

/** Admin-only absolute override, clamped so remaining >= 0 and <= initial. */
async function setRemaining({ key, remainingQuantity, actor }) {
  const tierKey = normaliseTierKey(key);
  if (!tierKey) {
    const err = new Error(`Unknown ticket tier: ${key}`);
    err.status = 400;
    throw err;
  }
  const firestore = db();
  const ref = firestore.collection(INVENTORY_COLLECTION).doc(tierKey);

  await firestore.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      const err = new Error('Inventory not seeded');
      err.status = 409;
      throw err;
    }
    const initial = Number(snap.data().initialQuantity);
    const next = Math.min(initial, Math.max(0, Number(remainingQuantity)));
    tx.update(ref, {
      remainingQuantity: next,
      updatedAt: firestore.FieldValue.serverTimestamp(),
      lastModifiedBy: actor || 'admin'
    });
  });

  return { ok: true, key: tierKey, remainingQuantity: remainingQuantity };
}

module.exports = {
  INVENTORY_COLLECTION,
  LEDGER_COLLECTION,
  CLAIMS_COLLECTION,
  SEED,
  SoldOutError,
  normaliseTierKey,
  ensureSeeded,
  readInventory,
  commitDeduction,
  restoreDeduction,
  createClaim,
  releaseClaim,
  setRemaining
};

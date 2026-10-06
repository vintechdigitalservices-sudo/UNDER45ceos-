/* ═══════════════════════════════════════════════════════════════
   js/ticket-inventory-client.js
   Ticket inventory for the static Firebase site.

   WHY CLIENT-SIDE
   ---------------
   The Vercel serverless API needs a service-account credential that
   is not configured on this deployment, so /api/tickets/* cannot reach
   Firestore. The rest of the site already talks to Firestore straight
   from the browser (checkout writes the order that way), so inventory
   lives there too. The count is still shared, persistent and
   real-time — it is stored in Firestore, not in a browser variable.

   Firestore layout (same as the server layer)
   -------------------------------------------
   ticket_inventory/{key}              remainingQuantity is the count
   ticket_inventory_ledger/{orderId}   idempotency key, created once

   The ledger doc is what makes a repeated submission a no-op: the
   second call sees it and returns without touching stock.

   Exposed as window.U45InventoryClient (and as a CommonJS module so
   the behaviour can be unit-tested in Node).
   ═══════════════════════════════════════════════════════════════ */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.U45InventoryClient = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Opening stock, exactly as specified by the organiser.
  var SEED = [
    { key: 'essential', ticketType: 'Essential', initialQuantity: 49 },
    { key: 'growth', ticketType: 'Growth', initialQuantity: 25 },
    { key: 'executive', ticketType: 'Executive', initialQuantity: 18 },
    { key: 'founders_inner_circle', ticketType: 'Founders Inner Circle', initialQuantity: 10 }
  ];

  function seedFor(key) {
    for (var i = 0; i < SEED.length; i += 1) {
      if (SEED[i].key === key) return SEED[i];
    }
    return null;
  }

  function initialFor(key) {
    var seed = seedFor(key);
    return seed ? seed.initialQuantity : 0;
  }

  function titleFor(key) {
    var seed = seedFor(key);
    return seed ? seed.ticketType : key;
  }

  /** Accepts a display name ("Founders Inner Circle") or a slug. */
  function normaliseKey(value) {
    var raw = String(value || '').trim().toLowerCase();
    if (!raw) return null;
    var slug = raw.replace(/[^a-z0-9]+/g, '_');
    var match = null;
    SEED.forEach(function (t) {
      if (t.key === slug || t.ticketType.toLowerCase() === raw) match = t.key;
    });
    return match;
  }

  /**
   * Builds the display tiers from a plain { key: data } map. A missing
   * document falls back to the full opening stock, so the badge is
   * never blank before the first write.
   */
  function tiersFromDocs(docs) {
    var byKey = docs || {};
    return SEED.map(function (seed) {
      var data = byKey[seed.key] || {};
      var initial = Number(
        data.initialQuantity !== undefined && data.initialQuantity !== null
          ? data.initialQuantity
          : seed.initialQuantity
      );
      var remaining = Number(
        data.remainingQuantity !== undefined && data.remainingQuantity !== null
          ? data.remainingQuantity
          : initial
      );
      if (!isFinite(initial) || initial < 0) initial = seed.initialQuantity;
      if (!isFinite(remaining) || remaining < 0) remaining = 0;
      if (remaining > initial) remaining = initial;
      return {
        key: seed.key,
        ticketType: data.ticketType || seed.ticketType,
        initialQuantity: initial,
        remainingQuantity: remaining,
        ticketsSold: initial - remaining,
        soldOut: remaining === 0,
        lowStock: remaining > 0 && remaining <= 10
      };
    });
  }

  /** Normalises a cart object { tier: qty } into [{ key, qty }]. */
  function linesFromCart(cart) {
    var lines = [];
    Object.keys(cart || {}).forEach(function (tier) {
      var key = normaliseKey(tier);
      var qty = Number(cart[tier]);
      if (key && isFinite(qty) && qty > 0) lines.push({ key: key, qty: qty });
    });
    return lines;
  }

  /**
   * Deducts the cart from ticket_inventory, exactly once per orderId.
   *
   * Called the moment the checkout document is created — before any
   * payment or approval. Runs as one Firestore transaction, so the
   * ledger write and the decrement either both happen or neither does.
   *
   * @param {object} db          firebase.firestore() instance
   * @param {object} FieldValue  firebase.firestore.FieldValue
   * @param {string} orderId     the checkout order id
   * @param {object} cart        { tier: quantity }
   */
  function deductInventory(db, FieldValue, orderId, cart) {
    var lines = linesFromCart(cart);
    if (!orderId || lines.length === 0) {
      return Promise.resolve({ ok: false, reason: 'no_lines' });
    }

    var ledgerRef = db.collection('ticket_inventory_ledger').doc(orderId);
    var invRefs = lines.map(function (line) {
      return db.collection('ticket_inventory').doc(line.key);
    });

    return db.runTransaction(function (tx) {
      return tx.get(ledgerRef).then(function (ledgerSnap) {
        // Idempotency gate: already counted for this order.
        if (ledgerSnap.exists) {
          return { ok: true, alreadyProcessed: true, orderId: orderId, lines: lines };
        }

        // All reads must complete before any write.
        return Promise.all(invRefs.map(function (ref) { return tx.get(ref); }))
          .then(function (snaps) {
            var next = snaps.map(function (snap, i) {
              var data = snap.exists ? snap.data() : null;
              var initial = data ? Number(data.initialQuantity) : initialFor(lines[i].key);
              var remaining = data ? Number(data.remainingQuantity) : initial;
              if (!isFinite(remaining)) remaining = initial;
              return Math.max(0, remaining - lines[i].qty);
            });

            snaps.forEach(function (snap, i) {
              var serverTs = FieldValue.serverTimestamp();
              if (snap.exists) {
                tx.update(invRefs[i], {
                  remainingQuantity: next[i],
                  updatedAt: serverTs
                });
              } else {
                tx.set(invRefs[i], {
                  key: lines[i].key,
                  ticketType: titleFor(lines[i].key),
                  initialQuantity: initialFor(lines[i].key),
                  remainingQuantity: next[i],
                  updatedAt: serverTs
                });
              }
            });

            tx.set(ledgerRef, {
              orderId: orderId,
              lines: lines,
              actor: 'checkout',
              createdAt: FieldValue.serverTimestamp()
            });

            return { ok: true, alreadyProcessed: false, orderId: orderId, lines: lines };
          });
      });
    });
  }

  return {
    SEED: SEED,
    initialFor: initialFor,
    titleFor: titleFor,
    normaliseKey: normaliseKey,
    tiersFromDocs: tiersFromDocs,
    linesFromCart: linesFromCart,
    deductInventory: deductInventory
  };
});
/* ═══════════════════════════════════════════════════════════════
   Ticket availability — renders the live remaining count on each
   ticket card and drives the sold-out badge.

   Source of truth
   ---------------
   Firestore `ticket_inventory`, read straight from the browser via a
   real-time snapshot, so every open device updates the moment a
   checkout reduces a tier. The count is never stored or computed
   locally — window.U45InventoryClient just formats what Firestore
   holds (missing docs fall back to the opening stock).

   If the Firestore client is unavailable the module falls back to the
   /api/tickets/inventory endpoint, and if that also fails the cards
   show a neutral "Availability unavailable" note and stay fully
   purchasable — a backend outage must not look like a sold-out event.

   The badge is informational. A tier at zero shows SOLD OUT but the
   button is left alone; this module never disables a purchase.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var ENDPOINT = '/api/tickets/inventory';
  var POLL_MS = 30000;

  // Tier label -> inventory document key. Order-independent.
  var TIER_MAP = {
    'essential': 'essential',
    'growth': 'growth',
    'executive': 'executive',
    'founders inner circle': 'founders_inner_circle'
  };

  var LOW_STOCK = 5;

  var timer = null;
  var unsubscribe = null;
  var lastSeen = null;
  var counts = null;

  function clientLib() { return window.U45InventoryClient || null; }
  function firestoreDb() { return window.u45db || null; }

  function keyFor(tierName) {
    return TIER_MAP[String(tierName || '').trim().toLowerCase()] || null;
  }

  function stockHost(card) {
    var host = card.querySelector('[data-u45-stock]');
    if (!host) {
      var anchor = card.querySelector('.ticket-features-title');
      if (!anchor) return null;
      host = document.createElement('div');
      anchor.parentNode.insertBefore(host, anchor);
    }
    host.setAttribute('data-u45-stock', '');
    return host;
  }

  function plural(n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  function render(card, tier) {
    var host = stockHost(card);
    if (!host) return;

    var available = tier.remainingQuantity;

    if (tier.status === 'unavailable') {
      host.className = 'ticket-stock ticket-stock--unavailable';
      host.innerHTML = '<i>&#9888;</i> Availability unavailable';
      return;
    }

    if (available <= 0) {
      host.className = 'ticket-stock ticket-stock--soldout';
      host.innerHTML = '<i>&#10005;</i> SOLD OUT';
      card.classList.add('ticket-card--soldout');
      return;
    }

    card.classList.remove('ticket-card--soldout');
    var low = available <= LOW_STOCK;
    host.className = 'ticket-stock ' + (low ? 'ticket-stock--low' : 'ticket-stock--ok');
    host.innerHTML =
      '<i>&#9679;</i>' + plural(available, 'Ticket') + ' Left';
  }

  function paintTiers(tiers) {
    if (!Array.isArray(tiers)) return;

    counts = {};
    tiers.forEach(function (tier) { counts[tier.key] = tier.remainingQuantity; });

    var cards = document.querySelectorAll('.ticket-card[data-tier]');
    Array.prototype.forEach.call(cards, function (card) {
      var key = keyFor(card.dataset.tier);
      if (!key) return;
      var tier = null;
      tiers.forEach(function (t) { if (t.key === key) tier = t; });
      if (tier) render(card, tier);
    });

    lastSeen = new Date().toISOString();
    document.dispatchEvent(new CustomEvent('u45:inventory-updated', {
      detail: { tiers: tiers, remaining: counts, serverTime: lastSeen }
    }));
  }

  function markUnavailable() {
    document.querySelectorAll('.ticket-card').forEach(function (card) {
      var host = stockHost(card);
      if (!host) return;
      host.className = 'ticket-stock ticket-stock--unavailable';
      host.innerHTML = '<i>&#9888;</i> Availability unavailable';
    });
  }

  // ── Source A: Firestore real-time ─────────────────────────────
  function startRealtime() {
    var db = firestoreDb();
    var lib = clientLib();
    if (!db || !db.collection || !lib) return false;

    try {
      unsubscribe = db.collection('ticket_inventory').onSnapshot(
        function (snap) {
          var docs = {};
          snap.forEach(function (doc) { docs[doc.id] = doc.data(); });
          paintTiers(lib.tiersFromDocs(docs));
        },
        function (err) {
          console.warn('[ticket-availability] snapshot failed, falling back:', err && err.message);
          fetchOnce();
        }
      );
      return true;
    } catch (err) {
      console.warn('[ticket-availability] realtime unavailable:', err && err.message);
      return false;
    }
  }

  // ── Source B: API fallback ────────────────────────────────────
  function fetchOnce() {
    return fetch(ENDPOINT, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        paintTiers((payload && payload.tiers) || []);
        return payload;
      })
      .catch(function (err) {
        markUnavailable();
        console.warn('[ticket-availability] fetch failed:', err.message);
      });
  }

  function start() {
    stop();
    if (startRealtime()) return;
    // No Firestore handle: poll the API instead.
    fetchOnce();
    timer = window.setInterval(function () {
      if (!document.hidden) fetchOnce();
    }, POLL_MS);
  }

  function stop() {
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
    if (unsubscribe) {
      try { unsubscribe(); } catch (e) { /* ignore */ }
      unsubscribe = null;
    }
  }

  function init() {
    if (!document.querySelector('.ticket-card')) return;

    start();

    // Re-sync when the tab comes back, in case the snapshot had been
    // throttled while hidden.
    var onVisible = function () {
      if (document.hidden) return;
      if (unsubscribe) return; // real-time stays live on its own
      fetchOnce();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    window.addEventListener('online', onVisible);

    window.U45TicketAvailability = {
      refresh: fetchOnce,
      stop: stop,
      start: start,

      lastSeen: function () { return lastSeen; },
      counts: function () { return counts; },

      isSoldOut: function (tierName) {
        var key = keyFor(tierName);
        if (!key) return false;
        if (!counts || !(key in counts)) return false;
        return counts[key] <= 0;
      },

      maxSelectable: function (tierName) {
        var key = keyFor(tierName);
        if (!key || !counts || !(key in counts)) return null;
        return counts[key];
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
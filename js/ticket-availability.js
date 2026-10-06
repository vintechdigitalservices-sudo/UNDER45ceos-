/* ═══════════════════════════════════════════════════════════════
   Ticket availability — shows how many tickets are left in each tier
   on the public ticket page.

   How the number is worked out
   ----------------------------
   Every tier opens with a fixed allocation:

       Essential             49
       Growth                25
       Executive             18
       Founders Inner Circle 10

   A ticket is counted as taken the moment a checkout is submitted and
   its order document is written to the `checkouts` collection. This
   module reads that collection and subtracts the tickets it finds, so:

       remaining = opening - sum(quantity of submitted checkouts)

   Nothing else moves the number. Opening the page, picking a tier,
   paying, uploading a receipt or an admin approving the payment do NOT
   change it — only a new checkout document does.

   The count is read straight from Firestore with a real-time snapshot,
   so every open device updates the moment somebody else checks out.
   The opening figures are painted immediately on load, which means the
   page always shows real numbers and never an "unavailable" placeholder
   — if the snapshot cannot be reached it simply keeps the opening
   figures.

   The badge is informational. A tier at zero shows SOLD OUT but nothing
   here disables a purchase: the button stays live and checkout keeps its
   existing behaviour.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // Opening allocation per tier. System-generated — no admin input.
  var INITIAL = {
    essential: 49,
    growth: 25,
    executive: 18,
    founders_inner_circle: 10
  };

  var LOW_STOCK = 5;

  // Tier label on the card -> inventory key. Order-independent.
  var TIER_MAP = {
    'essential': 'essential',
    'growth': 'growth',
    'executive': 'executive',
    'founders inner circle': 'founders_inner_circle'
  };

  var unsubscribe = null;
  var lastSeen = null;
  var counts = null;

  function normaliseKey(name) {
    var key = String(name || '').trim().toLowerCase().replace(/\s+/g, '_');
    return (key in INITIAL) ? key : null;
  }

  function keyFor(tierName) {
    return TIER_MAP[String(tierName || '').trim().toLowerCase()] ||
           normaliseKey(tierName);
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

  function render(card, remaining) {
    var host = stockHost(card);
    if (!host) return;

    if (remaining <= 0) {
      host.className = 'ticket-stock ticket-stock--soldout';
      host.innerHTML = '<i>&#10005;</i> SOLD OUT';
      card.classList.add('ticket-card--soldout');
      return;
    }

    card.classList.remove('ticket-card--soldout');
    var low = remaining <= LOW_STOCK;
    host.className = 'ticket-stock ' + (low ? 'ticket-stock--low' : 'ticket-stock--ok');
    host.innerHTML = '<i>&#9679;</i>' + plural(remaining, 'Ticket') + ' Left';
  }

  // remaining (key -> number) painted onto every card.
  function paint(remaining) {
    counts = {};
    Object.keys(INITIAL).forEach(function (key) {
      counts[key] = (key in remaining) ? remaining[key] : INITIAL[key];
    });

    var cards = document.querySelectorAll('.ticket-card[data-tier]');
    Array.prototype.forEach.call(cards, function (card) {
      var key = keyFor(card.dataset.tier);
      if (!key) return;
      render(card, counts[key]);
    });

    lastSeen = new Date().toISOString();
    document.dispatchEvent(new CustomEvent('u45:inventory-updated', {
      detail: { remaining: counts, serverTime: lastSeen }
    }));
  }

  // Turn the checkouts snapshot into remaining counts.
  function remainingFromSnapshot(snap) {
    var sold = {};
    Object.keys(INITIAL).forEach(function (key) { sold[key] = 0; });

    snap.forEach(function (doc) {
      var data = doc.data() || {};
      var tickets = data.tickets;
      if (!tickets || typeof tickets !== 'object') return;
      Object.keys(tickets).forEach(function (name) {
        var key = normaliseKey(name);
        if (!key) return;
        var qty = Number(tickets[name]);
        if (!isFinite(qty) || qty <= 0) return;
        sold[key] += qty;
      });
    });

    var remaining = {};
    Object.keys(INITIAL).forEach(function (key) {
      remaining[key] = Math.max(0, INITIAL[key] - sold[key]);
    });
    return remaining;
  }

  function startRealtime() {
    var db = window.u45db;
    if (!db || !db.collection) return false;

    try {
      unsubscribe = db.collection('checkouts').onSnapshot(
        function (snap) { paint(remainingFromSnapshot(snap)); },
        function (err) {
          // Keep the opening figures rather than showing an error state.
          console.warn('[ticket-availability] snapshot failed:', err && err.message);
        }
      );
      return true;
    } catch (err) {
      console.warn('[ticket-availability] realtime unavailable:', err && err.message);
      return false;
    }
  }

  function start() {
    stop();
    // Show real numbers straight away, before the network answers.
    paint({});
    startRealtime();
  }

  function stop() {
    if (unsubscribe) {
      try { unsubscribe(); } catch (e) { /* ignore */ }
      unsubscribe = null;
    }
  }

  function init() {
    if (!document.querySelector('.ticket-card')) return;

    start();

    window.U45TicketAvailability = {
      refresh: function () { paint(counts || {}); return counts; },
      stop: stop,
      start: start,

      lastSeen: function () { return lastSeen; },
      counts: function () { return counts; },

      isSoldOut: function (tierName) {
        var key = keyFor(tierName);
        if (!key || !counts || !(key in counts)) return false;
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
/* ═══════════════════════════════════════════════════════════════
   Ticket availability — renders the live remaining count on each
   ticket card and drives the sold-out state.

   The numbers on screen are never computed here. Every figure comes
   from GET /api/tickets/inventory, which reads Firestore. There is no
   local counter, and nothing is written to localStorage or
   sessionStorage — a user editing storage cannot change what is shown,
   and the backend revalidates availability before any deduction.

   Refresh triggers: initial load, pageshow (bfcache restore), tab
   focus, visibilitychange, and a 30 s poll while the page is visible.

   Depends on /api/tickets/inventory being live. If the endpoint is
   unreachable the cards show a neutral "Availability unavailable"
   note and stay fully purchasable — a backend outage must not look
   like a sold-out event.
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

  // At or below this, the count is emphasised. Below LOW_STOCK the
  // card is marked low; at or below this the tier is effectively gone.
  var LOW_STOCK = 5;

  var timer = null;
  var lastSeen = null;
  // Last figures received from the backend, keyed by tier. Purely a
  // mirror of the last server response.
  var counts = null;

  function keyFor(tierName) {
    return TIER_MAP[String(tierName || '').trim().toLowerCase()] || null;
  }

  function stockHost(card) {
    var host = card.querySelector('[data-u45-stock]');
    if (!host) {
      // Fallback: inject above the INCLUDES heading so the component
      // still works on a card that predates the placeholder.
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

    var btn = card.querySelector('.js-get-ticket');
    var available = tier.remainingQuantity;

    // ── Loading / unavailable ────────────────────────────────────
    if (tier.status === 'unavailable') {
      host.className = 'ticket-stock ticket-stock--unavailable';
      host.innerHTML = '<i>&#9888;</i> Availability unavailable &mdash; check before buying';
      // Do NOT disable: an unreachable backend is not a sold-out tier.
      return;
    }

    // ── Sold out ─────────────────────────────────────────────────
    // Informational only. The count reaching zero must NOT disable or
    // block the purchase path, so the button is left exactly as it was
    // and the tier stays fully clickable — the badge is what changes.
    if (available <= 0) {
      host.className = 'ticket-stock ticket-stock--soldout';
      host.innerHTML = '<i>&#10005;</i> SOLD OUT';
      card.classList.add('ticket-card--soldout');
      return;
    }

    // ── In stock ─────────────────────────────────────────────────
    card.classList.remove('ticket-card--soldout');
    var low = available <= LOW_STOCK;
    host.className = 'ticket-stock ' + (low ? 'ticket-stock--low' : 'ticket-stock--ok');
    host.innerHTML =
      '<i>' + (low ? '&#9679;' : '&#9679;') + '</i>' + plural(available, 'Ticket') + ' Left';

    if (btn) {
      // Clear any legacy disabled state left by an older build, so a
      // tier that was once sold out is never left un-clickable.
      btn.removeAttribute('aria-disabled');
      btn.classList.remove('ticket-btn--disabled');
      btn.removeAttribute('title');
      btn.setAttribute('href', btn.dataset.selar || btn.getAttribute('href') || '#');
    }
  }

  function paint(payload) {
    var remaining = (payload && payload.remaining) || {};
    var tiers = (payload && payload.tiers) || [];

    // Mirror the server response. Nothing is derived or incremented.
    counts = Object.assign({}, remaining);

    tiers.forEach(function (tier) {
      var cards = document.querySelectorAll(
        '.ticket-card[data-tier="' + tier.key + '"],' +
        '.ticket-card[data-tier="' + (tier.ticketType || '') + '"]'
      );
      Array.prototype.forEach.call(cards, function (card) {
        if (keyFor(card.dataset.tier) !== tier.key) return;
        render(card, tier);
      });
    });

    // A tier the backend did not mention is not proof of zero stock, so
    // only mark cards explicitly reported as sold out.
    lastSeen = payload && payload.serverTime ? payload.serverTime : new Date().toISOString();
    document.dispatchEvent(new CustomEvent('u45:inventory-updated', {
      detail: { tiers, remaining, serverTime: lastSeen }
    }));
  }

  function fetchOnce() {
    return fetch(ENDPOINT, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (payload) {
        paint(payload);
        return payload;
      })
      .catch(function (err) {
        // Network or server failure: mark availability unknown rather
        // than silently leaving stale numbers on screen.
        document.querySelectorAll('.ticket-card').forEach(function (card) {
          var host = stockHost(card);
          if (!host) return;
          host.className = 'ticket-stock ticket-stock--unavailable';
          host.innerHTML = '<i>&#9888;</i> Availability unavailable &mdash; check before buying';
        });
        console.warn('[ticket-availability] fetch failed:', err.message);
      });
  }

  function refresh() {
    // Pause polling while the tab is hidden; resync on return.
    if (document.hidden) return Promise.resolve();
    return fetchOnce();
  }

  function start() {
    stop();
    refresh();
    timer = window.setInterval(refresh, POLL_MS);
  }

  function stop() {
    if (timer) {
      window.clearInterval(timer);
      timer = null;
    }
  }

  function init() {
    if (!document.querySelector('.ticket-card')) return;

    start();

    var onVisible = function () {
      if (!document.hidden) fetchOnce();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onVisible);

    window.U45TicketAvailability = {
      refresh: fetchOnce,
      stop: stop,
      start: start,

      // Latest figures from the backend, keyed by tier. This is a
      // read-only cache of the last server response — never a counter
      // that the page increments.
      lastSeen: function () { return lastSeen; },
      counts: function () { return counts; },

      isSoldOut: function (tierName) {
        var key = keyFor(tierName);
        if (!key) return false;
        // Unknown tier or no data yet: allow, so a failed fetch can
        // never masquerade as sold out.
        if (!counts || !(key in counts)) return false;
        return counts[key] <= 0;
      },

      // Keeps the drawer quantity stepper within the remaining stock.
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
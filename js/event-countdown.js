/* ═══════════════════════════════════════════════════════════════
   UNDER 45 CEOs — Sticky Event Countdown Banner

   A single self-injecting component. It builds its own <link> and
   appends a fixed-position banner to <body>, so no page needs any
   markup beyond:

       <script src="/js/event-countdown.js" defer></script>

   BEHAVIOUR
   ---------
   • Slides down over the top of the viewport once the page is scrolled
     past the hero, and stays there covering the site header until the
     ✕ is pressed. On pages with no hero it is visible immediately.
   • ✕ dismisses it with an animated slide-up, for the rest of the
     session.
   • Colours come from the site's own design tokens (--orange, --teal,
     --nav-bg, --text…), so it is automatically on-brand in both the
     dark and the light theme. No colours are hardcoded.
   • z-index is 30000, above every header on the site (.nav is 999,
     .site-header 1000), so it genuinely covers the header rather
     than sitting under it.

   HOST PAGE HOOKS (all optional)
   ------------------------------
   data attributes on <body> or <html>:
     data-cd-no-hero      always show immediately (no hero to clear)
     data-cd-hide-text    hide the descriptive sentence
     data-cd-cta          CTA label           (default "Get Tickets")
     data-cd-href         CTA target          (default "/ticket")
     data-cd-title        label before digits (default "Starts in")

   SIZING CONTRACT
   ---------------
   The banner's height is a fixed CSS variable (--u45-cd-h: 76px,
   64px under 640px), never content-derived, so it can never change the
   layout of the page it covers.
   ═══════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  // ── Fixed event configuration ──────────────────────────────────
  // 2026-10-10T09:00:00+01:00 === 08:00 UTC. Africa/Lagos is UTC+1
  // year-round (no daylight saving), so this offset never shifts.
  var EVENT_ISO = '2026-10-10T09:00:00+01:00';
  var WAT_OFFSET_MINUTES = 60;

  var SECOND = 1000;
  var MINUTE = 60 * SECOND;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;

  var EVENT_START_MS = Date.parse(EVENT_ISO);

  var CSS_HREF = '/js/event-countdown.css';
  var SESSION_KEY = 'u45cd-dismissed';

  var DEFAULTS = {
    title: 'The Summit Starts In',
    cta: 'Get Tickets',
    href: '/ticket',
    accent: 'orange'
  };

  // ── Small helpers ──────────────────────────────────────────────

  function flag(name) {
    var el = document.body || document.documentElement;
    return el.hasAttribute(name);
  }

  function setting(name) {
    var el = document.body || document.documentElement;
    return el.getAttribute(name);
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // Current wall-clock time in Africa/Lagos as a "shifted UTC" Date.
  function nowInWat() {
    return new Date(Date.now() + WAT_OFFSET_MINUTES * MINUTE);
  }

  function startOfWatDay(watDate) {
    return Date.UTC(
      watDate.getUTCFullYear(),
      watDate.getUTCMonth(),
      watDate.getUTCDate()
    ) - WAT_OFFSET_MINUTES * MINUTE;
  }

  // Whole calendar days from today's WAT midnight to the event's WAT
  // midnight. Positive before the day, 0 on the day, negative after.
  // Drives the EVENT DAY framing only — never the digits.
  function calendarDaysRemaining(nowWat) {
    // Accepts a WAT-shifted Date or a raw epoch-ms value, so callers
    // and tests can pass whichever they have without the two shapes
    // silently disagreeing.
    var d = nowWat instanceof Date ? nowWat : new Date(nowWat);
    var eventDayStart = startOfWatDay(new Date(EVENT_START_MS));
    var todayStart = startOfWatDay(d);
    return Math.round((eventDayStart - todayStart) / DAY);
  }

  // Splits a duration into d/h/m/s that ALWAYS sum back to it. Every
  // digit derives from the same millisecond value, so the display can
  // never claim more time than actually remains.
  function splitDuration(ms) {
    var totalSeconds = Math.floor(ms / SECOND);
    return {
      days: Math.floor(totalSeconds / 86400),
      hours: Math.floor(totalSeconds / 3600) % 24,
      minutes: Math.floor(totalSeconds / 60) % 60,
      seconds: totalSeconds % 60
    };
  }

  // ── Stylesheet ─────────────────────────────────────────────────

  var styleReady = false;

  function ensureStylesheet() {
    if (styleReady) return;
    styleReady = true;
    if (document.querySelector('link[data-u45-countdown-css]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = CSS_HREF;
    link.setAttribute('data-u45-countdown-css', '');
    document.head.appendChild(link);
  }

  // ── Build ──────────────────────────────────────────────────────

  var UNITS = ['days', 'hours', 'minutes', 'seconds'];
  var SHORT = { days: 'Days', hours: 'Hrs', minutes: 'Min', seconds: 'Sec' };

  // ── Hero detection ──────────────────────────────────────────────
  // The banner waits until the hero scrolls away. Detection is
  // structural, so new pages work without editing this file. A
  // candidate only counts if it is actually tall enough to be a
  // hero — otherwise a short lead-in section would delay the banner
  // for no reason.
  var HERO_SELECTOR =
    '.hero, .hero-section, .hero-wrapper, [data-hero], #hero, header.hero';

  // Below this height an element is not treated as a hero.
  var HERO_MIN_PX = 260;

  function findHero() {
    var candidates = document.querySelectorAll(HERO_SELECTOR);
    for (var i = 0; i < candidates.length; i++) {
      var rect = candidates[i].getBoundingClientRect();
      if (rect.height >= HERO_MIN_PX) return candidates[i];
    }
    return null;
  }

  function build() {
    var config = {
      title: setting('data-cd-title') || DEFAULTS.title,
      cta: setting('data-cd-cta') || DEFAULTS.cta,
      href: setting('data-cd-href') || DEFAULTS.href,
      showText: !flag('data-cd-hide-text')
    };

    var root = document.createElement('div');
    root.className = 'u45-cd';
    root.setAttribute('data-u45-countdown', '');
    root.setAttribute('role', 'region');
    root.setAttribute('aria-label', 'Event countdown');

    var inner = document.createElement('div');
    inner.className = 'u45-cd__inner';

    // Label + pulse
    var label = document.createElement('div');
    label.className = 'u45-cd__label';
    var pulse = document.createElement('span');
    pulse.className = 'u45-cd__pulse';
    var labelText = document.createElement('span');
    label.appendChild(pulse);
    label.appendChild(labelText);
    inner.appendChild(label);

    // Digits
    var digits = document.createElement('div');
    digits.className = 'u45-cd__digits';
    digits.setAttribute('role', 'timer');
    digits.setAttribute('aria-live', 'off');
    digits.setAttribute('aria-label', 'Time remaining until the summit');

    UNITS.forEach(function (unit, i) {
      if (i > 0) {
        var sep = document.createElement('span');
        sep.className = 'u45-cd__sep';
        sep.textContent = ':';
        digits.appendChild(sep);
      }
      var block = document.createElement('div');
      block.className = 'u45-cd__unit u45-cd__unit--' + unit;

      var value = document.createElement('span');
      value.className = 'u45-cd__value';
      value.setAttribute('data-u45-unit', unit);
      value.textContent = '00';

      var sm = document.createElement('span');
      sm.className = 'u45-cd__label-sm';
      sm.textContent = SHORT[unit];

      block.appendChild(value);
      block.appendChild(sm);
      digits.appendChild(block);
    });
    inner.appendChild(digits);

    // Descriptive text
    var text = document.createElement('p');
    text.className = 'u45-cd__text';
    text.innerHTML =
      'October 10, 2026 &middot; Youth Development Centre, Onitsha';
    if (!config.showText) text.style.display = 'none';
    inner.appendChild(text);

    // CTA
    var cta = document.createElement('a');
    cta.className = 'u45-cd__cta';
    cta.href = config.href;
    cta.textContent = config.cta;
    inner.appendChild(cta);

    // Close button (animated ✕)
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'u45-cd__close';
    close.setAttribute('aria-label', 'Dismiss countdown banner');
    close.innerHTML =
      '<svg viewBox="0 0 14 14" aria-hidden="true">' +
      '<path d="M1.5 1.5 L12.5 12.5"/>' +
      '<path d="M12.5 1.5 L1.5 12.5"/>' +
      '</svg>';
    inner.appendChild(close);

    root.appendChild(inner);

    // ---- behaviour -----------------------------------------------

    var timer = null;
    var rafId = null;
    var onResize = null;
    // Honour a dismissal earlier in the same session (SPA-style nav).
    // Read BEFORE anything is built or mounted, so a dismissed banner is
    // never appended-then-immediately-removed (which used to leave a
    // queued animation frame free to run show() on a detached node).
    var dismissed = false;
    try {
      dismissed = sessionStorage.getItem(SESSION_KEY) === '1';
    } catch (e) {
      /* private mode — dismissal is simply not persisted */
    }

    function setText(node, value) {
      if (node && node.textContent !== value) node.textContent = value;
    }

    function render() {
      var remaining = EVENT_START_MS - Date.now();

      // ── Live ───────────────────────────────────────────────────
      if (remaining <= 0) {
        root.classList.add('u45-cd--live');
        digits.hidden = true;
        text.hidden = true;
        cta.hidden = true;
        setText(labelText, 'The Summit Is Live');
        if (labelText.textContent !== 'The Summit Is Live') {
          labelText.className = 'u45-cd__live';
        }
        return;
      }

      var calDay = calendarDaysRemaining(nowInWat());
      var t = splitDuration(remaining);

      setText(digits.querySelector('[data-u45-unit="days"]'), pad(t.days));
      setText(digits.querySelector('[data-u45-unit="hours"]'), pad(t.hours));
      setText(digits.querySelector('[data-u45-unit="minutes"]'), pad(t.minutes));
      setText(digits.querySelector('[data-u45-unit="seconds"]'), pad(t.seconds));

      if (calDay <= 0) {
        // Event day: keep the clock running to the 09:00 start.
        setText(labelText, 'Event Day');
      } else {
        var phrase;
        if (t.days > 0) {
          phrase = t.days === 1 ? '1 Day Remaining' : t.days + ' Days Remaining';
        } else if (t.hours > 0) {
          phrase = t.hours === 1 ? '1 Hour Remaining' : t.hours + ' Hours Remaining';
        } else {
          phrase = 'Doors Open Soon';
        }
        setText(labelText, config.title + ' · ' + phrase);
      }
    }

    function show() {
      if (dismissed || root.classList.contains('is-visible')) return;
      root.classList.add('is-visible');
      publishHeight();
    }

    function hide() {
      if (root.classList.contains('is-visible')) {
        root.classList.remove('is-visible');
      }
    }

    // Publishes the banner height so a host page can read it if it ever
    // needs to. The banner overlays the header rather than pushing it,
    // so nothing on this site depends on the value — it is published
    // for inspection and for pages that add their own offset.
    function publishHeight() {
      var rect = inner.getBoundingClientRect();
      if (!rect.height) return;
      document.documentElement.style.setProperty(
        '--u45-cd-h',
        Math.round(rect.height) + 'px'
      );
    }

    function onScroll() {
      if (alwaysShow) {
        show();
        return;
      }
      if (window.scrollY >= revealAt) show();
      else hide();
    }

    close.addEventListener('click', function () {
      dismissed = true;
      root.classList.add('is-dismissing');
      try {
        sessionStorage.setItem(SESSION_KEY, '1');
      } catch (e) {
        /* private mode — dismissal is simply not persisted */
      }
      window.setTimeout(function () {
        root.classList.add('is-dismissed');
        root.remove();
        stop();
      }, 280);
    });

    // ---- hero detection ------------------------------------------
    // "Slide down once the page is scrolled" — on a page with a hero
    // that means the banner waits until the hero is gone. We detect it
    // structurally rather than by page name, so new pages work too.
    var hero = findHero();

    // Pages without a hero, or opted out, show the banner immediately.
    var alwaysShow = flag('data-cd-no-hero') || !hero;

    // A dismissed banner is not mounted at all.
    if (dismissed) {
      root.classList.add('is-dismissed');
      return;
    }

    // Reveal once the hero has scrolled out of view.
    var revealAt = 0;
    if (hero && !alwaysShow) {
      onResize = function () {
        // Trigger a little after the hero's bottom leaves the top edge,
        // so the banner never overlaps the headline on first paint.
        revealAt = Math.max(0, hero.getBoundingClientRect().height - 24);
      };
      onResize();
      window.addEventListener('resize', onResize);
    }

    // ---- mount ----------------------------------------------------
    document.body.appendChild(root);
    publishHeight();
    render();

    timer = window.setInterval(render, 1000);

    // Resync after bfcache restore, tab wake-up, and midnight rollover.
    var onVisible = function () {
      if (!document.hidden) render();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('scroll', onScroll, { passive: true });

    // Only start listening for scroll once the DOM height is meaningful.
    rafId = window.requestAnimationFrame(onScroll);

    function stop() {
      window.clearInterval(timer);
      timer = null;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (onResize) {
        window.removeEventListener('resize', onResize);
        onResize = null;
      }
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('scroll', onScroll);
    }

    root.__u45CountdownStop = stop;
  }

  // ── Init ───────────────────────────────────────────────────────

  function init() {
    if (document.querySelector('[data-u45-countdown]')) return;
    ensureStylesheet();
    build();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.U45EventCountdown = {
    init: init,
    EVENT_ISO: EVENT_ISO,
    calendarDaysRemaining: calendarDaysRemaining,
    splitDuration: splitDuration
  };
})();
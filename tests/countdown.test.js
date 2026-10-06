/* ═══════════════════════════════════════════════════════════════
   Countdown logic tests.
   Checks the fixed event target, that the digits are strictly
   additive at every hour of the day, the midnight rollover, the
   event-day / live states, and that nothing is persisted.

   Run with:  node tests/countdown.test.js
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'event-countdown.js'),
  'utf8'
);

function makeSandbox() {
  const sandbox = {
    window: {
      setInterval: () => 1,
      clearInterval: () => {},
      addEventListener: () => {},
      U45EventCountdown: null
    },
    document: {
      // 'loading' so the component registers its DOMContentLoaded hook
      // instead of building against this stub. The pure helpers are
      // still exported and are what these tests exercise.
      readyState: 'loading',
      hidden: false,
      head: { appendChild: () => {} },
      body: { appendChild: () => {}, remove: () => {}, hasAttribute: () => false, getAttribute: () => null, style: { setProperty: () => {} } },
      documentElement: { classList: { add: () => {} }, style: { setProperty: () => {} } },
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: () => ({
        className: '', textContent: '', innerHTML: '', href: '', type: '',
        style: { setProperty: () => {} },
        classList: { add: () => {}, remove: () => {}, contains: () => false },
        dataset: {},
        hidden: false,
        setAttribute: () => {},
        appendChild: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        getBoundingClientRect: () => ({ height: 0, top: 0 })
      }),
      createDocumentFragment: () => ({ appendChild: () => {} }),
      querySelector: () => null,
      querySelectorAll: () => []
    },
    console, Date, Math, String, Number, Object, Array,
    setInterval: () => 1,
    clearInterval: () => {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

const api = makeSandbox().window.U45EventCountdown;
const EVENT_START_MS = Date.parse(api.EVENT_ISO);
const DAY = 86400000;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  \u2713 ' + name);
  } catch (err) {
    failed += 1;
    console.log('  \u2717 ' + name + '\n      ' + err.message);
  }
}

console.log('\nCountdown — target and decomposition\n');

test('Event target is the fixed instant 2026-10-10T09:00:00+01:00', () => {
  assert.strictEqual(api.EVENT_ISO, '2026-10-10T09:00:00+01:00');
  assert.strictEqual(EVENT_START_MS, Date.parse('2026-10-10T08:00:00Z'));
});

test('splitDuration sums back to the exact duration it was given', () => {
  const samples = [
    4 * DAY + 5 * 3600000 + 4 * 60000 + 41000,
    1, 999, 60000, 3600000, DAY - 1, 123456789
  ];
  for (const ms of samples) {
    const t = api.splitDuration(ms);
    const rebuilt =
      t.days * DAY + t.hours * 3600000 + t.minutes * 60000 + t.seconds * 1000;
    assert.ok(rebuilt <= ms, 'rebuilt duration must not exceed the original');
    assert.ok(ms - rebuilt < 1000, 'sub-second truncation only');
  }
});

test('Digits are additive at EVERY hour of the day, not just 3am', () => {
  // Regression guard for the bug where calendar days were paired with
  // a 24h clock, so "4 D 13 H" was shown while only 3d13h remained.
  const probeHours = [
    '2026-10-06T03:55:00+01:00',
    '2026-10-06T20:00:00+01:00',
    '2026-10-07T10:00:00+01:00',
    '2026-10-08T23:59:00+01:00',
    '2026-10-09T10:00:00+01:00',
    '2026-10-10T00:30:00+01:00'
  ];
  for (const iso of probeHours) {
    const remaining = EVENT_START_MS - Date.parse(iso);
    const t = api.splitDuration(remaining);
    const rebuilt =
      t.days * DAY + t.hours * 3600000 + t.minutes * 60000 + t.seconds * 1000;
    assert.ok(
      remaining - rebuilt < 1000,
      iso + ': shown d/h/m/s must reconstruct the real remaining time'
    );
    // And the day figure must not exceed the true whole days left.
    assert.ok(
      t.days <= Math.floor(remaining / DAY),
      iso + ': day figure must never overstate the true remaining days'
    );
  }
});

test('Verified against the real clock at authoring time (4d 5h at 03:55 Oct 6)', () => {
  // The value the user saw in the browser.
  const at = Date.parse('2026-10-06T03:55:00+01:00');
  const t = api.splitDuration(EVENT_START_MS - at);
  // Field-by-field: the object comes from a vm realm, so deepStrictEqual
  // would fail on prototype identity rather than on values.
  assert.strictEqual(t.days, 4);
  assert.strictEqual(t.hours, 5);
  assert.strictEqual(t.minutes, 5);
  assert.strictEqual(t.seconds, 0);
});

console.log('\nCountdown — calendar framing\n');

test('Oct 6 -> 4 calendar days remaining', () => {
  assert.strictEqual(api.calendarDaysRemaining(new Date(Date.parse('2026-10-05T23:00:00Z') + 3600000)), 4);
});

test('Oct 9 late evening WAT still counts as 1 calendar day', () => {
  assert.strictEqual(api.calendarDaysRemaining(new Date(Date.parse('2026-10-09T22:30:00Z') + 3600000)), 1);
});

test('WAT midnight rollover steps the calendar day down exactly at 00:00', () => {
  assert.strictEqual(api.calendarDaysRemaining(new Date(Date.parse('2026-10-05T22:59:59Z') + 3600000)), 5);
  assert.strictEqual(api.calendarDaysRemaining(new Date(Date.parse('2026-10-06T00:00:00Z') + 3600000)), 4);
});

test('Oct 10 before 09:00 is event day (0), the next day is negative', () => {
  // 00:30 WAT Oct 10 -> still the event day.
  assert.strictEqual(api.calendarDaysRemaining(new Date(Date.parse('2026-10-09T23:30:00Z') + 3600000)), 0);
  // 09:00 WAT Oct 10 is the start instant; the calendar count only turns
  // negative once the following midnight begins.
  assert.strictEqual(api.calendarDaysRemaining(new Date(Date.parse('2026-10-10T08:00:00Z') + 3600000)), 0);
  assert.strictEqual(api.calendarDaysRemaining(new Date(Date.parse('2026-10-10T23:00:00Z') + 3600000)), -1);
});

test('On event day the clock still counts the hours to 09:00', () => {
  const t = api.splitDuration(EVENT_START_MS - Date.parse('2026-10-09T23:30:00Z'));
  assert.strictEqual(t.days, 0);
  assert.strictEqual(t.hours, 8);
});

console.log('\nCountdown — component contract\n');

test('Reads Date.now() on every tick; persists nothing', () => {
  const tickBody = src.slice(src.indexOf('function render('), src.indexOf('function show('));
  assert.ok(/Date\.now\(\)/.test(tickBody), 'render() must recompute from Date.now()');
  const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(
    !/localStorage|document\.cookie/.test(codeOnly),
    'countdown must not persist any value'
  );
});

test('Only sessionStorage is used, and only for the dismissal flag', () => {
  const hits = [...src.matchAll(/sessionStorage\.\w+/g)].map((m) => m[0]);
  assert.ok(hits.length > 0, 'dismissal should be remembered for the session');
  assert.ok(
    hits.every((h) => h.startsWith('sessionStorage.getItem') || h.startsWith('sessionStorage.setItem')),
    'sessionStorage must only be read/written for dismissal'
  );
});

test('Timer is cleaned up on teardown', () => {
  assert.ok(/clearInterval/.test(src), 'stop() must clear the interval');
  assert.ok(/removeEventListener/.test(src), 'stop() must remove listeners');
  assert.ok(/passive: true/.test(src), 'scroll listener must be passive');
});

test('Ticks every 1000ms', () => {
  assert.ok(/setInterval\(render, 1000\)/.test(src), 'must tick every second');
});

test('Never renders a negative or partial countdown', () => {
  assert.ok(/if \(remaining <= 0\)/.test(src), 'must branch on the target being reached');
  assert.ok(/Event Day/.test(src), 'event-day state exists');
  assert.ok(/The Summit Is Live/.test(src), 'live state exists');
  assert.ok(!/'-'|negative/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').split('function render')[1].split('function show')[0] || ''), 'no negative clamping needed in render');
});

test('Banner has an animated dismiss control', () => {
  assert.ok(/u45-cd__close/.test(src), 'close button must exist');
  assert.ok(/is-dismissing/.test(src), 'dismissal must animate');
  assert.ok(/stroke-dasharray/.test(fs.readFileSync(path.join(__dirname, '..', 'js', 'event-countdown.css'), 'utf8')), 'close icon must be an animated stroke');
});

// A session dismissal must prevent the banner from being built at all,
// and the teardown must release every listener and frame it scheduled.
test('Dismissed sessions never mount, and teardown leaks nothing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'event-countdown.js'), 'utf8');

  // The session read has to happen before the banner is appended,
  // otherwise a queued requestAnimationFrame can run show() against a
  // node that has already been detached.
  const readAt = src.indexOf("sessionStorage.getItem(SESSION_KEY)");
  const mountAt = src.indexOf('document.body.appendChild(root)');
  const rafAt = src.indexOf('window.requestAnimationFrame(onScroll)');
  assert.ok(readAt > -1 && mountAt > -1, 'both the session read and the mount must exist');
  assert.ok(readAt < mountAt, 'session dismissal must be checked before mounting');
  assert.ok(readAt < rafAt, 'session dismissal must be checked before scheduling scroll work');

  // stop() must cancel the frame and drop the resize listener, both of
  // which used to survive dismissal.
  assert.ok(/cancelAnimationFrame\(rafId\)/.test(src), 'stop() must cancel the queued frame');
  assert.ok(/removeEventListener\('resize', onResize\)/.test(src), 'stop() must drop the resize listener');
  // Removal must happen exactly once, and only from the close button —
  // there is no longer a second, session-restore path that appends the
  // node and then immediately tears it down.
  const removes = src.match(/root\.remove\(\)/g) || [];
  assert.strictEqual(removes.length, 1, 'root.remove() must only be called from the close handler');
  assert.ok(
    src.indexOf('root.remove()') > src.indexOf('close.addEventListener'),
    'removal must be driven by the close button'
  );
  // And the dismissed session is short-circuited before the listeners are
  // ever registered, so there is nothing to leak.
  assert.ok(
    /if \(dismissed\) \{[\s\S]{0,160}?\n\s{4}\}/.test(src),
    'a dismissed session must return before mounting'
  );
});

test('Fixed height contract: height never derived from content', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'js', 'event-countdown.css'), 'utf8');
  assert.ok(/--u45-cd-h:\s*76px/.test(css), 'desktop height must be a fixed variable');
  assert.ok(/--u45-cd-h:\s*64px/.test(css), 'mobile height must be a fixed variable');
  assert.ok(/height: var\(--u45-cd-h\)/.test(css), 'row must use the fixed height');
  assert.ok(/--u45-cd-h/.test(src), 'live height must be published for inspection');
});

test('Colours come from the brand tokens, not hardcoded hexes', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'js', 'event-countdown.css'), 'utf8');
  // Every brand colour must be read from a site token, with the hex
  // appearing only as the fallback after the comma.
  for (const token of ['--orange', '--orange-deep', '--teal', '--teal-light', '--nav-bg', '--text']) {
    assert.ok(
      new RegExp('var\\(' + token + ',').test(css),
      token + ' must be consumed from the site token, with a literal fallback'
    );
  }
  // Brand display + body fonts, matching the rest of the site.
  assert.ok(/--font-display/.test(css), 'digits must use the display font');
  assert.ok(/--font-body/.test(css), 'labels must use the body font');
  // No stray brand hex outside a var() fallback.
  const hexesOutsideFallback = css
    .replace(/var\(--[a-z0-9-]+,\s*#[0-9a-f]{3,8}\)/gi, '')
    .match(/#[0-9a-f]{3,8}\b/gi) || [];
  assert.deepStrictEqual(
    hexesOutsideFallback.filter((h) => /^(#f07d1a|#c96410|#0e6b73|#1a8a94)$/i.test(h)),
    [],
    'brand hexes must only ever appear as var() fallbacks'
  );
});

test('Banner overlays the header instead of pushing it down', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'js', 'event-countdown.css'), 'utf8');
  // z-index must clear every header on the site (.nav 999, .site-header
  // 1000, the old discount banner 20000).
  const z = Number(/z-index:\s*(\d+);/.exec(css)[1]);
  assert.ok(z > 20000, 'z-index must be above every site header, got ' + z);
  // And there must be no rule that offsets a header.
  assert.ok(
    !/u45-cd-pinned/.test(css),
    'the banner must cover the header, not shift it'
  );
  assert.ok(
    !/u45-cd-pinned/.test(src),
    'the component must not add a class that offsets the header'
  );
});

test('Reveals after the hero is scrolled past', () => {
  assert.ok(/findHero/.test(src), 'hero must be detected structurally');
  assert.ok(/HERO_MIN_PX/.test(src), 'a short section must not count as a hero');
  assert.ok(/scrollY >= revealAt/.test(src), 'reveal is gated on scroll position');
  assert.ok(/data-cd-no-hero/.test(src), 'hero-less pages can opt out of the gate');
});

test('Self-injects its stylesheet, so pages need only the script tag', () => {
  assert.ok(/ensureStylesheet/.test(src), 'stylesheet injection must exist');
  assert.ok(/CSS_HREF = '\/js\/event-countdown\.css'/.test(src), 'must point at the shared css');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed > 0 ? 1 : 0);
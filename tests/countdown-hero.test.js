/* Verifies the hero-gate logic of the countdown banner:
   - a tall .hero delays the banner until it scrolls past
   - a short section is NOT mistaken for a hero
   - a page with no hero shows the banner immediately

   Run with:  node tests/countdown-hero.test.js                     */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'js', 'event-countdown.js'),
  'utf8'
);

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

/**
 * Boots the component against a stub DOM.
 * heroHeight: height of the first .hero match, or null for no hero.
 */
function boot(heroHeight) {
  const htmlCls = {
    _s: new Set(),
    add(c) { this._s.add(c); },
    remove(c) { this._s.delete(c); },
    has(c) { return this._s.has(c); }
  };

  const hero = heroHeight === null ? null : {
    className: 'hero',
    getBoundingClientRect() { return { height: heroHeight, top: 0 }; }
  };

  const mkNode = () => ({
    className: '', textContent: '', innerHTML: '', href: '', type: '',
    hidden: false, dataset: {},
    style: { setProperty() {} },
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); }
    },
    setAttribute(k, v) { this[k] = v; },
    appendChild(c) { (this.kids || (this.kids = [])).push(c); },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { height: 56, top: 0 }; }
  });

  const body = {
    root: null,
    appendChild(n) { this.root = n; },
    remove() {},
    hasAttribute() { return false; },
    getAttribute() { return null; },
    style: { setProperty() {} }
  };

  const doc = {
    readyState: 'loading',
    hidden: false,
    head: { appendChild() {} },
    body,
    documentElement: { classList: htmlCls, style: { setProperty() {} } },
    addEventListener() {},
    removeEventListener() {},
    createElement: mkNode,
    createDocumentFragment: () => ({ appendChild() {} }),
    querySelector(sel) { return /hero/.test(sel) ? hero : null; },
    querySelectorAll(sel) { return /hero/.test(sel) && hero ? [hero] : []; }
  };

  const win = {
    scrollY: 0,
    _h: {},
    setInterval() { return 1; },
    clearInterval() {},
    addEventListener(e, f) { this._h[e] = f; },
    removeEventListener() {},
    requestAnimationFrame(f) { f(); }
  };

  const sandbox = {
    window: win,
    document: doc,
    console,
    Date, Math, String, Number, Object, Array,
    CustomEvent: class {},
    setInterval() { return 1; },
    clearInterval() {}
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);

  doc.readyState = 'complete';
  vm.runInContext('window.U45EventCountdown.init()', sandbox);

  return {
    win,
    root: body.root,
    visible: () => body.root.classList.contains('is-visible'),
    scrollTo(y) { win.scrollY = y; win._h.scroll(); }
  };
}

console.log('\nCountdown banner — hero reveal gate\n');

test('Banner stays hidden while the hero is on screen', () => {
  const app = boot(700);
  assert.ok(app.root, 'banner must be built');
  app.scrollTo(0);
  assert.strictEqual(app.visible(), false, 'hidden at the top');
  app.scrollTo(300);
  assert.strictEqual(app.visible(), false, 'still hidden mid-hero');
});

test('Banner slides in once the hero has scrolled past', () => {
  const app = boot(700);
  app.scrollTo(700 + 60);
  assert.strictEqual(app.visible(), true, 'visible past the hero');
});

test('Banner hides again when scrolled back above the hero', () => {
  const app = boot(700);
  app.scrollTo(800);
  assert.strictEqual(app.visible(), true);
  app.scrollTo(0);
  assert.strictEqual(app.visible(), false, 'hidden again at the top');
});

test('A short section is not mistaken for a hero', () => {
  // 120px is below the 260px threshold, so the banner shows at once.
  const app = boot(120);
  assert.strictEqual(app.visible(), true, 'hero-less page shows immediately');
});

test('A page with no hero shows the banner immediately', () => {
  const app = boot(null);
  assert.strictEqual(app.visible(), true, 'no hero -> always visible');
});

test('Reveal threshold tracks the hero height', () => {
  const short = boot(300);
  const tall = boot(1200);
  short.scrollTo(400);
  tall.scrollTo(400);
  assert.strictEqual(short.visible(), true, '300px hero cleared by 400px scroll');
  assert.strictEqual(tall.visible(), false, '1200px hero not yet cleared at 400px');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed > 0 ? 1 : 0);
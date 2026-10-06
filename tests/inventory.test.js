/* ═══════════════════════════════════════════════════════════════
   Ticket inventory tests — covers the 12 scenarios in the brief.
   Run with:  node tests/inventory.test.js
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const assert = require('assert');
const { createStore } = require('./helpers/memory-firestore');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log('  \u2713 ' + name);
    })
    .catch((err) => {
      failed += 1;
      failures.push({ name, err });
      console.log('  \u2717 ' + name + '\n      ' + err.message);
    });
}

// Load the inventory module bound to a fresh in-memory store.
function loadInventory(store) {
  const path = require.resolve('../api/_lib/ticket-inventory.js');
  delete require.cache[path];
  // Intercept the firebase-admin dependency.
  const adminPath = require.resolve('../api/_lib/firebase-admin.js');
  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: {
      db: () => store,
      requireAdmin: async () => ({ uid: 'admin-1', email: 'admin@x.com', isAdmin: true }),
      Timestamp: { fromMillis: (ms) => ({ __ms: ms }) }
    }
  };
  const mod = require(path);
  return mod;
}

// Load the HTTP handler bound to a store and a stubbed admin identity.
function loadConfirmOrder(store, admin) {
  const identity = admin || { uid: 'admin-1', email: 'admin@x.com', isAdmin: true };
  const adminPath = require.resolve('../api/_lib/firebase-admin.js');
  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: {
      db: () => store,
      requireAdmin: async () => identity,
      Timestamp: { fromMillis: (ms) => ({ __ms: ms }) }
    }
  };
  const invPath = require.resolve('../api/_lib/ticket-inventory.js');
  delete require.cache[invPath];
  require(invPath);

  const handlerPath = require.resolve('../api/tickets/confirm-order.js');
  delete require.cache[handlerPath];
  return require(handlerPath);
}

// Load the admin review handler bound to a store and a stubbed identity.
function loadReviewOrder(store, admin) {
  const identity = admin === undefined
    ? { uid: 'admin-1', email: 'admin@x.com', isAdmin: true }
    : admin;
  const adminPath = require.resolve('../api/_lib/firebase-admin.js');
  require.cache[adminPath] = {
    id: adminPath,
    filename: adminPath,
    loaded: true,
    exports: {
      db: () => store,
      requireAdmin: async () => identity,
      Timestamp: { fromMillis: (ms) => ({ __ms: ms }), now: () => ({ __ms: 1 }) }
    }
  };
  const invPath = require.resolve('../api/_lib/ticket-inventory.js');
  delete require.cache[invPath];
  require(invPath);

  const handlerPath = require.resolve('../api/tickets/review-order.js');
  delete require.cache[handlerPath];
  return require(handlerPath);
}

// Minimal Express-like req/res capture. The handler is async, so this
// awaits it before the caller inspects statusCode/body.
async function call(handler, req) {
  const res = {
    statusCode: 200,
    body: null,
    headers: {},
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  await handler(
    { method: 'POST', headers: {}, body: {}, ...req },
    res
  );
  return res;
}

function remaining(store, key) {
  return store.data.ticket_inventory[key].remainingQuantity;
}

async function main() {
  console.log('\nTicket inventory — backend behaviour\n');

  // ── Scenario 1 ────────────────────────────────────────────────
  await test('1. Fresh load shows Essential 49, Growth 25, Executive 18, Founders 10', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    const tiers = await inv.readInventory();
    const byKey = Object.fromEntries(tiers.map((t) => [t.key, t.remainingQuantity]));
    assert.deepStrictEqual(byKey, {
      essential: 49,
      growth: 25,
      executive: 18,
      founders_inner_circle: 10
    });
    assert.strictEqual(tiers.find((t) => t.key === 'essential').ticketsSold, 0);
  });

  // ── Scenario 2 ────────────────────────────────────────────────
  await test('2. Purchase 1 Essential: 49 -> 48', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    await inv.commitDeduction({ orderId: 'U45-A', lines: [{ key: 'essential', qty: 1 }] });
    assert.strictEqual(remaining(store, 'essential'), 48);
  });

  // ── Scenario 3 ────────────────────────────────────────────────
  await test('3. Purchase 2 Essential: 48 -> 46 (and other tiers untouched)', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    await inv.commitDeduction({ orderId: 'U45-A', lines: [{ key: 'essential', qty: 1 }] });
    await inv.commitDeduction({ orderId: 'U45-B', lines: [{ key: 'essential', qty: 2 }] });
    assert.strictEqual(remaining(store, 'essential'), 46);
    assert.strictEqual(remaining(store, 'growth'), 25);
    assert.strictEqual(remaining(store, 'executive'), 18);
    assert.strictEqual(remaining(store, 'founders_inner_circle'), 10);
  });

  // ── Scenario 4 ────────────────────────────────────────────────
  await test('4. Failed payment leaves inventory unchanged', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    // createClaim reserves nothing; nothing is written to stock.
    await inv.createClaim({ orderId: 'U45-FAIL', lines: [{ key: 'growth', qty: 2 }] });
    await inv.releaseClaim({ claimId: 'whatever' });
    assert.strictEqual(remaining(store, 'growth'), 25);
    assert.deepStrictEqual(store.data.ticket_inventory_ledger, {});
  });

  // ── Scenario 5 ────────────────────────────────────────────────
  await test('5. Abandoned checkout leaves inventory unchanged', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    const claim = await inv.createClaim({ orderId: 'U45-ABANDON', lines: [{ key: 'executive', qty: 3 }] });
    await inv.releaseClaim({ claimId: claim.claimId });
    assert.strictEqual(remaining(store, 'executive'), 18);
  });

  // ── Scenario 6 ────────────────────────────────────────────────
  await test('6. "Refresh" (new read) returns the persisted backend value', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    await inv.commitDeduction({ orderId: 'U45-A', lines: [{ key: 'growth', qty: 4 }] });
    const tiers = await inv.readInventory();
    assert.strictEqual(tiers.find((t) => t.key === 'growth').remainingQuantity, 21);
    assert.strictEqual(tiers.find((t) => t.key === 'growth').ticketsSold, 4);
  });

  // ── Scenario 7 ────────────────────────────────────────────────
  await test('7. A second reader (different device) sees the same value', async () => {
    const store = createStore();
    const writer = loadInventory(store);
    await writer.commitDeduction({ orderId: 'U45-A', lines: [{ key: 'founders_inner_circle', qty: 1 }] });

    const reader = loadInventory(store); // fresh module instance, same DB
    const tiers = await reader.readInventory();
    assert.strictEqual(tiers.find((t) => t.key === 'founders_inner_circle').remainingQuantity, 9);
  });

  // ── Scenario 8 ────────────────────────────────────────────────
  await test('8. Purchasing the final ticket drives the tier to 0 / SOLD OUT', async () => {
    const store = createStore({
      ticket_inventory: {
        ...createStore().data.ticket_inventory,
        founders_inner_circle: {
          key: 'founders_inner_circle',
          ticketType: 'Founders Inner Circle',
          initialQuantity: 10,
          remainingQuantity: 1,
          price: 130000
        }
      }
    });
    const inv = loadInventory(store);
    await inv.commitDeduction({ orderId: 'U45-LAST', lines: [{ key: 'founders_inner_circle', qty: 1 }] });
    assert.strictEqual(remaining(store, 'founders_inner_circle'), 0);
    const tiers = await inv.readInventory();
    const tier = tiers.find((t) => t.key === 'founders_inner_circle');
    assert.strictEqual(tier.soldOut, true);
    assert.strictEqual(tier.ticketsSold, 10);
  });

  // ── Scenario 9 ────────────────────────────────────────────────
  await test('9. Buying a sold-out tier through the API is rejected', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    await store.collection('ticket_inventory').doc('executive').update({ remainingQuantity: 0 });
    await assert.rejects(
      () => inv.commitDeduction({ orderId: 'U45-SOLDOUT', lines: [{ key: 'executive', qty: 1 }] }),
      (err) => err.code === 'SOLD_OUT'
    );
    assert.strictEqual(remaining(store, 'executive'), 0);
  });

  // ── Scenario 10 ───────────────────────────────────────────────
  await test('10. Same payment reference twice only deducts once', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    const first = await inv.commitDeduction({ orderId: 'U45-DUP', lines: [{ key: 'essential', qty: 3 }] });
    const second = await inv.commitDeduction({ orderId: 'U45-DUP', lines: [{ key: 'essential', qty: 3 }] });
    const third = await inv.commitDeduction({ orderId: 'U45-DUP', lines: [{ key: 'essential', qty: 3 }] });

    assert.strictEqual(first.alreadyProcessed, false);
    assert.strictEqual(second.alreadyProcessed, true);
    assert.strictEqual(third.alreadyProcessed, true);
    assert.strictEqual(remaining(store, 'essential'), 46); // 49 - 3, once only
    assert.strictEqual(Object.keys(store.data.ticket_inventory_ledger).length, 1);
  });

  // ── Scenario 11 ───────────────────────────────────────────────
  await test('11. Two simultaneous buyers for the last ticket: only one wins', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    await store.collection('ticket_inventory').doc('growth').update({ remainingQuantity: 1 });

    const results = await Promise.allSettled([
      inv.commitDeduction({ orderId: 'U45-RACE-1', lines: [{ key: 'growth', qty: 1 }] }),
      inv.commitDeduction({ orderId: 'U45-RACE-2', lines: [{ key: 'growth', qty: 1 }] }),
      inv.commitDeduction({ orderId: 'U45-RACE-3', lines: [{ key: 'growth', qty: 1 }] })
    ]);

    const wins = results.filter((r) => r.status === 'fulfilled');
    const losses = results.filter((r) => r.status === 'rejected');

    assert.strictEqual(wins.length, 1, 'exactly one purchase should succeed');
    assert.strictEqual(losses.length, 2);
    losses.forEach((l) => assert.strictEqual(l.reason.code, 'SOLD_OUT'));
    assert.strictEqual(remaining(store, 'growth'), 0);
    assert.ok(remaining(store, 'growth') >= 0, 'inventory must never go negative');
  });

  // ── Scenario 12 ───────────────────────────────────────────────
  await test('12. Ordering more than remain is rejected, nothing partial is taken', async () => {
    const store = createStore();
    const inv = loadInventory(store);

    await assert.rejects(
      () => inv.commitDeduction({ orderId: 'U45-TOO-MANY', lines: [{ key: 'essential', qty: 50 }] }),
      (err) => err.code === 'SOLD_OUT'
    );
    assert.strictEqual(remaining(store, 'essential'), 49);

    // Multi-tier order where one line is short: the whole order fails.
    await assert.rejects(
      () =>
        inv.commitDeduction({
          orderId: 'U45-MIXED',
          lines: [
            { key: 'essential', qty: 2 },
            { key: 'executive', qty: 99 }
          ]
        }),
      (err) => err.code === 'SOLD_OUT'
    );
    assert.strictEqual(remaining(store, 'essential'), 49, 'no partial deduction');
    assert.strictEqual(remaining(store, 'executive'), 18);
  });

  // ── Extra: client-supplied quantities are never trusted ──────
  await test('13. Server computes deduction; ledger records the real quantities', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    await store.collection('checkouts').doc('U45-SERVER').set({
      tickets: { essential: 2 },
      paymentStatus: 'awaiting_verification'
    });
    const order = (await store.collection('checkouts').doc('U45-SERVER').get()).data();

    // Simulate the API reading quantities from Firestore, ignoring any
    // client-supplied "remaining_quantity".
    await inv.commitDeduction({
      orderId: 'U45-SERVER',
      lines: Object.entries(order.tickets).map(([key, qty]) => ({ key, qty })),
      actor: 'admin-1'
    });

    assert.strictEqual(remaining(store, 'essential'), 47);
    const ledger = store.data.ticket_inventory_ledger['U45-SERVER'];
    assert.deepStrictEqual(ledger.lines, [{ key: 'essential', qty: 2 }]);
    assert.strictEqual(ledger.actor, 'admin-1');
  });

  // ── Extra: invalid input ─────────────────────────────────────
  await test('14. Malformed quantities are rejected before any write', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    const bad = [
      [{ key: 'essential', qty: 0 }],
      [{ key: 'essential', qty: -3 }],
      [{ key: 'essential', qty: 1.5 }],
      [{ key: 'nonsense', qty: 1 }],
      []
    ];
    for (const lines of bad) {
      await assert.rejects(() => inv.commitDeduction({ orderId: 'U45-BAD', lines }));
    }
    assert.strictEqual(remaining(store, 'essential'), 49);
  });

  // ── Extra: derived sold count stays consistent ───────────────
  await test('15. tickets_sold is always initial - remaining', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    await inv.commitDeduction({
      orderId: 'U45-MIX',
      lines: [
        { key: 'essential', qty: 5 },
        { key: 'growth', qty: 3 },
        { key: 'founders_inner_circle', qty: 2 }
      ]
    });
    const tiers = await inv.readInventory();
    tiers.forEach((t) => {
      assert.strictEqual(t.ticketsSold, t.initialQuantity - t.remainingQuantity);
      assert.ok(t.remainingQuantity >= 0);
    });
    assert.strictEqual(tiers.find((t) => t.key === 'founders_inner_circle').lowStock, true);
  });

  // ── Extra: admin clamp ───────────────────────────────────────
  await test('16. Admin adjust clamps to [0, initial]', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    await inv.setRemaining({ key: 'growth', remainingQuantity: 999, actor: 'admin-1' });
    assert.strictEqual(remaining(store, 'growth'), 25);
    await inv.setRemaining({ key: 'growth', remainingQuantity: -5, actor: 'admin-1' });
    assert.strictEqual(remaining(store, 'growth'), 0);
  });

  // ── Extra: tier name normalisation ───────────────────────────
  await test('17. Tier names and slugs both resolve to the same inventory doc', async () => {
    const store = createStore();
    const inv = loadInventory(store);
    assert.strictEqual(inv.normaliseTierKey('Founders Inner Circle'), 'founders_inner_circle');
    assert.strictEqual(inv.normaliseTierKey('founders_inner_circle'), 'founders_inner_circle');
    assert.strictEqual(inv.normaliseTierKey('Essential'), 'essential');
    assert.strictEqual(inv.normaliseTierKey('unknown'), null);

    await inv.commitDeduction({ orderId: 'U45-N1', lines: [{ key: 'Founders Inner Circle', qty: 1 }] });
    assert.strictEqual(remaining(store, 'founders_inner_circle'), 9);
  });

  // ── Admin review endpoint ─────────────────────────────────────
  // admin.html used to write 'approved' to Firestore from the browser,
  // which firestore.rules denies. These lock in the server-side
  // replacement: the status flip and the deduction are one admin-gated
  // request.
  await test('24. review-order approves the order AND deducts in one call', async () => {
    const store = createStore();
    store.data.checkouts['U45-R1'] = {
      paymentStatus: 'pending',
      status: 'awaiting_payment',
      tickets: { essential: 2 }
    };
    const handler = loadReviewOrder(store);

    const res = await call(handler, {
      method: 'POST',
      body: { orderId: 'U45-R1', decision: 'approve' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(store.data.checkouts['U45-R1'].paymentStatus, 'approved');
    assert.strictEqual(store.data.checkouts['U45-R1'].status, 'approved');
    assert.strictEqual(remaining(store, 'essential'), 47, 'stock must move');
  });

  await test('25. review-order is idempotent — approving twice deducts once', async () => {
    const store = createStore();
    store.data.checkouts['U45-R2'] = {
      paymentStatus: 'pending',
      status: 'awaiting_payment',
      tickets: { growth: 1 }
    };
    const handler = loadReviewOrder(store);

    await call(handler, { method: 'POST', body: { orderId: 'U45-R2', decision: 'approve' } });
    const second = await call(handler, { method: 'POST', body: { orderId: 'U45-R2', decision: 'approve' } });

    assert.strictEqual(second.statusCode, 200);
    assert.strictEqual(second.body.alreadyProcessed, true);
    assert.strictEqual(remaining(store, 'growth'), 24, 'only one deduction');
  });

  await test('26. review-order refuses a non-admin and moves no stock', async () => {
    const store = createStore();
    store.data.checkouts['U45-R3'] = {
      paymentStatus: 'pending',
      status: 'awaiting_payment',
      tickets: { essential: 1 }
    };
    const handler = loadReviewOrder(store, { uid: 'buyer-9', email: 'buyer@x.com', isAdmin: false });

    const res = await call(handler, {
      method: 'POST',
      body: { orderId: 'U45-R3', decision: 'approve' }
    });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(store.data.checkouts['U45-R3'].paymentStatus, 'pending', 'status untouched');
    assert.strictEqual(remaining(store, 'essential'), 49, 'stock must be untouched');
  });

  await test('27. review-order reject marks rejected and never deducts', async () => {
    const store = createStore();
    store.data.checkouts['U45-R4'] = {
      paymentStatus: 'pending',
      status: 'awaiting_payment',
      tickets: { executive: 1 }
    };
    const handler = loadReviewOrder(store);

    const res = await call(handler, {
      method: 'POST',
      body: { orderId: 'U45-R4', decision: 'reject' }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(store.data.checkouts['U45-R4'].paymentStatus, 'rejected');
    assert.strictEqual(remaining(store, 'executive'), 18, 'stock must be untouched');
  });

  await test('28. review-order rejects an unknown order and a bad decision', async () => {
    const store = createStore();
    const handler = loadReviewOrder(store);

    const missing = await call(handler, {
      method: 'POST',
      body: { orderId: 'U45-NOPE', decision: 'approve' }
    });
    assert.strictEqual(missing.statusCode, 404);

    const bad = await call(handler, {
      method: 'POST',
      body: { orderId: 'U45-R4', decision: 'maybe' }
    });
    assert.strictEqual(bad.statusCode, 400);
  });

  await test('29. review-order records delivery metadata as allowlisted notes', async () => {
    const store = createStore();
    store.data.checkouts['U45-R5'] = {
      paymentStatus: 'pending',
      status: 'awaiting_payment',
      tickets: { essential: 1 }
    };
    const handler = loadReviewOrder(store);

    await call(handler, {
      method: 'POST',
      body: {
        orderId: 'U45-R5',
        decision: 'approve',
        delivery: { channel: 'whatsapp', to: '+2348000000000' },
        // Anything quantity-shaped must be ignored entirely.
        tickets: { founders_inner_circle: 5 }
      }
    });
    const order = store.data.checkouts['U45-R5'];
    assert.strictEqual(order.sentVia, 'whatsapp');
    assert.strictEqual(order.ticketsSentTo, '+2348000000000');
    assert.deepStrictEqual(order.tickets, { essential: 1 }, 'line items must be immutable');
    assert.strictEqual(remaining(store, 'essential'), 48);
    assert.strictEqual(remaining(store, 'founders_inner_circle'), 10);
  });
  // ── Extra: payment-confirmation gate ─────────────────────────
  await test('18. confirm-order refuses to deduct for an unpaid order', async () => {
    const store = createStore();
    store.data.checkouts['U45-UNPAID'] = {
      paymentStatus: 'pending',
      status: 'awaiting_payment',
      tickets: { essential: 1 }
    };
    const handler = loadConfirmOrder(store);

    const res = await call(handler, { method: 'POST', body: { orderId: 'U45-UNPAID' } });
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'PAYMENT_NOT_CONFIRMED');
    assert.strictEqual(remaining(store, 'essential'), 49, 'stock must be untouched');
  });

  await test('19. confirm-order deducts once the order is marked approved', async () => {
    const store = createStore();
    store.data.checkouts['U45-PAID'] = {
      paymentStatus: 'approved',
      status: 'approved',
      tickets: { essential: 2 }
    };
    const handler = loadConfirmOrder(store);

    const res = await call(handler, { method: 'POST', body: { orderId: 'U45-PAID' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(remaining(store, 'essential'), 47);
  });

  await test('20. confirm-order accepts a receipt-verified order (paymentStatus: verified)', async () => {
    const store = createStore();
    store.data.checkouts['U45-VERIFIED'] = {
      paymentStatus: 'verified',
      tickets: { growth: 1 }
    };
    const handler = loadConfirmOrder(store);

    const res = await call(handler, { method: 'POST', body: { orderId: 'U45-VERIFIED' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(remaining(store, 'growth'), 24);
  });

  await test('21. Rejected order is skipped, not an error, and never deducts', async () => {
    const store = createStore();
    store.data.checkouts['U45-BAD'] = {
      paymentStatus: 'rejected',
      tickets: { executive: 1 }
    };
    const handler = loadConfirmOrder(store);

    const res = await call(handler, { method: 'POST', body: { orderId: 'U45-BAD' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.skipped, true);
    assert.strictEqual(res.body.reason, 'order_rejected');
    assert.strictEqual(remaining(store, 'executive'), 18);
  });

  await test('22. A non-admin caller cannot deduct', async () => {
    const store = createStore();
    store.data.checkouts['U45-PAID'] = {
      paymentStatus: 'approved',
      tickets: { essential: 1 }
    };
    const handler = loadConfirmOrder(store, { uid: 'random-user', isAdmin: false });

    const res = await call(handler, { method: 'POST', body: { orderId: 'U45-PAID' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(remaining(store, 'essential'), 49, 'stock must be untouched');
  });

  await test('23. Unsuccessful webhook status never deducts', async () => {
    const store = createStore();
    const handler = loadConfirmOrder(store);
    process.env.SELAR_WEBHOOK_SECRET = 'shhh';

    const res = await call(handler, {
      method: 'POST',
      headers: { 'x-webhook-secret': 'shhh' },
      body: {
        reference: 'SELAR-1',
        status: 'failed',
        items: [{ ticket_type: 'Growth', quantity: 1 }]
      }
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.skipped, true);
    assert.strictEqual(remaining(store, 'growth'), 25);
    delete process.env.SELAR_WEBHOOK_SECRET;
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  if (failed > 0) {
    failures.forEach((f) => console.log('FAILED: ' + f.name + '\n' + f.err.stack + '\n'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

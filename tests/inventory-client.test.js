/* ═══════════════════════════════════════════════════════════════
   Client-side inventory tests — the browser path that checkout.html
   uses to reduce the count the moment an order is created.
   Run with:  node tests/inventory-client.test.js
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const assert = require('assert');
const { createStore } = require('./helpers/memory-firestore');
const inv = require('../js/ticket-inventory-client.js');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('  \u2713 ' + name); })
    .catch((err) => {
      failed += 1;
      failures.push({ name, err });
      console.log('  \u2717 ' + name + '\n      ' + err.message);
    });
}

function remaining(store, key) {
  return store.data.ticket_inventory[key].remainingQuantity;
}

async function main() {
  console.log('\nTicket inventory — client (Firestore SDK) behaviour\n');

  await test('C1. checkout decrements the selected tier immediately (49 -> 48)', async () => {
    const store = createStore();
    const res = await inv.deductInventory(store, store.FieldValue, 'U45-C1', { essential: 1 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.alreadyProcessed, false);
    assert.strictEqual(remaining(store, 'essential'), 48);
    assert.ok(store.data.ticket_inventory_ledger['U45-C1'], 'ledger written');
  });

  await test('C2. two checkouts go 49 -> 48 -> 47', async () => {
    const store = createStore();
    await inv.deductInventory(store, store.FieldValue, 'U45-C2', { essential: 1 });
    assert.strictEqual(remaining(store, 'essential'), 48);
    await inv.deductInventory(store, store.FieldValue, 'U45-C3', { essential: 1 });
    assert.strictEqual(remaining(store, 'essential'), 47);
  });

  await test('C3. only the selected tier moves', async () => {
    const store = createStore();
    await inv.deductInventory(store, store.FieldValue, 'U45-C4', { growth: 1 });
    assert.strictEqual(remaining(store, 'growth'), 24);
    assert.strictEqual(remaining(store, 'essential'), 49);
    assert.strictEqual(remaining(store, 'executive'), 18);
    assert.strictEqual(remaining(store, 'founders_inner_circle'), 10);
  });

  await test('C4. the same order can only ever be counted once', async () => {
    const store = createStore();
    await inv.deductInventory(store, store.FieldValue, 'U45-C5', { essential: 2 });
    const second = await inv.deductInventory(store, store.FieldValue, 'U45-C5', { essential: 2 });
    const third = await inv.deductInventory(store, store.FieldValue, 'U45-C5', { essential: 2 });
    assert.strictEqual(second.alreadyProcessed, true);
    assert.strictEqual(third.alreadyProcessed, true);
    assert.strictEqual(remaining(store, 'essential'), 47, 'deducted exactly once');
  });

  await test('C4b. two orders with the same tier each count once', async () => {
    const store = createStore();
    await inv.deductInventory(store, store.FieldValue, 'U45-C5a', { essential: 2 });
    await inv.deductInventory(store, store.FieldValue, 'U45-C5b', { essential: 3 });
    assert.strictEqual(remaining(store, 'essential'), 44);
  });

  await test('C4c. concurrent duplicates cannot double-deduct', async () => {
    const store = createStore();
    const results = await Promise.all([
      inv.deductInventory(store, store.FieldValue, 'U45-RACE', { executive: 1 }),
      inv.deductInventory(store, store.FieldValue, 'U45-RACE', { executive: 1 }),
      inv.deductInventory(store, store.FieldValue, 'U45-RACE', { executive: 1 })
    ]);
    assert.strictEqual(remaining(store, 'executive'), 17, 'deducted exactly once');
    assert.strictEqual(results.filter((r) => r.alreadyProcessed).length, 2);
  });

  await test('C5. count clamps at zero and never goes negative', async () => {
    const store = createStore();
    await inv.deductInventory(store, store.FieldValue, 'U45-BIG', {
      founders_inner_circle: 99
    });
    assert.strictEqual(remaining(store, 'founders_inner_circle'), 0);
  });

  await test('C6. normalises display names and ignores junk lines', async () => {
    assert.strictEqual(inv.normaliseKey('Founders Inner Circle'), 'founders_inner_circle');
    assert.strictEqual(inv.normaliseKey('GROWTH'), 'growth');
    assert.strictEqual(inv.normaliseKey('nope'), null);
    assert.deepStrictEqual(
      inv.linesFromCart({ 'Founders Inner Circle': 1, growth: 0, junk: 5, executive: 2 }),
      [{ key: 'founders_inner_circle', qty: 1 }, { key: 'executive', qty: 2 }]
    );
  });

  await test('C7. tiersFromDocs falls back to opening stock when a doc is missing', async () => {
    const tiers = inv.tiersFromDocs({});
    const byKey = {};
    tiers.forEach((t) => { byKey[t.key] = t.remainingQuantity; });
    assert.deepStrictEqual(byKey, {
      essential: 49,
      growth: 25,
      executive: 18,
      founders_inner_circle: 10
    });
    assert.strictEqual(tiers.find((t) => t.key === 'essential').soldOut, false);
  });

  await test('C8. tiersFromDocs reports SOLD OUT at zero', async () => {
    const tiers = inv.tiersFromDocs({
      essential: { initialQuantity: 49, remainingQuantity: 0 }
    });
    const essential = tiers.find((t) => t.key === 'essential');
    assert.strictEqual(essential.soldOut, true);
    assert.strictEqual(essential.ticketsSold, 49);
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
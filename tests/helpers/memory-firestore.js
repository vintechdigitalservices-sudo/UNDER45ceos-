/* ═══════════════════════════════════════════════════════════════
   In-memory Firestore double for the ticket-inventory layer.
   Used only by tests/inventory.test.js — it is never imported by the
   deployed API. Implements just enough of the Admin SDK surface:
   get / getAll / set / update / create / delete inside
   runTransaction, plus optimistic-lock retry on write conflicts.

   Locks are acquired in a deterministic order (sorted by path) so two
   concurrent transactions touching the same documents serialise
   exactly the way Firestore does.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

const seedData = {
  ticket_inventory: {
    essential: { key: 'essential', ticketType: 'Essential', initialQuantity: 49, remainingQuantity: 49, price: 5000 },
    growth: { key: 'growth', ticketType: 'Growth', initialQuantity: 25, remainingQuantity: 25, price: 15000 },
    executive: { key: 'executive', ticketType: 'Executive', initialQuantity: 18, remainingQuantity: 18, price: 25000 },
    founders_inner_circle: { key: 'founders_inner_circle', ticketType: 'Founders Inner Circle', initialQuantity: 10, remainingQuantity: 10, price: 130000 }
  },
  ticket_inventory_ledger: {},
  ticket_inventory_claims: {},
  checkouts: {}
};

class ConflictError extends Error {
  constructor() {
    super('CONFLICT');
    this.code = 6;
  }
}

class AlreadyExistsError extends Error {
  constructor() {
    super('ALREADY_EXISTS');
    this.code = 6;
  }
}

// ── Snapshot / reference shims ──────────────────────────────────
class DocSnap {
  constructor(id, data, ref) {
    this.id = id;
    this._data = data;
    this.exists = data !== undefined;
    if (ref) this.ref = ref;
  }
  data() {
    return this._data ? JSON.parse(JSON.stringify(this._data)) : undefined;
  }
}

class DocRef {
  constructor(store, collection, id) {
    this.store = store;
    this.name = collection;
    this.path = `${collection}/${id}`;
    this.id = id;
  }
  collection(name) {
    return new CollectionRef(this.store, name);
  }
  async get() {
    const col = this.store.data[this.name] || {};
    return new DocSnap(this.id, col[this.id]);
  }
  async set(data) {
    if (!this.store.data[this.name]) this.store.data[this.name] = {};
    this.store.data[this.name][this.id] = { ...(this.store.data[this.name][this.id] || {}), ...data };
  }
  async update(data) {
    if (!this.store.data[this.name]) this.store.data[this.name] = {};
    if (!this.store.data[this.name][this.id]) throw new Error('NOT_FOUND');
    this.store.data[this.name][this.id] = { ...this.store.data[this.name][this.id], ...data };
  }
  async delete() {
    if (this.store.data[this.name]) delete this.store.data[this.name][this.id];
  }
}

class CollectionRef {
  constructor(store, name) {
    this.store = store;
    this.name = name;
  }
  doc(id) {
    return new DocRef(this.store, this.name, id);
  }
  async get() {
    const docs = Object.entries(this.store.data[this.name] || {}).map(([id, d]) => new DocSnap(id, d));
    return { docs, empty: docs.length === 0 };
  }
}

const locks = new Map(); // path -> Promise chain
const held = new Set();  // paths locked by the in-flight transaction

function withLock(path, fn) {
  const prev = locks.get(path) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(path, next.catch(() => {}));
  return next;
}

// ── Transaction ─────────────────────────────────────────────────
function makeTx(store) {
  const reads = new Map();   // path -> DocSnap
  const writes = new Map();  // path -> { type, data }

  const getSnap = (ref) => {
    if (reads.has(ref.path)) return reads.get(ref.path);
    const col = ref.path.split('/')[0];
    const snap = new DocSnap(ref.id, store.data[col] && store.data[col][ref.id], ref);
    reads.set(ref.path, snap);
    return snap;
  };

  const put = (ref, type, data) => writes.set(ref.path, { type, ref, data });

  return {
    get: async (ref) => getSnap(ref),
    getAll: async (...refs) => refs.map(getSnap),
    update: (ref, data) => {
      getSnap(ref);
      put(ref, 'update', data);
    },
    set: (ref, data) => {
      getSnap(ref);
      put(ref, 'set', data);
    },
    create: (ref, data) => {
      const snap = getSnap(ref);
      if (snap.exists) throw new AlreadyExistsError();
      put(ref, 'set', data);
    },
    delete: (ref) => {
      getSnap(ref);
      put(ref, 'delete', null);
    },
    _reads: reads,
    _writes: writes
  };
}

async function runTransaction(store, fn) {
  const MAX_RETRIES = 25;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const tx = makeTx(store);

    // Phase 1: run the callback to discover which docs are touched.
    // Real Firestore returns whatever the callback resolves to.
    let result;
    try {
      result = await fn(tx);
    } catch (err) {
      if (err.code === 6) continue; // conflict during read → retry
      throw err;
    }

    const paths = Array.from(new Set([...tx._reads.keys(), ...tx._writes.keys()])).sort();

    // Phase 2: acquire every lock in a deterministic order.
    const acquired = [];
    let blocked = false;
    for (const p of paths) {
      if (held.has(p)) { blocked = true; break; }
    }
    if (blocked) {
      await new Promise((r) => setTimeout(r, 1));
      continue;
    }
    paths.forEach((p) => held.add(p));
    acquired.push(...paths);

    try {
      // Phase 3: re-validate reads under lock, then apply writes.
      for (const [path, snap] of tx._reads) {
        const col = path.split('/')[0];
        const current = store.data[col] && store.data[col][snap.id];
        const prev = snap._data ? JSON.stringify(snap._data) : null;
        const now = current ? JSON.stringify(current) : null;
        if (prev !== now) throw new ConflictError();
      }

      for (const [path, w] of tx._writes) {
        const col = path.split('/')[0];
        if (!store.data[col]) store.data[col] = {};
        const id = w.ref.id;
        if (w.type === 'delete') {
          delete store.data[col][id];
        } else if (w.type === 'set') {
          store.data[col][id] = { ...(store.data[col][id] || {}), ...w.data };
        } else {
          if (!store.data[col][id]) throw new ConflictError();
          store.data[col][id] = { ...store.data[col][id], ...w.data };
        }
      }
      return result;
    } catch (err) {
      if (err.code === 6) continue; // retry
      throw err;
    } finally {
      acquired.forEach((p) => held.delete(p));
    }
  }

  throw new ConflictError();
}

// ── Store factory ───────────────────────────────────────────────
function createStore(overrides) {
  const store = {
    data: JSON.parse(JSON.stringify({ ...seedData, ...(overrides || {}) })),
    collection(name) {
      return new CollectionRef(store, name);
    },
    FieldValue: {
      serverTimestamp: () => ({ __ts: true })
    },
    Timestamp: {
      fromMillis: (ms) => ({ __ms: ms })
    },
    runTransaction(fn) {
      return runTransaction(store, fn);
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) { ops.push(() => ref.set(data)); },
        update(ref, data) { ops.push(() => ref.update(data)); },
        delete(ref) { ops.push(() => ref.delete()); },
        async commit() {
          for (const op of ops) await op();
        }
      };
    }
  };
  return store;
}

// `withLock` is exported for a targeted concurrency test that needs to
// force two transactions to overlap.
module.exports = { createStore, DocSnap, ConflictError, AlreadyExistsError, withLock, seedData };

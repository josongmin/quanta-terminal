/**
 * Minimal in-memory IDB implementation for tests.
 *
 * jsdom does not ship `indexedDB`. Rather than pull in `fake-indexeddb` (a
 * 30KB dep just for tests), we implement the slice of the API we actually
 * use in `idb.ts`: open/upgrade, put/get/getAll/count/delete on a store and
 * a single index, plus key-range support. Everything runs synchronously and
 * is wrapped in `queueMicrotask` so the onsuccess/onerror callback order
 * mirrors real IDB enough to exercise our Promise adapters.
 *
 * This is a TEST HELPER. It is not shipped to the runtime; it lives under
 * `__mocks__/` so `tools/check-fsd-layers` recognizes it as such.
 */

import type { IdbFactoryLike } from '../idb.js';

type Key = IDBValidKey;

function cloneKeyPath(keyPath: string | string[]): string[] {
  return Array.isArray(keyPath) ? [...keyPath] : [keyPath];
}

function extractKey(value: unknown, keyPath: readonly string[]): Key {
  if (!value || typeof value !== 'object') {
    throw new Error('fake-idb: value is not an object');
  }
  const v = value as Record<string, unknown>;
  if (keyPath.length === 1) {
    const k = keyPath[0];
    if (k === undefined) throw new Error('fake-idb: empty key path');
    const part = v[k];
    if (part === undefined || part === null) {
      throw new Error(`fake-idb: missing key '${k}'`);
    }
    return part as Key;
  }
  const out: Key[] = [];
  for (const k of keyPath) {
    const part = v[k];
    if (part === undefined || part === null) {
      throw new Error(`fake-idb: missing key '${k}'`);
    }
    out.push(part as Key);
  }
  return out as Key;
}

function cmpKey(a: Key, b: Key): number {
  // IDBKeyRange allows arrays; we need lexicographic compare on arrays,
  // numeric/string compare on scalars.
  if (Array.isArray(a) && Array.isArray(b)) {
    const la = a.length;
    const lb = b.length;
    const n = Math.min(la, lb);
    for (let i = 0; i < n; i += 1) {
      const ai = a[i] as Key;
      const bi = b[i] as Key;
      const c = cmpKey(ai, bi);
      if (c !== 0) return c;
    }
    return la - lb;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function keyMatchesRange(key: Key, range: IDBKeyRange | undefined | null): boolean {
  if (!range) return true;
  if (range.lower !== undefined) {
    const c = cmpKey(key, range.lower as Key);
    if (c < 0) return false;
    if (c === 0 && range.lowerOpen) return false;
  }
  if (range.upper !== undefined) {
    const c = cmpKey(key, range.upper as Key);
    if (c > 0) return false;
    if (c === 0 && range.upperOpen) return false;
  }
  return true;
}

interface StoreDef {
  readonly name: string;
  readonly keyPath: string[];
  readonly indexes: Map<string, string[]>;
  records: Map<string, { key: Key; value: unknown }>;
}

interface DbState {
  readonly name: string;
  version: number;
  stores: Map<string, StoreDef>;
}

const databases = new Map<string, DbState>();

/** Reset the mock — clears every database. Call in `beforeEach`. */
export function resetFakeIdb(): void {
  databases.clear();
}

interface FakeRequest<T> extends Pick<IDBRequest<T>, 'result' | 'error'> {
  onsuccess: ((this: IDBRequest<T>, ev: Event) => void) | null;
  onerror: ((this: IDBRequest<T>, ev: Event) => void) | null;
}

function newRequest<T>(compute: () => T): FakeRequest<T> {
  const req = {
    result: undefined as T,
    error: null as DOMException | null,
    onsuccess: null as FakeRequest<T>['onsuccess'],
    onerror: null as FakeRequest<T>['onerror'],
  };
  queueMicrotask(() => {
    try {
      req.result = compute();
      req.onsuccess?.call(req as unknown as IDBRequest<T>, new Event('success'));
    } catch (err) {
      req.error = err as DOMException;
      req.onerror?.call(req as unknown as IDBRequest<T>, new Event('error'));
    }
  });
  return req;
}

function makeIndex(store: StoreDef, indexName: string): IDBIndex {
  const keyPath = store.indexes.get(indexName);
  if (!keyPath) throw new Error(`fake-idb: index '${indexName}' not found`);
  const idx: Partial<IDBIndex> = {
    name: indexName,
    getAll(range?: IDBKeyRange | Key | null) {
      return newRequest(() => {
        const rows: unknown[] = [];
        for (const { value } of store.records.values()) {
          const k = extractKey(value, keyPath);
          const r = rangeOrKeyToRange(range);
          if (keyMatchesRange(k, r)) rows.push(value);
        }
        // Sort by the index key ascending so callers that expect ordering get it.
        rows.sort((a, b) => cmpKey(extractKey(a, keyPath), extractKey(b, keyPath)));
        return rows;
      }) as unknown as IDBRequest<unknown[]>;
    },
    getAllKeys(range?: IDBKeyRange | Key | null) {
      return newRequest(() => {
        const rows: { key: Key; primary: Key }[] = [];
        for (const { key: primary, value } of store.records.values()) {
          const k = extractKey(value, keyPath);
          const r = rangeOrKeyToRange(range);
          if (keyMatchesRange(k, r)) rows.push({ key: k, primary });
        }
        rows.sort((a, b) => cmpKey(a.key, b.key));
        return rows.map((r) => r.primary);
      }) as unknown as IDBRequest<Key[]>;
    },
    count(range?: IDBKeyRange | Key | null) {
      return newRequest(() => {
        let n = 0;
        for (const { value } of store.records.values()) {
          const k = extractKey(value, keyPath);
          const r = rangeOrKeyToRange(range);
          if (keyMatchesRange(k, r)) n += 1;
        }
        return n;
      }) as unknown as IDBRequest<number>;
    },
  };
  return idx as IDBIndex;
}

function rangeOrKeyToRange(
  range: IDBKeyRange | Key | null | undefined,
): IDBKeyRange | undefined {
  if (range === undefined || range === null) return undefined;
  if (isKeyRange(range)) return range;
  return {
    lower: range,
    upper: range,
    lowerOpen: false,
    upperOpen: false,
    includes: () => true,
  } as IDBKeyRange;
}

function isKeyRange(v: unknown): v is IDBKeyRange {
  if (v === null || typeof v !== 'object') return false;
  const r = v as { lower?: unknown; upper?: unknown; lowerOpen?: unknown };
  return 'lower' in r || 'upper' in r || 'lowerOpen' in r;
}

function makeStore(store: StoreDef): IDBObjectStore {
  const os: Partial<IDBObjectStore> = {
    name: store.name,
    put(value: unknown) {
      return newRequest(() => {
        const key = extractKey(value, store.keyPath);
        store.records.set(serializeKey(key), { key, value });
        return key;
      }) as unknown as IDBRequest<IDBValidKey>;
    },
    get(keyOrRange: Key | IDBKeyRange) {
      return newRequest(() => {
        if (isKeyRange(keyOrRange)) {
          for (const entry of store.records.values()) {
            if (keyMatchesRange(entry.key, keyOrRange)) return entry.value;
          }
          return undefined;
        }
        return store.records.get(serializeKey(keyOrRange))?.value;
      }) as unknown as IDBRequest<unknown>;
    },
    delete(keyOrRange: Key | IDBKeyRange) {
      return newRequest(() => {
        if (isKeyRange(keyOrRange)) {
          for (const [k, entry] of [...store.records.entries()]) {
            if (keyMatchesRange(entry.key, keyOrRange)) store.records.delete(k);
          }
        } else {
          store.records.delete(serializeKey(keyOrRange));
        }
        return undefined;
      }) as unknown as IDBRequest<undefined>;
    },
    index(name: string) {
      return makeIndex(store, name);
    },
    createIndex(name: string, keyPath: string | string[]) {
      store.indexes.set(name, cloneKeyPath(keyPath));
      return makeIndex(store, name);
    },
  };
  return os as IDBObjectStore;
}

function serializeKey(key: Key): string {
  if (Array.isArray(key)) return key.map(serializeKey).join('|');
  return typeof key === 'number' ? `n:${key}` : `s:${String(key)}`;
}

function makeTransaction(
  dbState: DbState,
  storeNames: string | string[],
): IDBTransaction {
  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
  // Pending in-flight ops within the transaction. Each newRequest bumps this
  // before enqueuing its microtask and decrements in the callback. Real IDB
  // fires `oncomplete` only when every request in the tx has reported result/
  // error; we mirror that by waiting until the counter drops to zero via
  // `fireComplete` scheduled as a chain of microtasks.
  //
  // `awaitingOc` counts microtask ticks we've spent waiting for the caller
  // to set `tx.oncomplete` after every request has settled — protects
  // against an orphaned transaction spinning forever.
  const state = { pending: 0, scheduled: false, closed: false, awaitingOc: 0 };
  const tx: {
    oncomplete: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
    __tx_state: typeof state;
    objectStore(name: string): IDBObjectStore;
  } = {
    oncomplete: null,
    onerror: null,
    onabort: null,
    __tx_state: state,
    objectStore(name: string) {
      if (!names.includes(name)) {
        throw new Error(`fake-idb: store '${name}' not in transaction scope`);
      }
      const store = dbState.stores.get(name);
      if (!store) throw new Error(`fake-idb: store '${name}' missing`);
      return makeStoreForTx(store, state);
    },
  };
  // Schedule the first "drain check". It will either fire oncomplete
  // immediately (no ops queued — e.g. a browse-only transaction) or re-
  // schedule itself until all pending ops settle.
  scheduleDrain(tx);
  return tx as unknown as IDBTransaction;
}

function scheduleDrain(tx: { oncomplete: (() => void) | null; __tx_state: { pending: number; scheduled: boolean; closed: boolean; awaitingOc: number } }): void {
  if (tx.__tx_state.scheduled) return;
  tx.__tx_state.scheduled = true;
  queueMicrotask(() => {
    tx.__tx_state.scheduled = false;
    if (tx.__tx_state.closed) return;
    if (tx.__tx_state.pending > 0) {
      tx.__tx_state.awaitingOc = 0;
      // Keep polling — pending ops will decrement after their microtasks run.
      scheduleDrain(tx);
      return;
    }
    // All requests have settled. Fire oncomplete if the caller has wired it.
    // If not yet (caller is still chaining awaits on individual requests), we
    // need to wait until the caller gets around to setting it. We bound the
    // polling by `awaitingOc` ticks so a transaction that's truly abandoned
    // doesn't spin forever — 20 microtasks is plenty for the caller's next
    // `await` to land and set the handler.
    if (!tx.oncomplete) {
      tx.__tx_state.awaitingOc += 1;
      if (tx.__tx_state.awaitingOc < 20) {
        scheduleDrain(tx);
        return;
      }
    }
    tx.__tx_state.closed = true;
    tx.oncomplete?.();
  });
}

function makeStoreForTx(
  store: StoreDef,
  txState: { pending: number; scheduled: boolean; closed: boolean },
): IDBObjectStore {
  const bumpedNewRequest = <T>(compute: () => T): FakeRequest<T> => {
    txState.pending += 1;
    const req = {
      result: undefined as T,
      error: null as DOMException | null,
      onsuccess: null as FakeRequest<T>['onsuccess'],
      onerror: null as FakeRequest<T>['onerror'],
    };
    queueMicrotask(() => {
      try {
        req.result = compute();
        req.onsuccess?.call(req as unknown as IDBRequest<T>, new Event('success'));
      } catch (err) {
        req.error = err as DOMException;
        req.onerror?.call(req as unknown as IDBRequest<T>, new Event('error'));
      } finally {
        txState.pending -= 1;
      }
    });
    return req;
  };

  const os: Partial<IDBObjectStore> = {
    name: store.name,
    put(value: unknown) {
      return bumpedNewRequest(() => {
        const key = extractKey(value, store.keyPath);
        store.records.set(serializeKey(key), { key, value });
        return key;
      }) as unknown as IDBRequest<IDBValidKey>;
    },
    get(keyOrRange: Key | IDBKeyRange) {
      return bumpedNewRequest(() => {
        if (isKeyRange(keyOrRange)) {
          for (const entry of store.records.values()) {
            if (keyMatchesRange(entry.key, keyOrRange)) return entry.value;
          }
          return undefined;
        }
        return store.records.get(serializeKey(keyOrRange))?.value;
      }) as unknown as IDBRequest<unknown>;
    },
    delete(keyOrRange: Key | IDBKeyRange) {
      return bumpedNewRequest(() => {
        if (isKeyRange(keyOrRange)) {
          for (const [k, entry] of [...store.records.entries()]) {
            if (keyMatchesRange(entry.key, keyOrRange)) store.records.delete(k);
          }
        } else {
          store.records.delete(serializeKey(keyOrRange));
        }
        return undefined;
      }) as unknown as IDBRequest<undefined>;
    },
    index(name: string) {
      return makeIndexForTx(store, name, txState);
    },
    createIndex(name: string, keyPath: string | string[]) {
      store.indexes.set(name, cloneKeyPath(keyPath));
      return makeIndexForTx(store, name, txState);
    },
  };
  return os as IDBObjectStore;
}

function makeIndexForTx(
  store: StoreDef,
  indexName: string,
  txState: { pending: number; scheduled: boolean; closed: boolean },
): IDBIndex {
  const keyPath = store.indexes.get(indexName);
  if (!keyPath) throw new Error(`fake-idb: index '${indexName}' not found`);

  const bumpedNewRequest = <T>(compute: () => T): FakeRequest<T> => {
    txState.pending += 1;
    const req = {
      result: undefined as T,
      error: null as DOMException | null,
      onsuccess: null as FakeRequest<T>['onsuccess'],
      onerror: null as FakeRequest<T>['onerror'],
    };
    queueMicrotask(() => {
      try {
        req.result = compute();
        req.onsuccess?.call(req as unknown as IDBRequest<T>, new Event('success'));
      } catch (err) {
        req.error = err as DOMException;
        req.onerror?.call(req as unknown as IDBRequest<T>, new Event('error'));
      } finally {
        txState.pending -= 1;
      }
    });
    return req;
  };

  const idx: Partial<IDBIndex> = {
    name: indexName,
    getAll(range?: IDBKeyRange | Key | null) {
      return bumpedNewRequest(() => {
        const rows: unknown[] = [];
        for (const { value } of store.records.values()) {
          const k = extractKey(value, keyPath);
          const r = rangeOrKeyToRange(range);
          if (keyMatchesRange(k, r)) rows.push(value);
        }
        rows.sort((a, b) => cmpKey(extractKey(a, keyPath), extractKey(b, keyPath)));
        return rows;
      }) as unknown as IDBRequest<unknown[]>;
    },
    getAllKeys(range?: IDBKeyRange | Key | null) {
      return bumpedNewRequest(() => {
        const rows: { key: Key; primary: Key }[] = [];
        for (const { key: primary, value } of store.records.values()) {
          const k = extractKey(value, keyPath);
          const r = rangeOrKeyToRange(range);
          if (keyMatchesRange(k, r)) rows.push({ key: k, primary });
        }
        rows.sort((a, b) => cmpKey(a.key, b.key));
        return rows.map((r) => r.primary);
      }) as unknown as IDBRequest<Key[]>;
    },
    count(range?: IDBKeyRange | Key | null) {
      return bumpedNewRequest(() => {
        let n = 0;
        for (const { value } of store.records.values()) {
          const k = extractKey(value, keyPath);
          const r = rangeOrKeyToRange(range);
          if (keyMatchesRange(k, r)) n += 1;
        }
        return n;
      }) as unknown as IDBRequest<number>;
    },
  };
  return idx as IDBIndex;
}

function makeDatabase(dbState: DbState): IDBDatabase {
  const db: Partial<IDBDatabase> = {
    name: dbState.name,
    version: dbState.version,
    objectStoreNames: {
      length: dbState.stores.size,
      item: () => null,
      contains: (n: string) => dbState.stores.has(n),
    } as unknown as DOMStringList,
    transaction(storeNames: string | string[]) {
      return makeTransaction(dbState, storeNames);
    },
    close() {
      /* no-op in the mock */
    },
    createObjectStore(name: string, opts?: IDBObjectStoreParameters) {
      const keyPath = cloneKeyPath((opts?.keyPath ?? '') as string | string[]);
      const def: StoreDef = {
        name,
        keyPath,
        indexes: new Map(),
        records: new Map(),
      };
      dbState.stores.set(name, def);
      return makeStore(def);
    },
  };
  return db as IDBDatabase;
}

/** The fake factory. Satisfies `IdbFactoryLike`. */
export const fakeIdbFactory: IdbFactoryLike = {
  open(name: string, version: number): IDBOpenDBRequest {
    let dbState = databases.get(name);
    const oldVersion = dbState?.version ?? 0;
    if (!dbState) {
      dbState = { name, version, stores: new Map() };
      databases.set(name, dbState);
    }
    dbState.version = version;

    interface OpenReqShape {
      result: IDBDatabase | undefined;
      error: DOMException | null;
      onupgradeneeded: ((this: IDBRequest, ev: IDBVersionChangeEvent) => void) | null;
      onsuccess: ((this: IDBRequest, ev: Event) => void) | null;
      onerror: ((this: IDBRequest, ev: Event) => void) | null;
      onblocked: ((this: IDBRequest, ev: Event) => void) | null;
    }
    const req: OpenReqShape = {
      result: undefined,
      error: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };

    queueMicrotask(() => {
      try {
        const db = makeDatabase(dbState);
        req.result = db;
        if (version > oldVersion && req.onupgradeneeded) {
          const event = { oldVersion, newVersion: version } as unknown as IDBVersionChangeEvent;
          req.onupgradeneeded.call(req as unknown as IDBRequest, event);
        }
        req.onsuccess?.call(req as unknown as IDBRequest, new Event('success'));
      } catch (err) {
        req.error = err as DOMException;
        req.onerror?.call(req as unknown as IDBRequest, new Event('error'));
      }
    });

    return req as unknown as IDBOpenDBRequest;
  },
};

/** Build a key-range helper that works against the mock. Mirrors
 *  `IDBKeyRange` without requiring the global to exist. */
export const fakeKeyRange = {
  bound(lower: Key, upper: Key, lowerOpen = false, upperOpen = false): IDBKeyRange {
    return {
      lower,
      upper,
      lowerOpen,
      upperOpen,
      includes: (k: Key) => keyMatchesRange(k, this.bound(lower, upper, lowerOpen, upperOpen)),
    } as IDBKeyRange;
  },
  only(value: Key): IDBKeyRange {
    return {
      lower: value,
      upper: value,
      lowerOpen: false,
      upperOpen: false,
      includes: (k: Key) => cmpKey(k, value) === 0,
    } as IDBKeyRange;
  },
};

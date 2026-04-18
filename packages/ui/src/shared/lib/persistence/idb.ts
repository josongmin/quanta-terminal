/**
 * IndexedDB wrapper — a thin typed shell around the browser's native IDB.
 *
 * Phase 4 scope (ADR 0013 stand-in): this is the frontend-only persistence
 * substrate for command blocks. When the core-socket bridge ships, block
 * persistence migrates to the sidecar's event log; this wrapper survives as
 * the cache / offline fallback for volatile state that doesn't belong in the
 * server-owned log (e.g. UI-local preferences, dismissed banners).
 *
 * Design notes
 * ------------
 * - NO dependency on `idb` / `dexie`. We promisify the raw IDBRequest API in
 *   one place so the rest of the app speaks Promises.
 * - Schema is versioned via a single `onupgradeneeded` migrator. The migrator
 *   receives the current and target versions so future migrations can be
 *   chained without rewriting the whole function.
 * - Tests run in jsdom, which does NOT provide `indexedDB` by default. We
 *   expose an `openDatabase` that takes an optional `factory` so tests can
 *   inject the in-memory mock shipped at `./__mocks__/fake-idb.ts`.
 */

export interface IdbIndexSpec {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly unique?: boolean;
  readonly multiEntry?: boolean;
}

export interface IdbStoreSpec {
  readonly name: string;
  readonly keyPath: string | readonly string[];
  readonly autoIncrement?: boolean;
  readonly indexes?: readonly IdbIndexSpec[];
}

export interface IdbSchema {
  readonly name: string;
  readonly version: number;
  readonly stores: readonly IdbStoreSpec[];
}

/**
 * Minimal structural interface for the IDB factory. Matches the shape of the
 * global `indexedDB` and the in-memory mock used in tests. Kept narrow so the
 * mock surface stays small.
 */
export interface IdbFactoryLike {
  open(name: string, version: number): IDBOpenDBRequest;
}

/** Returned by `openDatabase` — a tiny façade over `IDBDatabase`. */
export interface IdbHandle {
  readonly db: IDBDatabase;
  close(): void;
}

/**
 * Open (or create) a database. Runs the migrator on upgrade — it compares
 * `event.oldVersion` against the schema and creates missing stores. Existing
 * stores are left intact to preserve user data across schema bumps.
 *
 * `factory` defaults to `globalThis.indexedDB`. Tests inject the fake factory
 * from `./__mocks__/fake-idb.ts`.
 */
export function openDatabase(
  schema: IdbSchema,
  factory?: IdbFactoryLike,
): Promise<IdbHandle> {
  const resolved = factory ?? getGlobalFactory();
  return new Promise<IdbHandle>((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = resolved.open(schema.name, schema.version);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of schema.stores) {
        if (db.objectStoreNames.contains(store.name)) continue;
        const os = db.createObjectStore(store.name, {
          keyPath: mutableKeyPath(store.keyPath),
          ...(store.autoIncrement ? { autoIncrement: true } : {}),
        });
        if (store.indexes) {
          for (const idx of store.indexes) {
            os.createIndex(idx.name, mutableKeyPath(idx.keyPath), {
              unique: idx.unique ?? false,
              multiEntry: idx.multiEntry ?? false,
            });
          }
        }
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      resolve({ db, close: () => db.close() });
    };
    req.onerror = () => reject(req.error ?? new Error('idb: open failed'));
    req.onblocked = () => reject(new Error('idb: open blocked by another connection'));
  });
}

/** IDBDatabase.createObjectStore refuses readonly arrays; accept either and
 *  copy so the caller's const array survives. */
function mutableKeyPath(path: string | readonly string[]): string | string[] {
  return typeof path === 'string' ? path : [...path];
}

function getGlobalFactory(): IdbFactoryLike {
  const g = globalThis as typeof globalThis & { indexedDB?: IdbFactoryLike };
  if (!g.indexedDB) {
    throw new Error(
      'idb: no IndexedDB factory available (neither globalThis.indexedDB nor an explicit factory). ' +
        'Pass a factory (see shared/lib/persistence/__mocks__/fake-idb.ts) in tests.',
    );
  }
  return g.indexedDB;
}

/** Promisify a single IDBRequest. */
export function awaitRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('idb: request failed'));
  });
}

/** Promisify a transaction's completion. */
export function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('idb: transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('idb: transaction aborted'));
  });
}

export async function putRecord<T>(
  handle: IdbHandle,
  storeName: string,
  value: T,
): Promise<void> {
  const tx = handle.db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  store.put(value);
  await awaitTransaction(tx);
}

export async function putRecords<T>(
  handle: IdbHandle,
  storeName: string,
  values: readonly T[],
): Promise<void> {
  if (values.length === 0) return;
  const tx = handle.db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const v of values) store.put(v);
  await awaitTransaction(tx);
}

export async function getRecord<T>(
  handle: IdbHandle,
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  const tx = handle.db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const result = await awaitRequest(store.get(key));
  await awaitTransaction(tx);
  return result as T | undefined;
}

export async function getAllFromIndex<T>(
  handle: IdbHandle,
  storeName: string,
  indexName: string,
  range: IDBKeyRange,
): Promise<readonly T[]> {
  const tx = handle.db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const index = store.index(indexName);
  const all = await awaitRequest(index.getAll(range));
  await awaitTransaction(tx);
  return (all as T[]) ?? [];
}

export async function deleteRecord(
  handle: IdbHandle,
  storeName: string,
  key: IDBValidKey,
): Promise<void> {
  const tx = handle.db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  store.delete(key);
  await awaitTransaction(tx);
}

export async function deleteRange(
  handle: IdbHandle,
  storeName: string,
  indexName: string,
  range: IDBKeyRange,
): Promise<number> {
  const tx = handle.db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  const index = store.index(indexName);
  const keys = (await awaitRequest(index.getAllKeys(range))) as IDBValidKey[];
  for (const k of keys) store.delete(k);
  await awaitTransaction(tx);
  return keys.length;
}

export async function countInIndex(
  handle: IdbHandle,
  storeName: string,
  indexName: string,
  range: IDBKeyRange,
): Promise<number> {
  const tx = handle.db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const index = store.index(indexName);
  const n = await awaitRequest(index.count(range));
  await awaitTransaction(tx);
  return n;
}

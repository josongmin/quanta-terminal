/**
 * IDB adapter for workspace snapshots.
 *
 * Dedicated database (separate from `quanta-blocks`) so the two concerns
 * remain independent: clearing history must not delete saved snapshots, and a
 * future snapshot schema bump can be versioned without touching blocks.
 */

import {
  openDatabase,
  putRecord,
  getAllFromIndex,
  deleteRecord,
  type IdbHandle,
  type IdbSchema,
  type IdbFactoryLike,
} from '../../shared/lib/persistence/index.js';
import type { WorkspaceSnapshot } from './model.js';
import { validateSnapshot } from './serialize.js';

export const SNAPSHOT_DB_NAME = 'quanta-workspace-snapshots';
export const SNAPSHOT_DB_VERSION = 1;
export const SNAPSHOT_STORE_NAME = 'workspace-snapshots';

export const SNAPSHOT_DB_SCHEMA: IdbSchema = {
  name: SNAPSHOT_DB_NAME,
  version: SNAPSHOT_DB_VERSION,
  stores: [
    {
      name: SNAPSHOT_STORE_NAME,
      keyPath: 'id',
      indexes: [{ name: 'byCreatedAt', keyPath: 'createdAt' }],
    },
  ],
};

export interface SnapshotAdapter {
  save(snapshot: WorkspaceSnapshot): Promise<void>;
  loadAll(): Promise<readonly WorkspaceSnapshot[]>;
  deleteOne(id: string): Promise<void>;
}

interface IdbAdapterOptions {
  readonly factory?: IdbFactoryLike;
  readonly handle?: IdbHandle;
}

export function createIdbSnapshotAdapter(opts: IdbAdapterOptions = {}): SnapshotAdapter {
  let handleP: Promise<IdbHandle> | null = opts.handle ? Promise.resolve(opts.handle) : null;
  const getHandle = (): Promise<IdbHandle> => {
    if (!handleP) {
      handleP = openDatabase(SNAPSHOT_DB_SCHEMA, opts.factory).catch((err) => {
        handleP = null;
        throw err;
      });
    }
    return handleP;
  };

  return {
    async save(snapshot) {
      const h = await getHandle();
      // Serialize the activeTags Set to an array is handled upstream already —
      // the WorkspaceSnapshot shape uses `readonly string[]`. IDB's structured
      // clone happily round-trips plain arrays and nested objects.
      await putRecord<WorkspaceSnapshot>(h, SNAPSHOT_STORE_NAME, snapshot);
    },
    async loadAll() {
      const h = await getHandle();
      // No workspace scoping for snapshots yet — the snapshot identity is its
      // own id, and a single workspace fingerprint isn't baked into the row.
      // We index by createdAt to read newest-first in memory.
      const range = buildFullRange();
      const rows = await getAllFromIndex<unknown>(
        h,
        SNAPSHOT_STORE_NAME,
        'byCreatedAt',
        range,
      );
      const validated: WorkspaceSnapshot[] = [];
      for (const row of rows) {
        const snap = validateSnapshot(row);
        if (snap === null) {
          console.warn('[workspace-snapshot] Skipping corrupt or invalid snapshot entry:', row);
        } else {
          validated.push(snap);
        }
      }
      return validated;
    },
    async deleteOne(id) {
      const h = await getHandle();
      await deleteRecord(h, SNAPSHOT_STORE_NAME, id);
    },
  };
}

/**
 * Build a `IDBKeyRange.lowerBound(0)` range that matches every row. Falls back
 * to a structural range object for the fake-idb mock used in tests.
 */
function buildFullRange(): IDBKeyRange {
  const g = globalThis as typeof globalThis & {
    IDBKeyRange?: { lowerBound(v: IDBValidKey): IDBKeyRange };
  };
  if (g.IDBKeyRange && typeof g.IDBKeyRange.lowerBound === 'function') {
    return g.IDBKeyRange.lowerBound(0);
  }
  return {
    lower: 0,
    upper: Number.MAX_SAFE_INTEGER,
    lowerOpen: false,
    upperOpen: false,
    includes: () => true,
  } as IDBKeyRange;
}

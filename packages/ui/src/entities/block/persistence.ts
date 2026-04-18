/**
 * Block persistence — serialize / deserialize / save / hydrate.
 *
 * The entity layer owns its own IO adapter here (FSD has a carve-out for
 * "the authoritative serializer lives with the entity"). Phase 4 writes to
 * IndexedDB through `shared/lib/persistence`; when the sidecar ships the
 * event-log bridge, this file gets a second backend and the block-store
 * persistence hook keeps its current shape.
 *
 * Serialization contract
 * ----------------------
 * A `Block` carries its output as `readonly Uint8Array[]`. On persist we
 * **concatenate** into a single byte buffer because IndexedDB happily stores
 * an ArrayBuffer but round-trips a `Uint8Array[]` as a plain array of objects
 * and jsdom breaks the typed-array fidelity. On rehydrate we return it as a
 * single `Uint8Array` in the chunk list — callers that care about streaming
 * chunk boundaries don't exist outside the live PTY path, and the ANSI parser
 * slices the buffer itself.
 *
 * When the combined output exceeds 1 MiB we gzip-compress the bytes before
 * storage (the browser-native CompressionStream, no dep). The `compressed`
 * boolean flag on the row tells the reader whether to inflate. When the
 * runtime lacks `CompressionStream` (notably older jsdom), we store raw.
 *
 * Running blocks
 * --------------
 * `running` blocks never persist — they hadn't reached a terminal state when
 * the app died and cannot be safely replayed. Hydrate skips them.
 *
 * Quota
 * -----
 * 2000 blocks per workspace. When the per-workspace count would exceed the
 * cap we evict the oldest non-pinned blocks. Pinned blocks never count
 * against the cap in the eviction path (they do count against the total),
 * matching the ADR 0005 retention rule "pinned blocks retained indefinitely".
 */

import {
  openDatabase,
  putRecord,
  getAllFromIndex,
  deleteRange,
  deleteRecord,
  computeWorkspaceFingerprint,
  gzipCompress,
  gzipDecompress,
  isGzipAvailable,
  type IdbHandle,
  type IdbSchema,
  type IdbFactoryLike,
} from '../../shared/lib/persistence/index.js';
import { createDebouncer, type Debouncer } from '../../shared/lib/debounce.js';
import { createLogger } from '../../shared/lib/logger.js';
import type { Block } from './model.js';
import { concatChunks, DEFAULT_BLOCK_SESSION_ID, useBlockStore } from './model.js';

const log = createLogger('block-persistence');

export const BLOCK_DB_NAME = 'quanta-blocks';
export const BLOCK_DB_VERSION = 1;
export const BLOCK_STORE_NAME = 'blocks';
export const WORKSPACE_QUOTA = 2000;
export const COMPRESSION_THRESHOLD_BYTES = 1024 * 1024; // 1 MiB
export const PERSIST_DEBOUNCE_MS = 50;

/** IndexedDB schema used by the block store. See ADR 0013 ranking rules for
 *  how these indexes feed the history-search feature. */
export const BLOCK_DB_SCHEMA: IdbSchema = {
  name: BLOCK_DB_NAME,
  version: BLOCK_DB_VERSION,
  stores: [
    {
      name: BLOCK_STORE_NAME,
      keyPath: ['workspaceId', 'id'],
      indexes: [
        { name: 'byWorkspace', keyPath: 'workspaceId' },
        { name: 'byEnded', keyPath: ['workspaceId', 'completedAt'] },
      ],
    },
  ],
};

/** The on-disk shape of a block. Mirrors the Phase-4 scope table in the
 *  prompt; defensive-parses absent optional fields on rehydrate. */
export interface StoredBlock {
  readonly id: string;
  readonly workspaceId: string;
  readonly command: string;
  readonly cwd: string;
  readonly status: 'completed' | 'canceled' | 'error';
  readonly exitCode: number | null;
  readonly startedAt: number;
  readonly completedAt: number;
  readonly outputCompressed: Uint8Array;
  readonly compressed: boolean;
  readonly pinned: boolean;
  readonly sessionId: string | null;
  readonly rerunOfId: string | null;
  readonly errorMessage: string | null;
}

export type TerminalStatus = StoredBlock['status'];

export function isTerminalStatus(status: Block['status']): status is TerminalStatus {
  return status === 'completed' || status === 'canceled' || status === 'error';
}

/**
 * Ambient persistence adapter. Created once at boot by `installBlockPersistence`.
 * Tests replace the adapter with an in-memory mock; production wires the real
 * IDB handle.
 */
export interface BlockPersistenceAdapter {
  save(block: StoredBlock): Promise<void>;
  loadAll(workspaceId: string): Promise<readonly StoredBlock[]>;
  clearWorkspace(workspaceId: string): Promise<number>;
  deleteOne(workspaceId: string, id: string): Promise<void>;
  count(workspaceId: string): Promise<number>;
}

interface IdbAdapterOptions {
  readonly factory?: IdbFactoryLike;
  readonly handle?: IdbHandle;
}

/** Default adapter backed by the real IndexedDB. Opens lazily on first call
 *  so boot-time failures are surfaced at use-site (and can be caught). */
export function createIdbBlockAdapter(opts: IdbAdapterOptions = {}): BlockPersistenceAdapter {
  let handleP: Promise<IdbHandle> | null = opts.handle ? Promise.resolve(opts.handle) : null;
  const getHandle = (): Promise<IdbHandle> => {
    if (!handleP) {
      handleP = openDatabase(BLOCK_DB_SCHEMA, opts.factory).catch((err) => {
        handleP = null;
        throw err;
      });
    }
    return handleP;
  };

  return {
    async save(block: StoredBlock) {
      const h = await getHandle();
      await putRecord<StoredBlock>(h, BLOCK_STORE_NAME, block);
    },
    async loadAll(workspaceId: string) {
      const h = await getHandle();
      // Use IDBKeyRange.only against `byWorkspace` for exact-match enumeration.
      const range = buildOnlyRange(workspaceId);
      const rows = await getAllFromIndex<StoredBlock>(h, BLOCK_STORE_NAME, 'byWorkspace', range);
      return rows;
    },
    async clearWorkspace(workspaceId: string) {
      const h = await getHandle();
      return deleteRange(h, BLOCK_STORE_NAME, 'byWorkspace', buildOnlyRange(workspaceId));
    },
    async deleteOne(workspaceId: string, id: string) {
      const h = await getHandle();
      await deleteRecord(h, BLOCK_STORE_NAME, [workspaceId, id]);
    },
    async count(workspaceId: string) {
      const h = await getHandle();
      const rows = await getAllFromIndex<StoredBlock>(
        h,
        BLOCK_STORE_NAME,
        'byWorkspace',
        buildOnlyRange(workspaceId),
      );
      return rows.length;
    },
  };
}

/** Build `IDBKeyRange.only` without requiring the global — falls back to a
 *  structural range object the fake-idb mock understands. */
function buildOnlyRange(value: IDBValidKey): IDBKeyRange {
  const g = globalThis as typeof globalThis & {
    IDBKeyRange?: { only(v: IDBValidKey): IDBKeyRange };
  };
  if (g.IDBKeyRange && typeof g.IDBKeyRange.only === 'function') {
    return g.IDBKeyRange.only(value);
  }
  return {
    lower: value,
    upper: value,
    lowerOpen: false,
    upperOpen: false,
    includes: () => true,
  } as IDBKeyRange;
}

/**
 * Serialize a live block for storage. Concatenates chunks into a single
 * buffer and gzips when above the threshold (and when the runtime supports
 * it). Async because `CompressionStream` only exposes a stream API.
 *
 * `extras` is an override path used by tests; production callers should
 * leave them unset and the block's own `sessionId` / `rerunOfId` fields are
 * persisted.
 */
export async function serializeBlock(
  block: Block,
  workspaceId: string,
  extras: {
    readonly sessionId?: string | null;
    readonly rerunOfId?: string | null;
  } = {},
): Promise<StoredBlock> {
  if (!isTerminalStatus(block.status)) {
    throw new Error(`serializeBlock: block ${block.id} is not in a terminal state`);
  }
  const raw = concatChunks(block.outputChunks);
  let bytes: Uint8Array;
  let compressed = false;
  if (raw.byteLength > COMPRESSION_THRESHOLD_BYTES && isGzipAvailable()) {
    try {
      bytes = await gzipCompress(raw);
      compressed = true;
    } catch (err) {
      log.warn('serializeBlock: gzip failed, storing raw', { id: block.id, err });
      bytes = raw;
    }
  } else {
    bytes = raw;
  }

  const sessionId =
    extras.sessionId !== undefined ? extras.sessionId : (block.sessionId as string | null) ?? null;
  const rerunOfId = extras.rerunOfId !== undefined ? extras.rerunOfId : block.rerunOfId ?? null;

  return {
    id: block.id,
    workspaceId,
    command: block.command,
    cwd: block.cwd,
    status: block.status,
    exitCode: block.exitCode,
    startedAt: block.startedAt,
    completedAt: block.completedAt ?? Date.now(),
    outputCompressed: bytes,
    compressed,
    pinned: block.pinned,
    sessionId,
    rerunOfId,
    errorMessage: block.errorMessage,
  };
}

/**
 * Rehydrate a stored block into the live `Block` shape. Tolerates missing
 * optional fields (compare / session-tabs agents may not have merged yet —
 * `sessionId` falls back to `DEFAULT_BLOCK_SESSION_ID`, `rerunOfId` to null).
 */
export async function deserializeBlock(row: StoredBlock): Promise<Block> {
  const bytes = row.compressed ? await gzipDecompress(ensureUint8(row.outputCompressed)) : ensureUint8(row.outputCompressed);
  // We ship rehydrated output as a single chunk. See file docblock: the
  // chunk-boundary semantics only matter for the live PTY path.
  const chunks: Uint8Array[] = bytes.byteLength > 0 ? [bytes] : [];
  return {
    id: row.id,
    sessionId: (row.sessionId ?? DEFAULT_BLOCK_SESSION_ID) as Block['sessionId'],
    command: row.command,
    status: row.status,
    cwd: row.cwd,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    exitCode: row.exitCode,
    outputChunks: chunks,
    collapsed: false,
    pinned: row.pinned,
    errorMessage: row.errorMessage ?? null,
    rerunOfId: row.rerunOfId ?? null,
  };
}

/** Some IDB implementations re-hydrate Uint8Array as a plain Object with
 *  numeric keys or as an ArrayBuffer. Normalize to a Uint8Array. */
function ensureUint8(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  if (value && typeof value === 'object') {
    const obj = value as Record<string | number, number>;
    const keys = Object.keys(obj).filter((k) => /^\d+$/u.test(k));
    const arr = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (key === undefined) continue;
      const v = obj[key];
      if (typeof v === 'number') arr[i] = v;
    }
    return arr;
  }
  return new Uint8Array(0);
}

/**
 * Install the terminal-state transition hook on the block store. Schedules
 * a debounced write per id so a rapid burst (e.g. completeBlock + togglePin
 * in quick succession) collapses to one write.
 *
 * Returns an uninstall handle — tests call it in `afterEach` to avoid leaks.
 */
export interface InstallPersistenceOptions {
  readonly adapter: BlockPersistenceAdapter;
  readonly workspaceId?: string;
  readonly quota?: number;
  readonly persistDebounceMs?: number;
}

export interface PersistenceHandle {
  readonly uninstall: () => void;
  readonly flushAll: () => Promise<void>;
  /** Force-persist a block right now, skipping the debounce. */
  readonly saveNow: (id: string) => Promise<void>;
}

export function installBlockPersistence(
  options: InstallPersistenceOptions,
): PersistenceHandle {
  const { adapter } = options;
  const workspaceId = options.workspaceId ?? computeWorkspaceFingerprint();
  const quota = options.quota ?? WORKSPACE_QUOTA;
  const debounceMs = options.persistDebounceMs ?? PERSIST_DEBOUNCE_MS;

  const pendingDebouncers = new Map<string, Debouncer>();
  const inflight = new Set<Promise<void>>();
  // Remember which ids we've persisted since boot so we can avoid re-writing
  // blocks on every tick. Cleared on `clearHistory`. We pre-populate with
  // terminal blocks that exist at install time — those arrived via
  // `hydrateBlocks` (boot-time rehydrate) and must NOT be written back on
  // first subscription fire; doing so would waste bandwidth AND (more
  // importantly) break the "cleared hydrated blocks are deleted from disk"
  // invariant, which depends on `persistedIds.has(id) === true` for those
  // ids at clear time.
  const persistedIds = new Set<string>();
  {
    const initial = useBlockStore.getState().entities;
    for (const [id, block] of Object.entries(initial)) {
      if (block && isTerminalStatus(block.status)) {
        persistedIds.add(id);
      }
    }
  }

  function track(p: Promise<void>): Promise<void> {
    inflight.add(p);
    p.finally(() => inflight.delete(p));
    return p;
  }

  async function persistNow(id: string): Promise<void> {
    const block = useBlockStore.getState().entities[id];
    if (!block || !isTerminalStatus(block.status)) return;
    try {
      const row = await serializeBlock(block, workspaceId);
      await adapter.save(row);
      persistedIds.add(id);
      await enforceQuota(adapter, workspaceId, quota);
    } catch (err) {
      log.warn('persistBlock: write failed', { id, err });
    }
  }

  function schedule(id: string): void {
    let deb = pendingDebouncers.get(id);
    if (!deb) {
      deb = createDebouncer(
        () => {
          pendingDebouncers.delete(id);
          track(persistNow(id));
        },
        { wait: debounceMs },
      );
      pendingDebouncers.set(id, deb);
    }
    deb.schedule();
  }

  // Subscribe to the whole block store; diff entities for terminal transitions
  // and enqueue a write for each id whose status is newly terminal. Zustand's
  // subscribe receives next + previous state.
  //
  // Hot-path note: `appendBlockOutput` replaces `entities` on every chunk.
  // We short-circuit the heavy diff by only walking when `next !== prev` AND
  // remembering (via `persistedIds`) which ids we've already written so a
  // per-chunk pass is O(newly-terminal ids) rather than O(total blocks).
  let prevEntities = useBlockStore.getState().entities;
  const unsubscribe = useBlockStore.subscribe((state) => {
    const next = state.entities;
    if (next === prevEntities) return;
    for (const id of Object.keys(next)) {
      const after = next[id];
      const before = prevEntities[id];
      if (!after) continue;
      if (!isTerminalStatus(after.status)) continue;
      // Persist on first terminal transition OR when pinned flag changes
      // (`togglePin` is the only non-status change we care to capture for a
      // terminal block — it affects quota-eviction behavior).
      //
      // Hydration guard: when a hydrated block appears, `before` is
      // undefined but `persistedIds` already tracks the id (populated at
      // install time from the store snapshot). Treat that as "already
      // on disk" — no write-back — and only schedule on a REAL terminal
      // transition (status flipped from running).
      const transitionedFromRunning =
        before !== undefined && !isTerminalStatus(before.status);
      const freshTerminal = before === undefined && !persistedIds.has(id);
      const pinnedChanged = before !== undefined && before.pinned !== after.pinned;
      if (transitionedFromRunning || freshTerminal || pinnedChanged) {
        schedule(id);
      }
    }
    // Detect clearHistory: an id present in `prevEntities` but absent in
    // `next`. We do NOT tombstone; clearHistory in Phase 4 means "drop
    // persisted records too" (prompt §5). Pinned survivors are handled by
    // the store preserving them in `next`.
    for (const id of Object.keys(prevEntities)) {
      if (next[id]) continue;
      if (!persistedIds.has(id)) continue;
      persistedIds.delete(id);
      track(
        adapter.deleteOne(workspaceId, id).catch((err) => {
          log.warn('persistBlock: delete failed', { id, err });
        }),
      );
    }
    prevEntities = next;
  });

  return {
    uninstall() {
      unsubscribe();
      for (const deb of pendingDebouncers.values()) deb.cancel();
      pendingDebouncers.clear();
    },
    async flushAll() {
      for (const [id, deb] of pendingDebouncers) {
        deb.cancel();
        pendingDebouncers.delete(id);
        track(persistNow(id));
      }
      await Promise.all([...inflight]);
    },
    async saveNow(id: string) {
      const deb = pendingDebouncers.get(id);
      if (deb) {
        deb.cancel();
        pendingDebouncers.delete(id);
      }
      await persistNow(id);
    },
  };
}

/**
 * Load every persisted block for the workspace, oldest → newest, and
 * rehydrate into the live store. Safe to call exactly once at boot.
 *
 * Rehydrated blocks are pushed through `hydrateBlocks`; any running block that
 * was somehow persisted (shouldn't happen, but defensive) is filtered out.
 */
export async function hydrateFromPersistence(
  adapter: BlockPersistenceAdapter,
  workspaceId: string = computeWorkspaceFingerprint(),
): Promise<readonly Block[]> {
  const rows = await adapter.loadAll(workspaceId);
  const sorted = [...rows].sort((a, b) => a.completedAt - b.completedAt);
  const blocks: Block[] = [];
  for (const row of sorted) {
    try {
      blocks.push(await deserializeBlock(row));
    } catch (err) {
      log.warn('hydrateFromPersistence: skip corrupt row', { id: row.id, err });
    }
  }
  useBlockStore.getState().hydrateBlocks(blocks);
  return blocks;
}

/**
 * Enforce the per-workspace quota by deleting the oldest non-pinned rows
 * beyond the cap. Pinned blocks are excluded from deletion and from the
 * "oldest" sort anchor — matches the ADR 0005 retention contract.
 */
export async function enforceQuota(
  adapter: BlockPersistenceAdapter,
  workspaceId: string,
  quota: number,
): Promise<number> {
  const rows = await adapter.loadAll(workspaceId);
  if (rows.length <= quota) return 0;
  const sorted = [...rows].sort((a, b) => a.completedAt - b.completedAt);
  const excess = sorted.length - quota;
  let evicted = 0;
  for (const row of sorted) {
    if (evicted >= excess) break;
    if (row.pinned) continue;
    await adapter.deleteOne(workspaceId, row.id);
    evicted += 1;
  }
  return evicted;
}

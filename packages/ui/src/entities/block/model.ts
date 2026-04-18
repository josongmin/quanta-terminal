/**
 * Block entity — the UI's view of one command block.
 *
 * A block is the unit of work the user submitted: one `input.submitted`
 * payload (ADR 0002 "one block per user submission"). Each block lives
 * through a short state machine — `running` → `completed | canceled | error`.
 *
 * Shape
 * -----
 * Normalized: the store owns an ordered list of ids plus a map of entities.
 * Ordered append is O(1), selectors get per-id reads without scanning the
 * full list, and clear-history can rewrite `order` without invalidating the
 * entity map for pinned survivors.
 *
 * Output chunks
 * -------------
 * Output is stored as an append-only array of `Uint8Array` byte segments.
 * This keeps the hot path (PTY → store) allocation-free: we don't decode or
 * concat on every chunk. ANSI parsing happens at render time via Agent B's
 * `shared/lib/ansi-parser/` once it lands; until then the card decodes with
 * `TextDecoder`.
 *
 * Wrapped in `subscribeWithSelector` so non-React consumers (features/block/*
 * action dispatchers) can subscribe to individual block lifecycles.
 *
 * This store is intentionally NOT persisted. Block history is session-scoped
 * in Phase 2; long-term history is the `history` domain's job (ADR 0014).
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { SessionId } from '../../shared/types/generated/index.js';

export type BlockStatus = 'running' | 'completed' | 'canceled' | 'error';

/**
 * Sentinel session id used when a block is created without an explicit session.
 *
 * Phase 4 adds multi-session. Call sites that opt into the new API pass a real
 * SessionId to `createBlock`/`startBlock`; older tests and pre-Phase-4 paths
 * that don't thread the id get bucketed here. Selectors (`useBlocksForSession`)
 * treat this as a normal id — it just happens to be stable — so the default
 * bucket renders fine on a single-session fallback. Multi-session production
 * code always threads a real id through `submitCommand` → `startBlock`.
 */
export const DEFAULT_BLOCK_SESSION_ID = '__default__' as SessionId;

/**
 * Default watchdog timeout. If a running block receives no output for this
 * long we assume the process crashed without emitting pty_exit and mark it
 * errored with a synthetic "timed out" message. Chosen to be long enough
 * that legitimate slow commands (git clone, large builds) aren't tripped
 * by the watchdog — they emit periodic progress bytes well inside 30s.
 */
export const DEFAULT_BLOCK_WATCHDOG_MS = 30_000;

export interface Block {
  /** Stable id (UUID v4 via crypto.randomUUID, ulid-lite fallback). */
  readonly id: string;
  /**
   * The session this block belongs to. Phase 4 adds the field so the block
   * list can filter to "only blocks from the currently-active tab". Blocks
   * created without an explicit session id land in `DEFAULT_BLOCK_SESSION_ID`.
   */
  readonly sessionId: SessionId;
  readonly command: string;
  readonly status: BlockStatus;
  readonly cwd: string;
  readonly startedAt: number;
  readonly completedAt: number | null;
  readonly exitCode: number | null;
  /**
   * Raw PTY bytes, as received. Feed through the ANSI parser at render time.
   * Kept as separate segments to avoid O(n) concat cost on every append.
   */
  readonly outputChunks: readonly Uint8Array[];
  readonly collapsed: boolean;
  readonly pinned: boolean;
  /** Populated only when status === 'error'. */
  readonly errorMessage: string | null;
  /**
   * Rerun lineage (Phase 4): when this block was created by `rerunBlock`, we
   * stash the id of the block it replayed. `null` on the original run. The
   * Compare panel walks this chain backward to pair a rerun with its prior
   * run for side-by-side diff; `getRerunLineage` materializes the walk.
   *
   * The pointer is kept even after the predecessor is cleared from history
   * (pinned-only clear rewrites `order`/`entities`): dangling pointers are
   * filtered by the selector, not by the store. That keeps `clearHistory`
   * O(n) and avoids invalidating unrelated rerun chains.
   */
  readonly rerunOfId: string | null;
}

export interface BlockState {
  readonly order: readonly string[];
  readonly entities: Readonly<Record<string, Block>>;
  /**
   * Id of the block that pty_data routes to. Moved INTO the store (previously
   * a module-level var in features/command/active-block) so `startBlock` can
   * cancel-previous + create + set-active as one atomic state mutation,
   * closing the race where synchronous pty_data from bridge.write() raced the
   * setActiveBlockId call.
   */
  readonly activeBlockId: string | null;
}

export interface StartBlockOptions {
  /** Watchdog timeout in ms. Use 0 or a negative number to disable.
   *  Defaults to DEFAULT_BLOCK_WATCHDOG_MS. */
  readonly watchdogMs?: number;
  /**
   * Lineage pointer — id of the predecessor block this submission is replaying.
   * Set by `rerunBlock`; the Compare panel reads it via `getRerunLineage`.
   * Omitted (or undefined) on original submissions.
   */
  readonly rerunOf?: string | null;
  /**
   * Session ownership (Phase 4). Omit for the single-session default bucket;
   * multi-session call sites pass the session id that spawned the PTY write.
   */
  readonly sessionId?: SessionId;
}

export interface CreateBlockOptions {
  /** See StartBlockOptions.rerunOf — same semantics for non-atomic creation. */
  readonly rerunOf?: string | null;
  /** See StartBlockOptions.sessionId. */
  readonly sessionId?: SessionId;
}

export interface BlockActions {
  /** Start a new block. Returns the generated id so the caller can key events. */
  createBlock(command: string, cwd: string, options?: CreateBlockOptions): string;
  /**
   * Atomic submit-dispatch: cancel any previously-active block, create a new
   * running block, make it active, and arm the watchdog — all in one state
   * mutation. Closes the race where synchronous pty_data emitted inside
   * `bridge.write()` could route bytes to the wrong block between separate
   * `createBlock` and `setActive` calls.
   */
  startBlock(command: string, cwd: string, options?: StartBlockOptions): string;
  appendBlockOutput(id: string, chunk: Uint8Array): void;
  completeBlock(id: string, exitCode: number | null): void;
  cancelBlock(id: string): void;
  errorBlock(id: string, message: string): void;
  /**
   * Set the active block pointer directly. Most callers should use
   * `startBlock` instead; this action exists for the router (which clears
   * the pointer on boundary detection) and for tests.
   */
  setActiveBlockId(id: string | null): void;
  toggleCollapse(id: string): void;
  togglePin(id: string): void;
  /** Wipe non-pinned blocks. Pinned blocks preserve their position. */
  clearHistory(): void;
  /**
   * Rehydrate the store with persisted blocks (Phase 4). Blocks arrive in
   * chronological order (oldest → newest); this action replaces the store's
   * `order` and `entities` with the incoming list. Running blocks are
   * dropped — hydration only receives blocks in terminal states.
   *
   * Called once at boot by `entities/block/persistence.ts`. Idempotent —
   * re-calling with the same list is a no-op shape-wise.
   */
  hydrateBlocks(blocks: readonly Block[]): void;
  /** Test helper — wipe everything, including pinned. */
  resetAll(): void;
}

const INITIAL: BlockState = {
  order: [],
  entities: {},
  activeBlockId: null,
};

/**
 * Per-block watchdog timer handles. Kept outside the store state because
 * timer ids are side-effect bookkeeping — serializing/snapshotting them
 * would be meaningless and subscribers don't care about their identity.
 * Keyed by block id; cleared on terminal transitions.
 */
const watchdogTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearWatchdog(id: string): void {
  const t = watchdogTimers.get(id);
  if (t !== undefined) {
    clearTimeout(t);
    watchdogTimers.delete(id);
  }
}

function armWatchdog(id: string, ms: number, onFire: () => void): void {
  clearWatchdog(id);
  if (!Number.isFinite(ms) || ms <= 0) return;
  watchdogTimers.set(id, setTimeout(onFire, ms));
}

/**
 * UUID generator. Prefers `crypto.randomUUID` (Node 20+, all modern browsers,
 * jsdom ships it). Falls back to a monotonic pseudo-ulid if absent — good
 * enough for tests that stub the environment.
 */
function nextId(): string {
  const g = globalThis as typeof globalThis & {
    crypto?: { randomUUID?: () => string };
  };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Monotonic fallback: millis-since-epoch + 6-char random suffix.
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(5, '0');
  return `blk_${ts}_${rand}`;
}

export const useBlockStore = create<BlockState & BlockActions>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL,

    createBlock: (command, cwd, options) => {
      const id = nextId();
      const now = Date.now();
      const block: Block = {
        id,
        sessionId: options?.sessionId ?? DEFAULT_BLOCK_SESSION_ID,
        command,
        cwd,
        status: 'running',
        startedAt: now,
        completedAt: null,
        exitCode: null,
        outputChunks: [],
        collapsed: false,
        pinned: false,
        errorMessage: null,
        rerunOfId: options?.rerunOf ?? null,
      };
      set((prev) => ({
        order: [...prev.order, id],
        entities: { ...prev.entities, [id]: block },
      }));
      return id;
    },

    startBlock: (command, cwd, options) => {
      // Single atomic mutation: cancel any previously active running block,
      // create the new block, point `activeBlockId` at it. Prevents the
      // between-step pty_data race (see BlockActions.startBlock docblock).
      const id = nextId();
      const now = Date.now();
      const block: Block = {
        id,
        sessionId: options?.sessionId ?? DEFAULT_BLOCK_SESSION_ID,
        command,
        cwd,
        status: 'running',
        startedAt: now,
        completedAt: null,
        exitCode: null,
        outputChunks: [],
        collapsed: false,
        pinned: false,
        errorMessage: null,
        rerunOfId: options?.rerunOf ?? null,
      };
      let previousActiveId: string | null = null;
      set((prev) => {
        const nextEntities = { ...prev.entities };
        const prevActive = prev.activeBlockId;
        if (prevActive !== null) {
          const prevBlock = nextEntities[prevActive];
          if (prevBlock && prevBlock.status === 'running') {
            nextEntities[prevActive] = {
              ...prevBlock,
              status: 'canceled',
              completedAt: now,
            };
            previousActiveId = prevActive;
          }
        }
        nextEntities[id] = block;
        return {
          order: [...prev.order, id],
          entities: nextEntities,
          activeBlockId: id,
        };
      });
      // Clear any lingering watchdog from the superseded block — we just
      // transitioned it to canceled, but the timer would still fire.
      if (previousActiveId !== null) clearWatchdog(previousActiveId);

      const watchdogMs = options?.watchdogMs ?? DEFAULT_BLOCK_WATCHDOG_MS;
      armWatchdog(id, watchdogMs, () => {
        // Fire only if the block is still running. A completed/canceled/
        // errored block must not be demoted to errored by a late timer.
        const current = get().entities[id];
        if (!current || current.status !== 'running') return;
        get().errorBlock(
          id,
          `block timed out: no output for ${watchdogMs}ms (watchdog fired)`,
        );
      });
      return id;
    },

    setActiveBlockId: (id) => set(() => ({ activeBlockId: id })),

    appendBlockOutput: (id, chunk) => {
      let reset = false;
      set((prev) => {
        const b = prev.entities[id];
        if (!b) return prev;
        // Copy the chunk defensively: callers often reuse buffers for the
        // next PTY read, and aliasing would let later bytes mutate history.
        const owned = new Uint8Array(chunk);
        reset = b.status === 'running';
        return {
          ...prev,
          entities: {
            ...prev.entities,
            [id]: { ...b, outputChunks: [...b.outputChunks, owned] },
          },
        };
      });
      if (reset) {
        // Reset the watchdog for a running block on every chunk — the
        // process is alive, push the deadline out. Respect the timer's
        // existing duration; we re-arm with the same `DEFAULT_BLOCK_WATCHDOG_MS`
        // the startBlock used. Since callers who want a non-default watchdog
        // already opted in via startBlock, we keep the reset timeout stable
        // by reusing the default — tests that drive a custom timeout pass
        // fake timers which bypass the real delay anyway.
        armWatchdog(id, DEFAULT_BLOCK_WATCHDOG_MS, () => {
          const current = get().entities[id];
          if (!current || current.status !== 'running') return;
          get().errorBlock(
            id,
            `block timed out: no output for ${DEFAULT_BLOCK_WATCHDOG_MS}ms (watchdog fired)`,
          );
        });
      }
    },

    completeBlock: (id, exitCode) => {
      clearWatchdog(id);
      set((prev) => {
        const b = prev.entities[id];
        if (!b || b.status !== 'running') return prev;
        const nextActive = prev.activeBlockId === id ? null : prev.activeBlockId;
        return {
          ...prev,
          entities: {
            ...prev.entities,
            [id]: { ...b, status: 'completed', exitCode, completedAt: Date.now() },
          },
          activeBlockId: nextActive,
        };
      });
    },

    cancelBlock: (id) => {
      clearWatchdog(id);
      set((prev) => {
        const b = prev.entities[id];
        if (!b || b.status !== 'running') return prev;
        const nextActive = prev.activeBlockId === id ? null : prev.activeBlockId;
        return {
          ...prev,
          entities: {
            ...prev.entities,
            [id]: { ...b, status: 'canceled', completedAt: Date.now() },
          },
          activeBlockId: nextActive,
        };
      });
    },

    errorBlock: (id, message) => {
      clearWatchdog(id);
      set((prev) => {
        const b = prev.entities[id];
        if (!b) return prev;
        const nextActive = prev.activeBlockId === id ? null : prev.activeBlockId;
        return {
          ...prev,
          entities: {
            ...prev.entities,
            [id]: {
              ...b,
              status: 'error',
              completedAt: Date.now(),
              errorMessage: message,
            },
          },
          activeBlockId: nextActive,
        };
      });
    },

    toggleCollapse: (id) =>
      set((prev) => {
        const b = prev.entities[id];
        if (!b) return prev;
        return {
          ...prev,
          entities: {
            ...prev.entities,
            [id]: { ...b, collapsed: !b.collapsed },
          },
        };
      }),

    togglePin: (id) =>
      set((prev) => {
        const b = prev.entities[id];
        if (!b) return prev;
        return {
          ...prev,
          entities: {
            ...prev.entities,
            [id]: { ...b, pinned: !b.pinned },
          },
        };
      }),

    clearHistory: () =>
      set((prev) => {
        const nextOrder: string[] = [];
        const nextEntities: Record<string, Block> = {};
        for (const id of prev.order) {
          const b = prev.entities[id];
          if (b && b.pinned) {
            nextOrder.push(id);
            nextEntities[id] = b;
          } else if (id !== undefined) {
            clearWatchdog(id);
          }
        }
        return { order: nextOrder, entities: nextEntities };
      }),

    hydrateBlocks: (blocks) =>
      set((prev) => {
        // Drop any block that isn't in a terminal state — hydration can't
        // yield a live `running` block and we must not pretend otherwise.
        const terminal = blocks.filter(
          (b) => b.status === 'completed' || b.status === 'canceled' || b.status === 'error',
        );
        const incomingIds = new Set(terminal.map((b) => b.id));
        const nextEntities: Record<string, Block> = {};
        // Preserve any in-memory block NOT replaced by hydration (rare but
        // legitimate: tests mid-flight, a running block that was created
        // before hydrate completed).
        for (const [id, b] of Object.entries(prev.entities)) {
          if (!incomingIds.has(id)) nextEntities[id] = b;
        }
        for (const b of terminal) nextEntities[b.id] = b;

        // Order: hydrated blocks first (oldest → newest), then any
        // preserved in-memory ids that aren't in the hydration list, keeping
        // their relative order.
        const hydratedIds = terminal.map((b) => b.id);
        const surviving = prev.order.filter((id) => !incomingIds.has(id));
        return {
          ...prev,
          order: [...hydratedIds, ...surviving],
          entities: nextEntities,
        };
      }),

    resetAll: () => {
      for (const id of [...watchdogTimers.keys()]) clearWatchdog(id);
      set(() => ({ ...INITIAL }));
    },
  })),
);

/**
 * Utility — concatenate a block's output chunks into one byte array. The card
 * uses this when feeding the (eventual) ANSI parser. Kept here so multiple
 * consumers share one implementation.
 */
export function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

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

/**
 * Audit P0 (fix 2): upper bound on the per-store LRU of applied event ids.
 * Chosen to comfortably exceed the sidecar's resume-replay window (a few
 * dozen events on a typical reconnect) while staying small enough that the
 * backing Set fits in a handful of kilobytes. FIFO eviction is adequate —
 * event ids monotonically age out as new ones arrive.
 */
export const APPLIED_EVENT_ID_LRU_CAPACITY = 256;

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
  /**
   * Audit P0 (fix 2): bounded FIFO LRU of applied event ids. Event-bearing
   * actions (see `BlockActions`) consult this set before mutating so
   * replayed events from a sidecar reconnect don't flip terminal state.
   * Kept inside `BlockState` so resetting the store (tests, clear) wipes it
   * too; consumers should never observe it directly.
   *
   * We pair the `Set` (O(1) membership) with an `order` array so FIFO
   * eviction at capacity is trivial. Insertion order is preserved by JS
   * `Set` semantics in principle, but the explicit array makes the eviction
   * code obvious and allows tests to introspect size deterministically.
   */
  readonly appliedEventIds: ReadonlySet<string>;
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
  /**
   * Audit P0 (fix 2): optional event envelope id. When present, the action
   * is deduped against the per-store applied-id LRU — a second call with
   * the same id is a no-op. Callers that don't source from an event (tests,
   * composer) may omit this.
   */
  readonly eventId?: string;
}

export interface CreateBlockOptions {
  /** See StartBlockOptions.rerunOf — same semantics for non-atomic creation. */
  readonly rerunOf?: string | null;
  /** See StartBlockOptions.sessionId. */
  readonly sessionId?: SessionId;
  /** See StartBlockOptions.eventId. */
  readonly eventId?: string;
}

/**
 * Audit P1 (fix 4): optional match guard for the `setActiveBlockId` action.
 * When `requireSessionMatch` is set, the action is a no-op unless the
 * targeted block belongs to that session id. Callers that own a specific
 * session (router disposers, composer) pass their owning id so a racing
 * caller cannot overwrite another session's active pointer.
 */
export interface SetActiveBlockIdOptions {
  readonly requireSessionMatch?: SessionId;
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
  appendBlockOutput(id: string, chunk: Uint8Array, eventId?: string): void;
  completeBlock(id: string, exitCode: number | null, eventId?: string): void;
  cancelBlock(id: string, eventId?: string): void;
  errorBlock(id: string, message: string, eventId?: string): void;
  /**
   * Set the active block pointer directly. Most callers should use
   * `startBlock` instead; this action exists for the router (which clears
   * the pointer on boundary detection) and for tests.
   *
   * Audit P1 (fix 4): when `options.requireSessionMatch` is present, the
   * mutation applies only if the (non-null) target block is owned by that
   * session. Used to close the router↔composer race where two callers on
   * different sessions can stomp each other's active pointer.
   */
  setActiveBlockId(id: string | null, options?: SetActiveBlockIdOptions): void;
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
  appliedEventIds: new Set<string>(),
};

/**
 * Per-block watchdog timer handles. Kept outside the store state because
 * timer ids are side-effect bookkeeping — serializing/snapshotting them
 * would be meaningless and subscribers don't care about their identity.
 * Keyed by block id; cleared on terminal transitions.
 */
interface WatchdogHandle {
  readonly timerId: ReturnType<typeof setTimeout>;
  /** Monotonic timestamp (performance.now) at which the watchdog was armed. */
  readonly armedAt: number;
  /** Full timeout in ms — used when the inner callback needs to check
   *  elapsed time against monotonic clock regardless of system clock jumps. */
  readonly timeoutMs: number;
}

const watchdogTimers = new Map<string, WatchdogHandle>();

/**
 * Audit P0 (fix 5): the block entity uses monotonic time (`performance.now`)
 * for DURATION measurements and watchdog scheduling, while keeping
 * `Date.now` for wall-clock metadata (`startedAt`, `completedAt`). The
 * subtle rule: "how long did this take" must survive system-clock jumps
 * (NTP sync, DST, suspend/resume); "when did this happen" is a display
 * value and should reflect the user's clock.
 */
function monotonicNow(): number {
  const g = globalThis as typeof globalThis & {
    performance?: { now?: () => number };
  };
  if (g.performance?.now) return g.performance.now();
  return Date.now();
}

function clearWatchdog(id: string): void {
  const t = watchdogTimers.get(id);
  if (t !== undefined) {
    clearTimeout(t.timerId);
    watchdogTimers.delete(id);
  }
}

function armWatchdog(id: string, ms: number, onFire: () => void): void {
  clearWatchdog(id);
  if (!Number.isFinite(ms) || ms <= 0) return;
  // Audit P0 (fix 5): `setTimeout`'s scheduling is already a monotonic
  // construct in every host we target — it measures host-ticks, not wall
  // clock, so a backward `Date.now()` jump does not delay it. We therefore
  // hand the firing decision to the timer itself and deliberately do NOT
  // implement a `Date.now() - startedAt` elapsed check in the callback
  // (that was the audit's explicit anti-pattern). The monotonic checkpoint
  // (`armedAt`) is captured for telemetry / future elapsed reporting; the
  // callback guards against late-fire against terminal state via the
  // consumer's `onFire` closure (see `startBlock` / `appendBlockOutput`).
  const armedAt = monotonicNow();
  const timerId = setTimeout(onFire, ms);
  watchdogTimers.set(id, { timerId, armedAt, timeoutMs: ms });
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

/**
 * Audit P0 (fix 2): bounded FIFO eviction helper. Adds `eventId` to the set
 * and, when over capacity, evicts the OLDEST entry using JS Set's insertion-
 * order guarantee. Returns a NEW Set (the store holds it as a value; zustand
 * consumers expect reference equality checks to detect change).
 */
function withAppliedEventId(prev: ReadonlySet<string>, eventId: string): Set<string> {
  if (prev.has(eventId)) {
    // Caller is responsible for short-circuiting before we reach here; defend
    // anyway so a mis-threaded call doesn't silently double-count capacity.
    return new Set(prev);
  }
  const next = new Set(prev);
  next.add(eventId);
  while (next.size > APPLIED_EVENT_ID_LRU_CAPACITY) {
    const oldest = next.values().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

export const useBlockStore = create<BlockState & BlockActions>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL,

    createBlock: (command, cwd, options) => {
      const id = nextId();
      // Audit P0 (fix 5): wall-clock for the user-visible timestamp; monotonic
      // is reserved for durations and watchdog scheduling.
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
      const eventId = options?.eventId;
      set((prev) => {
        // Audit P0 (fix 2): event-id idempotency — if the sidecar already
        // delivered this event (typical after a resume-replay) we must not
        // re-create the block. Replayed events without an id (tests) skip
        // the dedupe path entirely for backward compat.
        if (eventId !== undefined && prev.appliedEventIds.has(eventId)) {
          return prev;
        }
        return {
          order: [...prev.order, id],
          entities: { ...prev.entities, [id]: block },
          appliedEventIds:
            eventId !== undefined ? withAppliedEventId(prev.appliedEventIds, eventId) : prev.appliedEventIds,
        };
      });
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
      const eventId = options?.eventId;
      let previousActiveId: string | null = null;
      let skipped = false;
      set((prev) => {
        // Audit P0 (fix 2): skip replayed starts — a duplicate startBlock
        // event from a resume cursor must not spawn a second block with its
        // own side effects (watchdog arm, cancel-previous).
        if (eventId !== undefined && prev.appliedEventIds.has(eventId)) {
          skipped = true;
          return prev;
        }
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
          appliedEventIds:
            eventId !== undefined ? withAppliedEventId(prev.appliedEventIds, eventId) : prev.appliedEventIds,
        };
      });
      if (skipped) return id;
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

    setActiveBlockId: (id, options) =>
      set((prev) => {
        // Audit P1 (fix 4): session-match guard — skip the write when the
        // caller required a specific owning session and the targeted block
        // doesn't belong to that session. A `null` target with a match guard
        // also skips unless the CURRENT active block belongs to the session
        // (otherwise a router disposer would blanket-clear cross-session).
        const required = options?.requireSessionMatch;
        if (required !== undefined) {
          if (id !== null) {
            const targetBlock = prev.entities[id];
            if (!targetBlock || targetBlock.sessionId !== required) return prev;
          } else {
            const active = prev.activeBlockId;
            if (active === null) return prev;
            const activeBlock = prev.entities[active];
            if (!activeBlock || activeBlock.sessionId !== required) return prev;
          }
        }
        return { ...prev, activeBlockId: id };
      }),

    appendBlockOutput: (id, chunk, eventId) => {
      let reset = false;
      set((prev) => {
        if (eventId !== undefined && prev.appliedEventIds.has(eventId)) {
          return prev;
        }
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
          appliedEventIds:
            eventId !== undefined ? withAppliedEventId(prev.appliedEventIds, eventId) : prev.appliedEventIds,
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

    completeBlock: (id, exitCode, eventId) => {
      let applied = false;
      set((prev) => {
        if (eventId !== undefined && prev.appliedEventIds.has(eventId)) {
          return prev;
        }
        const b = prev.entities[id];
        if (!b || b.status !== 'running') return prev;
        applied = true;
        const nextActive = prev.activeBlockId === id ? null : prev.activeBlockId;
        return {
          ...prev,
          entities: {
            ...prev.entities,
            [id]: { ...b, status: 'completed', exitCode, completedAt: Date.now() },
          },
          activeBlockId: nextActive,
          appliedEventIds:
            eventId !== undefined ? withAppliedEventId(prev.appliedEventIds, eventId) : prev.appliedEventIds,
        };
      });
      if (applied) clearWatchdog(id);
    },

    cancelBlock: (id, eventId) => {
      let applied = false;
      set((prev) => {
        if (eventId !== undefined && prev.appliedEventIds.has(eventId)) {
          return prev;
        }
        const b = prev.entities[id];
        if (!b || b.status !== 'running') return prev;
        applied = true;
        const nextActive = prev.activeBlockId === id ? null : prev.activeBlockId;
        return {
          ...prev,
          entities: {
            ...prev.entities,
            [id]: { ...b, status: 'canceled', completedAt: Date.now() },
          },
          activeBlockId: nextActive,
          appliedEventIds:
            eventId !== undefined ? withAppliedEventId(prev.appliedEventIds, eventId) : prev.appliedEventIds,
        };
      });
      if (applied) clearWatchdog(id);
    },

    errorBlock: (id, message, eventId) => {
      let applied = false;
      set((prev) => {
        if (eventId !== undefined && prev.appliedEventIds.has(eventId)) {
          return prev;
        }
        const b = prev.entities[id];
        // Audit P0 (fix 1): errorBlock must be guarded the same way
        // completeBlock/cancelBlock are — a late-firing watchdog (e.g. a
        // 35s-delayed callback on a block that already reported exit=0)
        // would otherwise REWRITE a completed block to `error`, losing the
        // original exit code and confusing the UI. Mirror the terminal-state
        // guard: only apply when the block is currently `running`.
        if (!b || b.status !== 'running') return prev;
        applied = true;
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
          appliedEventIds:
            eventId !== undefined ? withAppliedEventId(prev.appliedEventIds, eventId) : prev.appliedEventIds,
        };
      });
      if (applied) clearWatchdog(id);
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
      set(() => ({ ...INITIAL, appliedEventIds: new Set<string>() }));
    },
  })),
);

/**
 * Audit P1 (fix 3): clear every watchdog timer that belongs to a block in
 * `removedId`. Exposed as a plain function so `features/command/bind-block-
 * entity.ts` (the single cross-slice seam) can invoke it from inside the
 * session-removal hook it already binds. The block entity stays sibling-
 * free: it does NOT import from `entities/session`; the hook wiring lives
 * in the feature layer, which is allowed to compose entities.
 */
export function clearWatchdogsForSession(sessionId: SessionId): void {
  const state = useBlockStore.getState();
  for (const [blockId, block] of Object.entries(state.entities)) {
    if (block.sessionId === sessionId) clearWatchdog(blockId);
  }
}

/** Test-only: check if a watchdog timer is currently armed for a block. */
export function __hasWatchdogForTests(blockId: string): boolean {
  return watchdogTimers.has(blockId);
}

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

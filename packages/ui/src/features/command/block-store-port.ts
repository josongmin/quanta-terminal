/**
 * Block store port — the narrow surface the command feature needs from
 * `entities/block`.
 *
 * Agent A owns the block entity/store. This feature consumes the store
 * through a registered adapter (a narrow, named port) rather than importing
 * the store module directly. Reasons:
 *
 *   - Test ergonomics: tests bind a vi.fn-shaped implementation without
 *     touching any store.
 *   - Agent boundary: this feature compiles and tests pass even when the
 *     store's internal shape shifts — only the adapter has to keep up.
 *   - FSD purity: the port type lives in the feature slice; the concrete
 *     wiring (see `bind-block-entity.ts`) binds lazily at bootstrap.
 *
 * Contract with entities/block (as of Phase 2)
 * --------------------------------------------
 * The store-level signatures we rely on:
 *
 *   createBlock(command: string, cwd: string): BlockId
 *     - returns the new block id; block starts in `running`.
 *   appendBlockOutput(blockId: BlockId, chunk: Uint8Array): void
 *     - append raw PTY bytes to the block's output buffer. The block card
 *       runs ANSI parsing at render time — this feature is byte-agnostic.
 *   completeBlock(blockId: BlockId, exitCode: number | null): void
 *     - terminal state `completed` with exit code (nullable for signal-only
 *       exits).
 *   cancelBlock(blockId: BlockId): void
 *     - terminal state `canceled`; used when a new submit supersedes a
 *       running block.
 *   errorBlock(blockId: BlockId, message: string): void
 *     - terminal state `error`; used for session-level failures.
 *   getRunningBlockIds(): readonly BlockId[]
 *     - return every block currently in `running` state. Used by pty_exit
 *       to finalize stragglers. Derived in the adapter — the store itself
 *       does not expose this as an action, it's a selector over state.
 */

import type { BlockId, SessionId } from '../../shared/types/generated/index.js';

export interface StartBlockPortOptions {
  readonly watchdogMs?: number;
  /** Phase 4 — session ownership for the new block. Omit to use the default
   *  single-session bucket. */
  readonly sessionId?: SessionId;
  /**
   * Phase 4 — rerun lineage pointer. When `rerunBlock` replays an older
   * block's command, this carries the predecessor id so the new block's
   * `rerunOfId` gets stamped atomically at creation (no second write, no
   * race with the Compare panel reading stale state).
   */
  readonly rerunOf?: string | null;
}

export interface BlockStoreActions {
  createBlock(command: string, cwd: string, options?: { sessionId?: SessionId }): BlockId;
  /**
   * Atomic submit dispatch: cancel previous-active + create + setActive in a
   * single state mutation. Closes the race where the mock bridge's
   * synchronous `write()` callback can emit pty_data between separate
   * createBlock / setActive calls. Returns the new block id. Also arms the
   * watchdog timer (default 30s of silence → errored).
   */
  startBlock(command: string, cwd: string, options?: StartBlockPortOptions): BlockId;
  /** Override the active block pointer. The router calls this with `null`
   *  on boundary detection; tests use it to seed state. */
  setActiveBlockId(id: BlockId | null): void;
  /** Read the store's current active block pointer. */
  getActiveBlockId(): BlockId | null;
  appendBlockOutput(blockId: BlockId, chunk: Uint8Array): void;
  completeBlock(blockId: BlockId, exitCode: number | null): void;
  cancelBlock(blockId: BlockId): void;
  errorBlock(blockId: BlockId, message: string): void;
  getRunningBlockIds(): readonly BlockId[];
}

let bound: BlockStoreActions | undefined;

/**
 * Install the concrete block-store adapter. Called once at bootstrap time
 * by the orchestrator (page or app layer), ideally right after the block
 * entity module is imported.
 *
 * Returns a disposer that unbinds — primarily a test hygiene hook so one
 * test's binding cannot leak into the next.
 */
export function bindBlockStore(actions: BlockStoreActions): () => void {
  const prev = bound;
  bound = actions;
  return () => {
    bound = prev;
  };
}

/** Retrieve the bound adapter. Throws if nothing is bound — a clearer error
 *  than `undefined.createBlock()` downstream. */
export function getBlockStore(): BlockStoreActions {
  if (!bound) {
    throw new Error(
      'features.command.block-store-port: no BlockStoreActions bound. ' +
        'The orchestrator must call bindBlockStore() with an adapter over ' +
        '@quanta/ui/entities/block before the command feature is used.',
    );
  }
  return bound;
}

/** Safe lookup. Returns undefined instead of throwing — used by the router
 *  so pty_data arriving before binding is dropped, not an unhandled throw. */
export function tryGetBlockStore(): BlockStoreActions | undefined {
  return bound;
}

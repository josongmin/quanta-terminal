/**
 * Plan 0005 P1-C — block boundary listener.
 *
 * Bridges the hybrid boundary detector (P1-A) to the block store's `rowRange`
 * + `confidence` fields and to the VtEmulator's scrollback pin API. No
 * rendering: this module is a pure adapter between three existing seams.
 *
 * Lifecycle
 * ---------
 * One instance per session. The caller (usually `features/session/engine.ts`
 * when `flag.blockUx === true`) wires up the listener with
 * `installBoundaryListener(...)`. Every time the detector produces events
 * (on `feed()` or `tick()`), the session wiring forwards them into the
 * listener's `pump(events)` method; the listener translates them into store
 * mutations:
 *
 *   prompt_start   → finalize the previous running block (if any), create a
 *                    new block attached to `{ startRow: <nextRowId>,
 *                    endRowExclusive: null }`, pin the start row.
 *   command_start  → no-op (reserved hook for future command-text ingest).
 *   output_start   → no-op.
 *   command_end    → close the row range's `endRowExclusive`, write the
 *                    exit code / duration from the OSC 133 D payload,
 *                    complete the block, release the pin.
 *
 * Why a pump-based port instead of `detector.onEvent` subscription?
 * ---------------------------------------------------------------
 * The hybrid detector already returns events from `feed`/`tick` as values;
 * the session wiring holds the detector anyway to call `setSignals` etc.
 * Threading events through an explicit `pump` keeps the listener free of
 * detector lifecycle coupling — the detector can be swapped, replayed, or
 * fed synthetically from tests without either side knowing about the
 * other's teardown order.
 *
 * Row-id sourcing
 * ---------------
 * The hybrid detector does NOT emit row IDs (its surface is byte-level).
 * We snapshot the emulator's `baseRowId + rows.length` at event-arrival
 * time — i.e. the id the NEXT captured scrollback row would receive. For
 * `prompt_start` that row is where the new prompt is being drawn; for
 * `command_end` it's the end-exclusive row after the last command output.
 * This is approximate but matches grid-paint timing closely enough for
 * overlay positioning.
 *
 * Retraction / upgrade
 * --------------------
 * Confidence upgrades from a later-arriving higher-tier event are handled
 * by the detector's own suppression machinery (`suppressionWindowMs`); by
 * the time events reach this listener they are already the "winning" tier.
 * When an upgrade event arrives AFTER a block was already created at a
 * lower tier (rare: the detector's suppression window elapsed first), the
 * listener simply creates a new block. The overlay renders both; dismissal
 * is user-driven. A future enhancement can merge blocks whose `startRow`
 * matches.
 */

import type { BlockActions } from '../../entities/block/model.js';
import type { BlockConfidence } from '../../entities/block/model.js';
import type { BlockId, SessionId } from '../../shared/types/generated/index.js';
import type {
  BoundaryEvent,
  BoundarySource,
  HybridBoundaryDetector,
} from './hybrid-detector-types.js';

/**
 * The subset of `VtEmulator` the listener touches. Exposed as a structural
 * interface so tests can wire a mock without standing up the full engine —
 * which would pull in grapheme tables, the width classifier, and the FSM.
 */
export interface ScrollbackPinPort {
  /** Current row-id the NEXT captured scrollback row will receive. Matches
   *  `mainScrollback.baseRowId + mainScrollback.rows.length` exactly. */
  getNextRowId(): number;
  pinScrollbackRow(rowId: number): void;
  unpinScrollbackRow(rowId: number): void;
}

/**
 * The subset of `BlockActions` the listener needs. Matches the shape the
 * store already exports; the wider interface is NOT re-surfaced here so a
 * future refactor of the store leaves this port intact.
 */
export interface BoundaryBlockStorePort {
  startBlock: BlockActions['startBlock'];
  completeBlock: BlockActions['completeBlock'];
  setBlockRowRange: BlockActions['setBlockRowRange'];
  setBlockDuration: BlockActions['setBlockDuration'];
  getActiveBlockId(): BlockId | null;
}

/**
 * Plan 0005 P1-A / P1-C — map a detector source tier to the block-store's
 * confidence enum. The enum is kept separate from `BoundarySource` so
 * persistence doesn't leak internal detector taxonomy.
 */
export function mapSourceToConfidence(source: BoundarySource): BlockConfidence {
  switch (source) {
    case 'osc133':
      return 'authoritative';
    case 'heuristic_regex':
    case 'cursor_home':
      return 'heuristic';
    case 'idle':
      return 'idle';
  }
}

/**
 * Test-friendly handle returned by `createBoundaryListener`. Production
 * code goes through `installBoundaryListener` which returns the same shape
 * plus a disposer.
 */
export interface BoundaryListenerHandle {
  /** Drive the listener with events pulled from the detector. */
  readonly pump: (events: readonly BoundaryEvent[]) => void;
  /** Inspect the currently-tracked active block — `null` between blocks. */
  readonly getActiveBlockId: () => BlockId | null;
  /** Tear down. Releases any still-held scrollback pin. */
  readonly dispose: () => void;
}

/**
 * Core factory — returns a pump-based handle. Shared between the test path
 * (direct construction) and the production path (`installBoundaryListener`).
 */
export function createBoundaryListener(
  sessionId: SessionId,
  blockStore: BoundaryBlockStorePort,
  pinPort: ScrollbackPinPort,
): BoundaryListenerHandle {
  let activeBlockId: BlockId | null = null;
  let lastStartRow: number | null = null;
  let disposed = false;

  const onPromptStart = (event: BoundaryEvent): void => {
    // If a previous block is still open (e.g. user Ctrl-C'd so the shell
    // never emitted a command_end), finalize it synthetically. `completeBlock`
    // is guarded against non-running status, so a no-op on already-terminal
    // blocks is safe.
    if (activeBlockId !== null) {
      blockStore.completeBlock(activeBlockId, null);
      activeBlockId = null;
    }

    const rowId = pinPort.getNextRowId();
    lastStartRow = rowId;
    const confidence = mapSourceToConfidence(event.source);
    // Command text is unknown at prompt_start — the hybrid detector's
    // event surface doesn't carry it. We create the block with an empty
    // command; a future enhancement can wire a command observer to back-
    // fill the field between prompt_start and command_start. Chrome
    // falls back to "running..." when command is empty.
    const newId = blockStore.startBlock('', '', {
      sessionId,
      rowRange: { startRow: rowId, endRowExclusive: null },
      confidence,
    }) as BlockId;
    activeBlockId = newId;
    pinPort.pinScrollbackRow(rowId);
  };

  const onCommandEnd = (event: BoundaryEvent): void => {
    // Fallback to the store's active pointer when our private pointer is
    // null — this can happen if the listener was installed mid-session and
    // missed the prompt_start for the running block.
    const target = activeBlockId ?? blockStore.getActiveBlockId();
    if (target === null) return;

    const endRowExclusive = pinPort.getNextRowId();
    if (lastStartRow !== null) {
      blockStore.setBlockRowRange(target, {
        startRow: lastStartRow,
        endRowExclusive,
      });
    }
    const exitCode = typeof event.exitCode === 'number' ? event.exitCode : null;
    blockStore.completeBlock(target, exitCode);
    // setBlockDuration AFTER completeBlock — the action is a no-op on
    // running blocks, so ordering matters.
    if (
      typeof event.durationMs === 'number' &&
      Number.isFinite(event.durationMs)
    ) {
      blockStore.setBlockDuration(target, event.durationMs);
    }
    if (lastStartRow !== null) {
      pinPort.unpinScrollbackRow(lastStartRow);
    }
    activeBlockId = null;
    lastStartRow = null;
  };

  const dispatch = (event: BoundaryEvent): void => {
    if (disposed) return;
    switch (event.kind) {
      case 'prompt_start':
        onPromptStart(event);
        return;
      case 'command_end':
        onCommandEnd(event);
        return;
      case 'command_start':
      case 'output_start':
        // Reserved hooks; intentional no-op in P1-C.
        return;
    }
  };

  return {
    pump(events) {
      for (const e of events) dispatch(e);
    },
    getActiveBlockId() {
      return activeBlockId;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (lastStartRow !== null) {
        try {
          pinPort.unpinScrollbackRow(lastStartRow);
        } catch {
          // Disposer must be infallible.
        }
        lastStartRow = null;
      }
      activeBlockId = null;
    },
  };
}

/**
 * Install a boundary listener on a session. Production entrypoint.
 *
 * The returned disposer tears the listener down. The detector reference is
 * retained but not owned — the caller's lifecycle controls the detector's
 * reset/dispose.
 *
 * Usage (in `features/session/engine.ts` when `flag.blockUx === true`):
 *
 *   const detector = createHybridBoundaryDetector({ shellIntegration: ... });
 *   const listener = installBoundaryListener(sessionId, detector, store, emulator);
 *
 *   // In the session's PTY read loop (after `emulator.feed(chunk)`):
 *   const events = detector.feed(chunk);
 *   listener.pump(events);
 */
export function installBoundaryListener(
  sessionId: SessionId,
  detector: HybridBoundaryDetector,
  blockStore: BoundaryBlockStorePort,
  pinPort: ScrollbackPinPort,
): BoundaryListenerHandle {
  // The detector reference is accepted to satisfy the wiring contract but
  // is not subscribed-to here (events flow via `pump`). Acknowledged to
  // document the dependency and satisfy no-unused-vars without a lint hole.
  void detector;
  return createBoundaryListener(sessionId, blockStore, pinPort);
}

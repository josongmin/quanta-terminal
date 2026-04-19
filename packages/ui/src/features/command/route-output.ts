/**
 * Output router — routes `pty_data` bytes from the session into the
 * currently-active block, and finalizes blocks on `pty_exit`.
 *
 * The `features/session/connect.ts` module calls us directly (rather than
 * fan-out via the event bus). Direct calls are simpler here: both modules
 * live in the same layer, there is no third-party listener in play, and the
 * bus would force us to add a bridge-event-shaped topic just to bounce it
 * right back. The event bus is for UI affordance broadcasts (see
 * `shared/lib/event-bus.ts`), not for bridge fan-out.
 *
 * Boundary detection
 * ------------------
 * The Phase-1 mock bridge terminates each command's output with the prompt
 * bytes defined in `@quanta/host-common`'s `MOCK_PROMPT_BYTES`. We consume
 * detection through the `BoundaryDetector` port (see `boundary-detector.ts`)
 * so swapping in the real OSC 133 D detector does not touch the router.
 * The detector is stateful and per-block — a single detector instance is
 * reused for as long as one block is active, and a new one is installed on
 * the next block so in-flight carry bytes never leak across blocks.
 *
 * Per-session state
 * -----------------
 * Router state is keyed by `SessionId` so multiple concurrent sessions do
 * not share a global `installed` flag (previous design) that could cause
 * one session's dispose to detach a sibling session's routing. The
 * `installCommandRouter(sessionId)` call returns a disposer scoped to that
 * session; public entry points (`appendToActiveBlock`, `finalizeActiveBlock`)
 * accept the session id so events are matched to the right router state.
 *
 * Backwards note: a no-argument `installCommandRouter()` call is intentionally
 * kept out of this module. Callers must pass a session id. The previous
 * terminal-page used a single implicit session; the explicit id also makes
 * testing multi-session behavior straightforward.
 */

import type { BlockId, SessionId } from '@quanta/host-common';
import { base64ToBytes } from '../../shared/lib/base64.js';
import { tryGetBlockStore } from './block-store-port.js';
import { createLogger } from '../../shared/lib/logger.js';
import {
  createMockBoundaryDetector,
  type BoundaryDetector,
} from './boundary-detector.js';

const log = createLogger('command.route-output');

// ----- Per-session router state -----

interface RouterHandle {
  readonly sessionId: SessionId;
  /** Current per-block boundary detector. Replaced when a new block opens
   *  via the `resetBoundaryDetector` entry point below. */
  detector: BoundaryDetector;
}

const routers = new Map<SessionId, RouterHandle>();

/**
 * Side-channel observers for raw PTY chunks flowing through the router.
 *
 * The TUI feature (Phase 3) hooks an alt-screen detector here so it can
 * observe the byte stream without owning a per-block parser. Observers are
 * global — not per-session — because the alt-screen flag is itself global
 * (only one TUI is ever the focused surface). Adding per-session scoping
 * here is a future change that can happen when the UI grows a real
 * multi-session surface.
 */
type RawChunkObserver = (chunk: Uint8Array) => void;
const rawChunkObservers = new Set<RawChunkObserver>();

export function addRouterRawObserver(observer: RawChunkObserver): () => void {
  rawChunkObservers.add(observer);
  return () => {
    rawChunkObservers.delete(observer);
  };
}

/** Test helper: clear every observer. */
export function __resetRawObserversForTests(): void {
  rawChunkObservers.clear();
}

/**
 * Test helper: synchronously fan out `chunk` to every currently-registered
 * raw-chunk observer. Mirrors the internal fan-out inside
 * `appendToActiveBlock` so a test can exercise the router-raw observer
 * surface (e.g. `installTuiDetector`) without standing up the full
 * session → block-store → router pipeline. Do not call from production.
 */
export function __emitRawChunkForTests(chunk: Uint8Array): void {
  for (const observer of rawChunkObservers) {
    observer(chunk);
  }
}

// ----- Install / dispose -----

/**
 * Install the router for a session. Returns a disposer that detaches state
 * scoped to that id only; other sessions keep routing. Re-installing for
 * the same session replaces the detector (and logs a debug warning — this
 * should not happen in practice).
 *
 * Multi-session safety: the disposer clears the active block pointer ONLY
 * when we can POSITIVELY confirm the pointer currently targets a block owned
 * by this session. Before Phase 4 this was a blanket clear, which meant
 * closing session A would wipe session B's routing focus. We consult the
 * block store to resolve the active block's `sessionId` and only clear when
 * it matches.
 *
 * Audit P0 (fix 1): when the `blockSessionLookup` port has not been
 * registered yet (early-boot timing) or returns undefined for any reason,
 * we MUST NOT clear. Previously the default was "clear on unknown" which
 * meant a sibling session's in-flight block could get nuked during a race
 * between session close and adapter registration.
 */
export function installCommandRouter(sessionId: SessionId): { dispose: () => void } {
  if (routers.has(sessionId)) {
    log.debug('installCommandRouter: replacing existing router for', sessionId);
  }
  const handle: RouterHandle = {
    sessionId,
    detector: createMockBoundaryDetector(),
  };
  routers.set(sessionId, handle);
  return {
    dispose: () => {
      // If a later install replaced us, we are a stale handle. Do nothing —
      // deleting the live entry or clearing the active pointer would stomp
      // state the current router owns.
      if (routers.get(sessionId) !== handle) return;
      routers.delete(sessionId);

      // Clear the active pointer ONLY when it still points at a block owned
      // by THIS session. Blanket-clearing here would stomp on a sibling
      // session's in-flight block when that session's router remains live.
      const store = tryGetBlockStore();
      if (!store) return;
      const activeId = store.getActiveBlockId();
      if (activeId === null) return;
      // Audit P0 (fix 1): positive-confirmation posture. We require the
      // lookup to be registered AND resolve to this session id before we
      // touch the active pointer. If the lookup is null (bootstrap ordering
      // race where `bindBlockEntity` has not registered yet) or returns
      // undefined (block entity gone, unknown id), we leave the pointer
      // alone — the owning session's router is responsible for clearing it.
      if (blockSessionLookup === null) return;
      const blockSessionId = blockSessionLookup(activeId);
      if (blockSessionId === sessionId) {
        store.setActiveBlockId(null);
      }
    },
  };
}

/**
 * Optional hook the block entity adapter registers so the router can resolve
 * an active block id back to its owning session. Keeping this as a nullable
 * port (instead of importing the block store directly) preserves the FSD
 * separation — the port knows the block store's shape, the router does not.
 */
type BlockSessionLookup = (blockId: BlockId) => SessionId | undefined;
let blockSessionLookup: BlockSessionLookup | null = null;

export function setRouterBlockSessionLookup(
  lookup: BlockSessionLookup | null,
): void {
  blockSessionLookup = lookup;
}

/** Whether a router is currently installed for the given session. */
export function isCommandRouterInstalled(sessionId: SessionId): boolean {
  return routers.has(sessionId);
}

// ----- Public entry points used by features/session/connect.ts -----

/**
 * Route a pty_data chunk (base64) into the active block for `sessionId`.
 * The boundary detector closes the block when a terminator is observed.
 *
 * No-ops silently when:
 *   - no router is installed for this session (session up before the
 *     orchestrator wired it — bytes are dropped intentionally);
 *   - no block is active (output before the first submit, e.g. shell
 *     greeting);
 *   - the block store is not bound yet (Agent A's adapter hasn't registered).
 */
export function appendToActiveBlock(sessionId: SessionId, bytesB64: string): void {
  const handle = routers.get(sessionId);
  if (!handle) return;
  const store = tryGetBlockStore();
  if (!store) {
    log.debug('drop pty_data: block store not bound');
    return;
  }
  const active = store.getActiveBlockId();
  if (active === null) {
    // Legitimate: shell greeting, motd, idle noise. Drop.
    return;
  }

  const chunk = base64ToBytes(bytesB64);
  // Side-channel: let feature-layer observers (Phase 3 TUI alt-screen
  // detector) inspect the full raw chunk BEFORE boundary detection. The
  // mock prompt terminator never contains alt-screen bytes so passing the
  // full chunk cannot confuse the TUI detector.
  if (rawChunkObservers.size > 0) {
    for (const observer of rawChunkObservers) {
      observer(chunk);
    }
  }

  const { preBoundary, hadBoundary } = handle.detector.feed(chunk);
  if (preBoundary.length > 0) {
    store.appendBlockOutput(active, preBoundary);
  }
  if (hadBoundary) {
    // Mock boundary carries no exit code; use 0 (mock can't fail).
    store.completeBlock(active, 0);
    // Reset the per-block detector so carry bytes from the prior block
    // can't leak into the next.
    handle.detector = createMockBoundaryDetector();
  }
}

/**
 * Finalize whatever is running on session exit. Called from `connect.ts`
 * when a `pty_exit` event arrives. The exit code goes to the currently
 * active block if any; any other running blocks (older ones we somehow
 * never closed) are marked canceled, not completed — we don't know their
 * exit codes.
 */
export function finalizeActiveBlock(
  sessionId: SessionId,
  exitCode: number | null,
  _signal: string | null,
): void {
  if (!routers.has(sessionId)) return;
  const store = tryGetBlockStore();
  if (!store) return;

  const active = store.getActiveBlockId();
  const running = store.getRunningBlockIds();

  for (const id of running) {
    if (id === active) {
      store.completeBlock(id, exitCode);
    } else {
      // A stale block: we never received its boundary and the session is
      // gone. Cancel is the honest state — "we don't know what happened".
      store.cancelBlock(id);
    }
  }
  store.setActiveBlockId(null);
}

// ----- Test hook -----

/** Reset the module to uninstalled state. Exposed for test setup; do not
 *  call from production code. */
export function __resetRouterForTests(): void {
  routers.clear();
  rawChunkObservers.clear();
  blockSessionLookup = null;
  const store = tryGetBlockStore();
  if (store) store.setActiveBlockId(null);
}

/** Re-exported helper so tests can assert the active-block pointer
 *  without reaching into the neighbor module. */
export { getActiveBlockId } from './active-block.js';
export type { BlockId };

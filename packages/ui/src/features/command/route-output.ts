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
import { useTuiStore } from '../../entities/tui/index.js';
import {
  createMockBoundaryDetector,
  type BoundaryDetector,
} from './boundary-detector.js';

const log = createLogger('command.route-output');

/**
 * Default idle-completion window for real-shell sessions, in milliseconds.
 *
 * Rationale: after a command finishes, an interactive zsh (1) flushes any
 * trailing output, (2) redraws its PS1 prompt, and then (3) blocks on user
 * input — at which point the PTY goes silent. Empirically, the flush +
 * redraw on a local machine completes in tens of milliseconds; 400 ms gives
 * ~10x headroom for remote SSH / slow-themed prompts while still feeling
 * snappy to the user (no noticeable delay before the spinner stops). We
 * pick the low end of the range because the auto-complete is recoverable
 * (any late byte re-enters `appendToActiveBlock`, which would go to the
 * next block — acceptable noise) whereas a long idle window keeps the
 * spinner running unnecessarily.
 *
 * Exported so tests can reference it via `vi.useFakeTimers` and so future
 * settings panels can surface it as a tunable without reaching into the
 * router internals.
 */
export const IDLE_COMPLETE_MS = 400;

// ----- Per-session router state -----

interface RouterHandle {
  readonly sessionId: SessionId;
  /**
   * Per-block boundary detector. Replaced when a new block opens via
   * `createDetector`. May be `null` — see `createDetector` below.
   *
   * Why nullable: the phase-2 mock detector scans every chunk for
   * `MOCK_PROMPT_BYTES` (an ANSI-escaped cyan `$` glyph followed by a
   * space). That byte sequence is the synthetic terminator the in-browser
   * mock bridge emits after every command. In a REAL zsh session spawned
   * via the Tauri sidecar, zsh emits its own prompt (user-themed PS1) AND
   * the OSC 133 shell-integration script is usually not installed yet — so
   * the real byte stream never contains this exact terminator intentionally
   * but can legitimately contain it by coincidence (colored `$` glyphs in
   * oh-my-zsh themes, styled git-status prompts, colored command output,
   * etc.). A false-positive match mid-stream makes the router slice the
   * chunk, close the active block prematurely, and DROP all bytes that
   * follow the false terminator (see the "trailing bytes are discarded"
   * branch in `createMockBoundaryDetector`). That is the root cause of the
   * user-visible "ls → lls", "cd data → s" / "cd d" command-mangling bug.
   *
   * The fix: allow the install site to opt OUT of the mock detector for
   * real-shell sessions. When `detector === null`, PTY bytes flow
   * unconditionally to the active block and block close is driven only by
   * `pty_exit` (via `finalizeActiveBlock`) or by `submitCommand` cancelling
   * the previous running block. This is conservative — without a real
   * boundary signal (OSC 133 D, or an authoritative prompt-regex detector)
   * the next command's output will glom onto the previous block visually —
   * but it is strictly safer than mis-splitting blocks and silently
   * truncating command text. OSC 133 detection is the phase-2 follow-up
   * that will supply the real `BoundaryDetector` implementation here.
   */
  detector: BoundaryDetector | null;
  /**
   * Factory used to create a fresh detector every time a block boundary
   * closes, or on install. Centralised here so the "reset on boundary"
   * branch does not have to know which detector variant the router was
   * installed with. Returns `null` to mean "no detector at all" (the real-
   * shell case above).
   */
  createDetector: () => BoundaryDetector | null;
  /**
   * Idle-completion timer. Real-shell blocks have no authoritative boundary
   * signal (OSC 133 D detector not yet shipped and mock-prompt scan was
   * disabled to stop the "ls → lls" mangling bug). Without ANY close trigger,
   * interactive zsh sessions never fire `pty_exit` until the window closes,
   * so blocks remain stuck in `running` state forever — the spinner in the
   * block header spins indefinitely and `submitCommand` sees a still-active
   * block when the user runs their next command.
   *
   * The idle timer is the poor-man's boundary signal: after each append,
   * we (re)schedule a timer for `idleTimeoutMs` ms. If no more bytes land
   * in that window, we assume the shell has drawn its prompt and is waiting
   * for input → the command is done → we mark the active block `complete`
   * with exit code 0 (unknown; real exit isn't observable without OSC 133).
   *
   * This is heuristic but robust:
   *   - Any further output re-starts the timer (long-running commands that
   *     pause briefly — e.g. `make` between subtasks — stay `running`).
   *   - `submitCommand` allocates a new active block; when the stale timer
   *     fires, the guard (`activeAtScheduleTime !== store.getActiveBlockId()`)
   *     skips the close.
   *   - Dispose clears the timer so a torn-down session can't fire into a
   *     later install's state.
   */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /**
   * How long to wait after the last append before auto-completing the
   * active block. `null` disables the idle timer entirely — used by the
   * mock bridge (which has its own authoritative terminator) and by tests
   * that want to hand-drive the router.
   */
  idleTimeoutMs: number | null;
}

const routers = new Map<SessionId, RouterHandle>();

/**
 * Normalise the user-supplied `detector` option into a factory that produces
 * a fresh `BoundaryDetector | null` on every call. Three input shapes collapse
 * to one output:
 *
 *   - `undefined` → `createMockBoundaryDetector` (legacy default).
 *   - `null`      → `() => null` (the real-shell opt-out).
 *   - `() => …`   → used verbatim.
 *
 * Returning a direct `BoundaryDetector` instance as `detector` is NOT allowed
 * via the option (it would be reused across blocks and leak carry state). A
 * factory forces fresh-per-block semantics at the type level.
 */
function resolveDetectorFactory(
  option: InstallCommandRouterOptions['detector'],
): () => BoundaryDetector | null {
  if (option === undefined) return () => createMockBoundaryDetector();
  if (option === null) return () => null;
  // Factory: fresh detector per block. The option type disallows a raw
  // `BoundaryDetector` instance because reusing one across blocks would
  // leak the previous block's carried-prefix state into the next block.
  return option;
}

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
 *
 * Mirrors the production fan-out's isolation semantics: if one observer
 * throws, the router logs at `error` and keeps walking the rest. This
 * keeps the test helper faithful to real behavior so a test that exercises
 * multi-observer interaction does not have to reason about two different
 * error-propagation rules.
 */
export function __emitRawChunkForTests(chunk: Uint8Array): void {
  for (const observer of rawChunkObservers) {
    try {
      observer(chunk);
    } catch (err) {
      log.error('raw observer threw, isolating', err);
    }
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
/**
 * Options for `installCommandRouter`.
 *
 * `detector` (optional):
 *   - `undefined` (default) — legacy/mock-bridge behavior: install a fresh
 *     `createMockBoundaryDetector()` and regenerate one on every boundary.
 *     Used by the in-browser mock bridge and by every pre-existing test
 *     site that relies on `MOCK_PROMPT_BYTES` closing blocks.
 *   - `null` — no boundary detection. PTY bytes flow unconditionally to the
 *     active block; blocks close via `pty_exit` / next-submit cancel only.
 *     Use this for real-shell sessions until an OSC-133-based detector
 *     ships. This is the fix for the real-shell command-mangling bug
 *     documented on `RouterHandle.detector`.
 *   - a function — called once on install and again after every boundary
 *     to produce a fresh detector instance (per-block lifecycle). Reserved
 *     for the OSC 133 detector and for custom test detectors.
 */
export interface InstallCommandRouterOptions {
  /**
   * Boundary detection strategy. `null` disables boundary scanning entirely
   * (real-shell fallback). A factory function is invoked once on install and
   * again after every boundary so the detector is per-block (the shared-
   * instance variant would leak carry state between blocks). Omit to keep
   * the legacy mock-bridge behavior.
   */
  readonly detector?: null | (() => BoundaryDetector | null);
  /**
   * Optional idle-timeout (ms) after which the active block is auto-completed
   * if no new output arrives. Designed for real-shell sessions that have no
   * authoritative close signal; the interactive shell stops emitting bytes
   * once its prompt is drawn, and that silence is our proxy for "command
   * finished". Set to a positive number (e.g. 600) for real shells; leave
   * undefined or pass `null` to disable (mock bridge, tests). The router
   * resets this timer on every append and clears it on dispose.
   */
  readonly idleCompletionMs?: number | null;
}

export function installCommandRouter(
  sessionId: SessionId,
  options: InstallCommandRouterOptions = {},
): { dispose: () => void } {
  if (routers.has(sessionId)) {
    log.debug('installCommandRouter: replacing existing router for', sessionId);
    // Re-install replaces the handle; ensure any pending idle timer on the
    // stale handle is cleared so it cannot fire against the fresh one's
    // state (the guard in `scheduleIdleCompletion` would catch a stray fire
    // via the activeAtScheduleTime check, but proactively clearing is
    // cheaper and deterministic).
    const existing = routers.get(sessionId);
    if (existing?.idleTimer !== null && existing?.idleTimer !== undefined) {
      clearTimeout(existing.idleTimer);
    }
  }
  const createDetector = resolveDetectorFactory(options.detector);
  const idleTimeoutMs =
    options.idleCompletionMs === undefined ? null : options.idleCompletionMs;
  const handle: RouterHandle = {
    sessionId,
    detector: createDetector(),
    createDetector,
    idleTimer: null,
    idleTimeoutMs,
  };
  routers.set(sessionId, handle);
  return {
    dispose: () => {
      // If a later install replaced us, we are a stale handle. Do nothing —
      // deleting the live entry or clearing the active pointer would stomp
      // state the current router owns.
      if (routers.get(sessionId) !== handle) return;
      routers.delete(sessionId);

      // Clear any pending idle-completion timer so it cannot fire after
      // dispose and land a completeBlock on a freshly-installed successor's
      // active block. (The successor would have its own active pointer
      // different from ours, so the guard would skip, but we still do not
      // want stray timers lying around.)
      if (handle.idleTimer !== null) {
        clearTimeout(handle.idleTimer);
        handle.idleTimer = null;
      }

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
  const chunk = base64ToBytes(bytesB64);

  const active = store.getActiveBlockId();
  if (active === null) {
    // Legitimate: shell greeting, motd, idle noise. Drop.
    return;
  }

  // Fan out to raw observers AFTER the early-drop guard so observers only
  // see bytes that are actually going to be routed into a block. The TUI
  // detector gets PTY bytes via the bridge subscription (a separate channel),
  // not via these observers, so guarding here is safe.
  //
  // Robustness: observer exceptions MUST NOT break routing — we isolate with
  // try/catch so a throwing observer never skips the boundary detector below
  // (which would leave the active block stuck "running" forever).
  if (rawChunkObservers.size > 0) {
    for (const observer of rawChunkObservers) {
      try {
        observer(chunk);
      } catch (err) {
        log.error('raw observer threw, isolating', err);
      }
    }
  }

  // No-detector branch: real-shell install path. We bypass boundary
  // detection entirely and append the whole chunk to the active block.
  // Block close is driven by `finalizeActiveBlock` on `pty_exit`, by
  // `submitCommand` cancelling the prior active block on the next submit,
  // or (new) by the idle-completion timer below when the shell goes quiet.
  // This is the conservative fallback documented on `RouterHandle.detector`.
  if (handle.detector === null) {
    if (chunk.length > 0) {
      store.appendBlockOutput(active, chunk);
    }
    scheduleIdleCompletion(handle, store, active);
    return;
  }

  const { preBoundary, hadBoundary } = handle.detector.feed(chunk);
  if (preBoundary.length > 0) {
    store.appendBlockOutput(active, preBoundary);
  }
  if (hadBoundary) {
    // Mock boundary carries no exit code; use 0 (mock can't fail).
    store.completeBlock(active, 0);
    // Reset the per-block detector so carry bytes from the prior block
    // can't leak into the next. The factory captured at install time picks
    // the right implementation (mock, null, or a future OSC 133 detector).
    handle.detector = handle.createDetector();
    // An authoritative boundary supersedes any pending idle timer — drop it
    // so it can't double-close or race with the next block's timer.
    if (handle.idleTimer !== null) {
      clearTimeout(handle.idleTimer);
      handle.idleTimer = null;
    }
  } else {
    // Still mid-stream under the detector path. Schedule idle completion
    // in case the detector never fires (e.g. future null-returning factory
    // variant). With `idleTimeoutMs === null` this is a no-op.
    scheduleIdleCompletion(handle, store, active);
  }
}

/**
 * Arm (or re-arm) the idle-completion timer for a handle.
 *
 * Contract:
 *   - If `idleTimeoutMs === null`, do nothing (mock bridge / tests opt out).
 *   - Any prior pending timer is cleared first so the window is measured
 *     from the LATEST append, not the first.
 *   - When the timer fires, we only complete the block when the active
 *     pointer is STILL the same id we scheduled against. If the user
 *     submitted a new command in the meantime, `submitCommand` has
 *     allocated a new active block and closing this older one via a stale
 *     timer would be wrong (and likely already handled by the
 *     prev-block-cancel path inside submit).
 *
 * The handle is captured by closure; even if the session's router is
 * replaced or disposed before the timer fires, the fire-time check against
 * `store.getActiveBlockId()` is the authoritative guard.
 */
function scheduleIdleCompletion(
  handle: RouterHandle,
  // The store at schedule-time is passed for symmetry with the caller's
  // resolved locals, but we intentionally re-resolve through
  // `tryGetBlockStore()` inside the timer callback below so a teardown
  // between schedule and fire cannot use a stale reference. The parameter
  // is deliberately unused at the body level — keeping it here preserves
  // call-site readability (`scheduleIdleCompletion(handle, store, active)`
  // mirrors the variables in scope at every caller) without paying for
  // the resolved-but-unused handle.
  _store: NonNullable<ReturnType<typeof tryGetBlockStore>>,
  active: BlockId,
): void {
  if (handle.idleTimeoutMs === null) return;
  // Alt-screen gate: when the user is inside a TUI program (vim, less,
  // htop…) the PTY legitimately sits idle while the user reads or
  // thinks. Auto-completing the block after 400 ms of idle would stop
  // the spinner and — worse — subsequent output would append to a block
  // the UI considers "done", producing a visibly wrong exit code / exit
  // moment. TUIs also have a natural close signal (`ESC[?1049l` fires
  // `alt_screen_exit` which the orchestrator can route to an explicit
  // block-close). So: no idle-completion while alt-screen is active,
  // and cancel any pending timer that was armed before enter.
  if (useTuiStore.getState().active) {
    if (handle.idleTimer !== null) {
      clearTimeout(handle.idleTimer);
      handle.idleTimer = null;
    }
    return;
  }
  if (handle.idleTimer !== null) clearTimeout(handle.idleTimer);
  const activeAtScheduleTime = active;
  handle.idleTimer = setTimeout(() => {
    handle.idleTimer = null;
    // Re-check alt-screen at fire time too — the user may have entered a
    // TUI between schedule and fire, in which case we must not
    // auto-complete (same reasoning as the schedule-time gate).
    if (useTuiStore.getState().active) return;
    // Re-resolve the store at fire time. The bound store is the same
    // singleton but we take the defensive path in case of test teardown.
    const liveStore = tryGetBlockStore();
    if (!liveStore) return;
    const currentActive = liveStore.getActiveBlockId();
    // Guard: only close when the same block is still active AND non-null.
    // If the user submitted a new command, `currentActive` points at the
    // new block; closing the old one via idle-timer here would either be
    // a no-op (prev-block-cancel already fired) or, worse, close the NEW
    // block. The mismatch check protects against both.
    if (currentActive !== activeAtScheduleTime) return;
    if (currentActive === null) return;
    liveStore.completeBlock(currentActive, 0);
  }, handle.idleTimeoutMs);
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
  const handle = routers.get(sessionId);
  if (!handle) return;
  const store = tryGetBlockStore();
  if (!store) return;

  // Clear any pending idle-completion timer — pty_exit is an authoritative
  // terminal signal and supersedes the idle heuristic. Letting the timer
  // fire later would either be a no-op (active pointer nulled below) or,
  // in a race with a rapid subsequent install, fire against a successor's
  // active block.
  if (handle.idleTimer !== null) {
    clearTimeout(handle.idleTimer);
    handle.idleTimer = null;
  }

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
  // Clear any pending idle timers so they can't fire into a subsequent test's
  // state — stray setTimeouts are the #1 source of cross-test flake here.
  for (const handle of routers.values()) {
    if (handle.idleTimer !== null) {
      clearTimeout(handle.idleTimer);
      handle.idleTimer = null;
    }
  }
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

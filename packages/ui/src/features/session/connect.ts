/**
 * Session connect feature — owns the session spawn/lifecycle wiring.
 *
 * The widget calls `connectSession()` once after mount. It spawns a PTY via
 * the host bridge, wires host events into the session entity, and returns the
 * bridge handles the terminal widget needs for write/resize/close.
 *
 * This is the ONLY subscription path from bridge → store per ADR 0014
 * "architecture invariants". Widgets must not call `bridge.subscribe`
 * directly; they consume state via `useSessionStore` selectors and receive
 * PTY bytes via the `onData` callback owned by this feature.
 *
 * Event ordering guarantee
 * ------------------------
 * We subscribe to the bridge BEFORE calling `spawn()` and buffer any events
 * that arrive before the session id is known. Once `spawn` resolves, we
 * replay the buffer, filter by session id, and then switch to direct fanout.
 * This closes the race where a host emits `pty_data`/`session_created`
 * synchronously during (or immediately after) `spawn()` — without the buffer,
 * those would be dropped.
 *
 * Out-of-order events (e.g. `pty_data` before `session_created`) are handled
 * by the fact that the store is seeded from the `spawn()` reply before the
 * subscription is switched live, so the store always has a valid session id
 * when an event arrives. Events for unknown sessions are dropped with a
 * logger.debug trace.
 *
 * Multi-session (Phase 4)
 * -----------------------
 * Every spawn writes to the MULTI-session collection (`useSessionsStore`).
 * That collection's `addSession` auto-adopts the new entity as active when
 * it is the first session; otherwise the caller (`features/session-tabs`)
 * flips active explicitly after `connectSession` resolves. The legacy
 * singular `useSessionStore` mirrors whichever session is active, so
 * existing call sites that read from it keep working transparently.
 */

import type { HostBridge, HostEvent, SessionId, Subscription } from '@quanta/host-common';
import { isEventOfKind } from '@quanta/host-common';
import { useSessionsStore } from '../../entities/session/index.js';
import { createLogger } from '../../shared/lib/logger.js';
// Cross-slice (production): the session feature hands PTY bytes + exit to the
// command router so the block entity gets appended. The inverse direction is
// also documented in the integration test comment; see
// `features/command/__tests__/session-integration.test.ts`.
import {
  appendToActiveBlock,
  finalizeActiveBlock,
  IDLE_COMPLETE_MS,
  installCommandRouter,
} from '../command/route-output.js'; // FIXME(fsd-layer-skip): session hands pty bytes + exit to command router per documented cross-slice handoff; see also the integration test comment for the inverse direction.
import { tryGetBlockStore } from '../command/block-store-port.js';
// FIXME(fsd-layer-skip): the session feature consults the degraded gate so
// the `ConnectedSession.write` wrapper honors RFC §20 ("input disabled
// during degraded state") for every caller — command/submit today, and
// input-host keystrokes once EPIC-F wires them through this seam.
import { tryGetDegradedGate } from '../degraded-mode/degraded-gate.js';
// Session-record byte bus: optional fan-out of pty_data to the recorder
// controller. The publish is a zero-listener no-op when no recording is live,
// so the hot path stays unaffected for users who never open the recorder.
// FIXME(fsd-layer-skip): cross-feature publish by design — the session-record
// feature subscribes via its own module; connect only emits into the bus.
import { base64ToBytes } from '../../shared/lib/base64.js';
import { publishSessionChunk } from '../session-record/byte-bus.js';
// Session-scoped VT engine (Plan 0005 α1). Every PTY byte feeds the engine
// BEFORE any block/router consumer runs — the engine is the SSOT for grid
// state. In P0 the legacy block-router byte path stays wired in parallel;
// Epic δ will tear it down once TerminalSurface reads from the engine.
import { createSessionEngine, type VtEngineHandle } from './engine.js';
// Plan 0005 Epic δ: block-UX-only paths (preamble block creation, router
// install) gate on `flag.blockUx`. In P0 default, the router never installs
// and no preamble block is seeded, so the block store stays dormant and
// `appendToActiveBlock` short-circuits on "no router installed" with zero
// cost on the hot pty_data path.
import { getFeatureFlag } from '../../shared/config/feature-flags.js';

const log = createLogger('session.connect');

export interface ConnectOptions {
  readonly bridge: HostBridge;
  readonly cols: number;
  readonly rows: number;
  /** Called on every pty_data event. Receives raw base64 bytes. */
  readonly onData: (bytesB64: string) => void;
  /**
   * Optional profile-derived spawn overrides. Fed through verbatim to
   * `bridge.spawn`; the host applies its defaults when any field is
   * omitted. Surfaced here (rather than the feature layer) so any caller
   * that wants to bypass `features/session-tabs.createSession` — e.g. tests
   * or future "open in new pane" actions — can still supply them.
   */
  readonly shell?: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ConnectedSession {
  readonly sessionId: SessionId;
  readonly subscription: Subscription;
  /**
   * Session-scoped VT engine (Plan 0005 α1). Every PTY byte feeds through
   * this engine before any other consumer sees it. Callers may subscribe
   * via `engine.subscribe()` to observe `GridEventEnvelope<GridPayload>`
   * updates (snapshot / delta / mode_changed / …) or read the emulator
   * directly for cell-level inspection.
   *
   * Lifetime matches the connection: the handle is live from the moment
   * `connectSession()` resolves until `close()` returns.
   */
  readonly engine: VtEngineHandle;
  write(text: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export async function connectSession(opts: ConnectOptions): Promise<ConnectedSession> {
  const { bridge, cols, rows, onData, shell, cwd, env } = opts;

  await bridge.ready();

  // α1: build the session-scoped VT engine BEFORE subscribing, so the very
  // first `pty_data` frame (which may arrive synchronously inside the
  // spawn() await) is routed through the engine. The engine is keyed by a
  // stable pre-spawn id until the host hands us the real session id during
  // pre-buffer drain — the id is cosmetic inside the emulator (used only in
  // outgoing envelopes) and is not observed by consumers yet in P0.
  //
  // γ5: the flow-control hook injected into the batcher captures a mutable
  // sessionIdRef because the engine (and its batcher) is constructed BEFORE
  // `spawn()` resolves. The batcher only calls pause/resume AFTER bytes have
  // been enqueued, which by definition is after we have a real sessionId.
  // If the host bridge doesn't implement pause/resume (mock bridge for some
  // adapters, VS Code), we omit `flowControl` entirely so the batcher falls
  // back to emergency-drop once hardCapBytes is crossed.
  const sessionIdRef: { current: SessionId | undefined } = { current: undefined };
  const pauseFn = bridge.pausePty?.bind(bridge);
  const resumeFn = bridge.resumePty?.bind(bridge);
  const flowControl =
    pauseFn && resumeFn
      ? {
          pause: (): void => {
            const id = sessionIdRef.current;
            if (id === undefined) return;
            log.debug('flow-control pause', id);
            pauseFn(id).catch((err) => {
              // Flow-control failures are non-fatal: the batcher still has
              // emergency-drop as a final defense. Log so the outage is
              // observable but never throw — flow control is advisory.
              log.warn('pausePty failed', id, err);
            });
          },
          resume: (): void => {
            const id = sessionIdRef.current;
            if (id === undefined) return;
            log.debug('flow-control resume', id);
            resumeFn(id).catch((err) => {
              log.warn('resumePty failed', id, err);
            });
          },
        }
      : undefined;

  const engine: VtEngineHandle = createSessionEngine({
    sessionId: 'pending',
    cols,
    rows,
    ...(flowControl !== undefined ? { flowControl } : {}),
  });

  // Subscribe FIRST, buffer until we know the session id. The host may emit
  // `pty_data` synchronously inside `spawn()`; without this pre-subscribe we
  // would drop those frames.
  const preBuffer: HostEvent[] = [];
  let sessionId: SessionId | undefined;
  let closed = false;
  // Audit P1 (fix 2): `ended` tracks "the PTY side has emitted its terminal
  // event" (pty_exit / session_ended) as distinct from `closed` (which means
  // the UI explicitly called `close()` and we're tearing down the subscription).
  // After `ended`, we must ignore late-arriving pty_data so it doesn't leak
  // into the next block via `appendToActiveBlock` — the active pointer was
  // cleared in finalize so the bytes currently drop silently, but re-entering
  // dispatch wastes work and future block-of-new-session races could mis-route.
  let ended = false;
  let routerDispose: (() => void) | undefined;

  const subscription = bridge.subscribe((event) => {
    if (closed) return;
    if (sessionId === undefined) {
      preBuffer.push(event);
      return;
    }
    if (!matchesSession(event, sessionId)) return;
    dispatchEvent(event);
  });

  let spawn;
  try {
    // Profile overrides are optional; only forward the fields the caller
    // actually supplied so the host's default-resolution path keeps firing
    // for unset values (matches the SpawnSessionOptions contract that every
    // override field is optional except cols/rows).
    spawn = await bridge.spawn({
      cols,
      rows,
      ...(shell !== undefined && shell.length > 0 ? { shell } : {}),
      ...(cwd !== undefined && cwd.length > 0 ? { cwd } : {}),
      ...(env !== undefined ? { env } : {}),
    });
  } catch (err) {
    subscription.unsubscribe();
    engine.dispose();
    throw err;
  }
  sessionId = spawn.sessionId;
  // Publish the real sessionId into the closure captured by the flow-control
  // hook so subsequent pause()/resume() firings route to the right PTY.
  sessionIdRef.current = sessionId;

  // Install the command router BEFORE draining the pre-buffer: pty_data that
  // arrived synchronously during spawn() needs a live router to land on the
  // active block. The disposer is scoped to this session id so a sibling
  // session's router is untouched on close().
  //
  // Boundary-detector selection (real-shell mangling fix):
  // ------------------------------------------------------
  // The legacy (and still-default) router installs a mock-prompt boundary
  // detector that scans every chunk for `MOCK_PROMPT_BYTES`
  // (ESC[36m $ ESC[0m SPACE). That sequence is what the in-browser mock
  // bridge emits after every command; a real zsh spawned by the Tauri
  // sidecar produces no such marker on purpose, and the OSC 133 shell
  // integration script is typically not installed yet (the user sees the
  // "Shell integration is not installed" banner). Real PTY output can
  // nonetheless match this byte sequence by coincidence — coloured `$`
  // glyphs from oh-my-zsh themes, styled git-status prompts, or any ANSI
  // SGR-reset surrounding a `$` in stdout. Every false-positive match
  // silently closed the active block mid-stream and dropped the bytes
  // after the match (route-output's "trailing bytes discarded" branch),
  // producing the "ls → lls", "cd data → s" / "cd d" command-mangling
  // symptoms reported by users.
  //
  // Until an OSC 133 D detector ships, the safest policy for real shells
  // is: don't scan at all. We pick the mock detector when the spawn result
  // identifies the mock bridge (shell `/bin/mock`), and otherwise pass
  // `detector: null` so bytes flow verbatim to the active block.
  //
  // Block-close signals for the real-shell path:
  //   1. `pty_exit` (authoritative, arrives when the PTY fully tears down —
  //      basically only on shell quit, NOT between commands in an
  //      interactive zsh);
  //   2. the next-submit cancel path inside `submitCommand`;
  //   3. idle auto-complete: if `idleCompletionMs` ms pass with no bytes,
  //      the router calls `completeBlock(active, 0)` on the assumption that
  //      the shell has drawn its prompt and is waiting for input. Without
  //      (3), interactive sessions never see (1) between commands and the
  //      block spinner spins forever. The idle window is a heuristic — see
  //      the `IDLE_COMPLETE_MS` rationale in `route-output.ts`.
  const isMockBridge = spawn.shell === '/bin/mock';
  // Epic δ P0: the command router is a block-UX-only path (it appends pty
  // bytes into the active block's output buffer). Skip install when
  // `flag.blockUx` is off so the session runs without any block-store
  // coupling — pty_data flows engine-only, which is the P0 shipping
  // surface. In P1, re-install happens on flag flip by re-mounting the
  // session (no hot-swap needed).
  if (getFeatureFlag('blockUx')) {
    routerDispose = installCommandRouter(
      sessionId,
      isMockBridge
        ? {}
        : { detector: null, idleCompletionMs: IDLE_COMPLETE_MS },
    ).dispose;
  }

  // Seed the entity in the collection. `addSession` is a no-op if the id is
  // already known, so double-mount or late replay stays idempotent. We
  // deliberately pass `health: 'ready'` — the spawn has returned, the PTY is
  // live. Phase-1–3 callers relied on the singular mirror to see this
  // transition; they still do, via the mirror subscription.
  useSessionsStore.getState().addSession({
    id: sessionId,
    shell: spawn.shell,
    cwd: spawn.cwd,
    cwdSource: 'launch',
    shellIntegration: 'missing',
    health: 'ready',
    exitCode: null,
    // Surfaced by the Tauri bridge when `/proc/version` carries the WSL token.
    // Unknown → treat as not-WSL so the default-false seed stays authoritative.
    isWsl: spawn.isWsl === true,
  });

  // Create an initial "preamble" block with an empty command so the shell
  // greeting (macOS "Last login: …" + the first PS1 prompt) is captured and
  // rendered natively — just like opening Terminal.app. The block has no
  // command header chrome (hidden via CSS on empty command) and closes via
  // the idle-completion timer once the shell finishes drawing its prompt.
  //
  // Epic δ P0: block-UX-only. Without a block presentation layer nothing
  // reads the preamble block anyway, and seeding it would leak a dormant
  // running-block into the store for callers that inspect it.
  if (getFeatureFlag('blockUx')) {
    try {
      const blockStore = tryGetBlockStore();
      if (blockStore) {
        blockStore.startBlock('', spawn.cwd, { sessionId });
      }
    } catch (err) {
      log.debug('preamble block creation skipped', err);
    }
  }

  // Drain the pre-buffer in original order, keeping events that match the
  // session we just got. A verbose debug log makes out-of-order diagnosis
  // trivial in dev builds — production strips it.
  if (preBuffer.length > 0) {
    log.debug('replaying', preBuffer.length, 'buffered events for', sessionId);
    for (const ev of preBuffer) {
      if (matchesSession(ev, sessionId)) dispatchEvent(ev);
    }
    preBuffer.length = 0;
  }

  return {
    sessionId,
    subscription,
    engine,
    async write(text) {
      // RFC §20 / ADR 0010: in degraded state the wrapper drops the bytes
      // and increments the telemetry counter. Skipping the bridge call is
      // conservative — any future capability-checked redirect (§20 "input
      // is either disabled OR explicitly redirected only after capability
      // check") would land here.
      const gate = tryGetDegradedGate();
      if (gate?.isDegraded()) {
        gate.reportDroppedInput();
        log.debug('write dropped: session is degraded', sessionId);
        return;
      }
      await bridge.write(sessionId, text);
    },
    async resize(nextCols, nextRows) {
      // α1: resize the engine grid alongside the PTY. Engine-side resize
      // is synchronous so the next `feed()` observes the new dimensions
      // without an rAF lag; the bridge.resize call updates the kernel
      // TIOCSWINSZ. Both can run in parallel — the emulator doesn't
      // require the kernel to have acked the new size.
      engine.resize(nextCols, nextRows);
      await bridge.resize(sessionId, nextCols, nextRows);
    },
    async close() {
      if (closed) return;
      closed = true;
      // α1 teardown order (NOTE the race discussion in engine.ts):
      //   1. unsubscribe the bridge so no new pty_data can enter after
      //      dispose runs. This closes the window where a late event
      //      would race engine.dispose().
      //   2. dispose the engine (flushes any queued bytes through the
      //      emulator, then cancels the rAF trampoline and releases
      //      subscribers). Safe to call before bridge.close() because
      //      the emulator no longer has any subscribers that could call
      //      back into bridge.write().
      //   3. router dispose — belongs AFTER engine dispose so a final
      //      emulator flush cannot re-enter the router path.
      //   4. bridge.close() — the PTY tear-down itself; may emit a final
      //      pty_exit that our unsubscribed listener will no longer see.
      subscription.unsubscribe();
      engine.dispose();
      if (routerDispose) {
        routerDispose();
        routerDispose = undefined;
      }
      try {
        await bridge.close(sessionId);
      } catch (err) {
        log.warn('close() failed for', sessionId, err);
      }
    },
  };

  // ----- helpers -----

  function dispatchEvent(event: HostEvent): void {
    // Audit P1 (fix 2): early-return once the PTY has signaled its terminal
    // event. Any `pty_data` that arrives after `pty_exit` / `session_ended`
    // is a late-flush tail from the host and would wastefully re-enter the
    // append path; worse, if a new block is started immediately after, it
    // could land the tail on the wrong block.
    if (ended) return;
    if (isEventOfKind(event, 'pty_data')) {
      // α1 ordering: decode ONCE, feed the engine FIRST, then fan out.
      // The engine is the SSOT for grid state; downstream consumers in
      // later epics will read from it. In P0 the legacy block-router
      // and session-record bus still consume the raw bytes directly —
      // they run AFTER the engine on the same event so their view of
      // the stream can never be ahead of the engine's.
      let decoded: Uint8Array | null = null;
      try {
        decoded = base64ToBytes(event.bytesB64);
      } catch {
        // Malformed base64: nothing downstream can do with these bytes.
        // Bail out so the router / engine are not fed garbage.
        decoded = null;
      }
      if (decoded !== null && decoded.byteLength > 0) {
        engine.feed(decoded);
      }
      if (sessionId !== undefined) {
        // Fanout: the command router must see the bytes so the active
        // block accrues output. The `onData` callback is an inert hook
        // retained for call-site stability (historical-xterm-reference:
        // pre-EPIC-I it fed the xterm fallback surface; the custom VT
        // engine now owns rendering end-to-end).
        appendToActiveBlock(sessionId, event.bytesB64);
        // Session-record fan-out: publish the decoded chunk to the byte
        // bus so an in-flight asciicast recorder can capture it. The
        // publish is a zero-cost no-op when there is no subscriber.
        if (decoded !== null) {
          try {
            publishSessionChunk(sessionId, decoded, Date.now());
          } catch {
            // A recorder failure must not derail the block-router fanout.
          }
        }
      }
      onData(event.bytesB64);
      return;
    }
    if (isEventOfKind(event, 'pty_exit')) {
      // Audit P1 (fix 2): flip the `ended` flag BEFORE any further work so
      // that a re-entrant dispatch (host-side synchronous event emission)
      // from inside finalize/patch can't slip past the early-return above.
      ended = true;
      // Finalize the active block AND cancel stragglers via the router
      // before we touch the session store. The router is idempotent when
      // no router is installed (dead-letter safety).
      if (sessionId !== undefined) {
        finalizeActiveBlock(sessionId, event.exitCode, event.signal);
      }
      // A signal-caused exit (`exitCode === null && signal !== null`) is a
      // crash from the user's point of view. Surface it as `error` health so
      // the banner detector raises the crash banner — otherwise the exit
      // would look clean (exit code 0) and the user would see no warning.
      const isCrash =
        (event.exitCode === null && event.signal !== null) ||
        (event.exitCode !== null && event.exitCode > 128);
      if (sessionId !== undefined) {
        if (isCrash) {
          useSessionsStore.getState().patchSession(sessionId, {
            health: 'error',
            exitCode: event.exitCode,
          });
        } else {
          useSessionsStore.getState().markExited(sessionId, event.exitCode);
        }
      }
      return;
    }
    if (isEventOfKind(event, 'session_cwd_changed')) {
      if (sessionId !== undefined) {
        useSessionsStore.getState().patchSession(sessionId, {
          cwd: event.cwd,
          cwdSource: event.source,
        });
      }
      return;
    }
    if (isEventOfKind(event, 'session_shell_integration_status')) {
      if (sessionId !== undefined) {
        useSessionsStore.getState().patchSession(sessionId, {
          shellIntegration: event.status,
        });
      }
      return;
    }
    if (isEventOfKind(event, 'session_created')) {
      if (sessionId !== undefined) {
        useSessionsStore.getState().patchSession(sessionId, {
          shell: event.shell,
          cwd: event.launchCwd,
        });
      }
      return;
    }
    if (isEventOfKind(event, 'session_ended')) {
      // Audit P1 (fix 2): same rationale as pty_exit — session_ended is a
      // terminal signal, flag it so any trailing pty_data is ignored.
      ended = true;
      if (sessionId !== undefined) {
        useSessionsStore.getState().markExited(sessionId, null);
      }
      return;
    }
    // input_submitted is a client-originated event echoed back; ignored at the
    // session level. Block-scoped consumers will handle it when block UI lands.
  }
}

/**
 * Gate events to the session we own. Every current `HostEvent` variant carries
 * `sessionId`, but this is a forward-compatible guard: future session-less
 * host events (e.g. global shell-integration rescan) should not accidentally
 * fan into every connected session — they return `true` so a caller that
 * explicitly wants to handle the global event can.
 */
function matchesSession(event: HostEvent, sessionId: SessionId): boolean {
  const id = (event as { sessionId?: SessionId }).sessionId;
  if (id === undefined) return true;
  return id === sessionId;
}

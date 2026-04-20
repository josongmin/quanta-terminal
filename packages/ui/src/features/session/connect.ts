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
// FIXME(fsd-layer-skip): the session feature consults the degraded gate so
// the `ConnectedSession.write` wrapper honors RFC §20 ("input disabled
// during degraded state") for every caller — command/submit today, and
// input-host keystrokes once EPIC-F wires them through this seam.
import { tryGetDegradedGate } from '../degraded-mode/degraded-gate.js';

const log = createLogger('session.connect');

export interface ConnectOptions {
  readonly bridge: HostBridge;
  readonly cols: number;
  readonly rows: number;
  /** Called on every pty_data event. Receives raw base64 bytes. */
  readonly onData: (bytesB64: string) => void;
}

export interface ConnectedSession {
  readonly sessionId: SessionId;
  readonly subscription: Subscription;
  write(text: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
}

export async function connectSession(opts: ConnectOptions): Promise<ConnectedSession> {
  const { bridge, cols, rows, onData } = opts;

  await bridge.ready();

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
    spawn = await bridge.spawn({ cols, rows });
  } catch (err) {
    subscription.unsubscribe();
    throw err;
  }
  sessionId = spawn.sessionId;

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
  routerDispose = installCommandRouter(
    sessionId,
    isMockBridge
      ? {}
      : { detector: null, idleCompletionMs: IDLE_COMPLETE_MS },
  ).dispose;

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
  });

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
      await bridge.resize(sessionId, nextCols, nextRows);
    },
    async close() {
      if (closed) return;
      closed = true;
      subscription.unsubscribe();
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
      if (sessionId !== undefined) {
        // Fanout: the command router must see the bytes so the active
        // block accrues output. The `onData` callback is an inert hook
        // retained for call-site stability (historical-xterm-reference:
        // pre-EPIC-I it fed the xterm fallback surface; the custom VT
        // engine now owns rendering end-to-end).
        appendToActiveBlock(sessionId, event.bytesB64);
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

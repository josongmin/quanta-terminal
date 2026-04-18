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
  installCommandRouter,
} from '../command/route-output.js'; // FIXME(fsd-layer-skip): session hands pty bytes + exit to command router per documented cross-slice handoff; see also the integration test comment for the inverse direction.

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
  routerDispose = installCommandRouter(sessionId).dispose;

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
    if (isEventOfKind(event, 'pty_data')) {
      if (sessionId !== undefined) {
        // Dual-fanout: the xterm fallback path (onData callback) must see
        // the raw base64 so alt-screen / TUI rendering keeps working, AND
        // the command router must see the same bytes so the active block
        // accrues output. Order: router first, so TUI detection observes
        // the chunk before the xterm surface writes (alt-screen flip).
        appendToActiveBlock(sessionId, event.bytesB64);
      }
      onData(event.bytesB64);
      return;
    }
    if (isEventOfKind(event, 'pty_exit')) {
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

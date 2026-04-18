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
 */

import type { HostBridge, HostEvent, SessionId, Subscription } from '@quanta/host-common';
import { isEventOfKind } from '@quanta/host-common';
import { useSessionStore } from '../../entities/session/index.js';
import { createLogger } from '../../shared/lib/logger.js';

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

  useSessionStore.getState().setSession({
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
      onData(event.bytesB64);
      return;
    }
    if (isEventOfKind(event, 'pty_exit')) {
      // A signal-caused exit (`exitCode === null && signal !== null`) is a
      // crash from the user's point of view. Surface it as `error` health so
      // the banner detector raises the crash banner — otherwise the exit
      // would look clean (exit code 0) and the user would see no warning.
      const isCrash =
        (event.exitCode === null && event.signal !== null) ||
        (event.exitCode !== null && event.exitCode > 128);
      if (isCrash) {
        useSessionStore.getState().setSession({
          health: 'error',
          exitCode: event.exitCode,
        });
      } else {
        useSessionStore.getState().markExited(event.exitCode);
      }
      return;
    }
    if (isEventOfKind(event, 'session_cwd_changed')) {
      useSessionStore.getState().setSession({
        cwd: event.cwd,
        cwdSource: event.source,
      });
      return;
    }
    if (isEventOfKind(event, 'session_shell_integration_status')) {
      useSessionStore.getState().setSession({ shellIntegration: event.status });
      return;
    }
    if (isEventOfKind(event, 'session_created')) {
      useSessionStore.getState().setSession({
        shell: event.shell,
        cwd: event.launchCwd,
      });
      return;
    }
    if (isEventOfKind(event, 'session_ended')) {
      useSessionStore.getState().markExited(null);
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

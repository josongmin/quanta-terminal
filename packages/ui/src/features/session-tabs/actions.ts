/**
 * Multi-session lifecycle actions: create / close / switch.
 *
 * These three functions are the only way widgets and keymap handlers should
 * mutate the session graph in Phase 4. They compose the existing
 * `connectSession` feature with the `useSessionsStore` collection and the
 * feature-scoped `connection-map`. Splitting them from the widget code
 * means the SessionTabs UI can be swapped or A/B-tested without changing
 * lifecycle semantics.
 *
 * Contract
 * --------
 * - `createSession` resolves once the PTY spawn finishes and the new session
 *   has been added to the store + made active. Returns the new session id.
 * - `closeSession` is idempotent: calling with an unknown or already-closed
 *   id is a no-op. It pulls the connection handle out of the map BEFORE
 *   awaiting `close()` so a concurrent call can't double-close.
 * - `switchSession` updates `activeId` in the collection; the legacy
 *   singular mirror reacts via subscription. No connection is torn down.
 *
 * Error handling
 * --------------
 * A failed spawn rejects the `createSession` promise and does NOT leak a
 * half-registered entity. Callers (keymap handler) surface the failure via
 * their existing banner path.
 */

import type { HostBridge, SessionId } from '@quanta/host-common';
import { useSessionsStore } from '../../entities/session/index.js';
// Cross-slice: session-tabs composes the session connect feature. Both live
// under `features/`; we skip the sibling rule the same way features/composer
// imports features/command — Phase 4 PTY lifecycle is owned by session, and
// session-tabs is its orchestration caller.
// FIXME(fsd-layer-skip): session-tabs composes the session connect feature for PTY lifecycle
import { connectSession, type ConnectedSession } from '../session/index.js';
import {
  getConnection,
  registerConnection,
  takeConnection,
} from './connection-map.js';
import { createLogger } from '../../shared/lib/logger.js';

const log = createLogger('session-tabs.actions');

export interface CreateSessionOptions {
  readonly bridge: HostBridge;
  readonly cols: number;
  readonly rows: number;
  readonly onData: (sessionId: SessionId, bytesB64: string) => void;
}

export interface CreateSessionResult {
  readonly sessionId: SessionId;
  readonly connection: ConnectedSession;
}

/**
 * Spawn a new session, register its connection, and make it active. The
 * `onData` callback receives the new session's id so the caller
 * (TerminalPage) can route bytes to per-session listeners. Post-EPIC-I
 * the callback is advisory — the custom VT engine consumes the bytes
 * via the `GridMirror`; the callback is retained for test hooks.
 */
export async function createSession(
  options: CreateSessionOptions,
): Promise<CreateSessionResult> {
  const { bridge, cols, rows, onData } = options;
  // `connectSession` seeds the collection via `addSession` internally. If no
  // session was active before, the new one auto-adopts as active. Otherwise
  // we flip active explicitly so Cmd+T visibly switches to the new tab.
  const hadActiveBefore = useSessionsStore.getState().activeId !== null;
  let resolvedSessionId: SessionId | undefined;
  const connection = await connectSession({
    bridge,
    cols,
    rows,
    onData: (bytesB64) => {
      // We only know the sessionId AFTER connectSession resolves. Until then
      // there's no data (spawn hasn't returned yet), so the fallback path is
      // never hit in practice — guarded anyway for forward safety.
      if (resolvedSessionId !== undefined) onData(resolvedSessionId, bytesB64);
    },
  });
  resolvedSessionId = connection.sessionId;
  registerConnection(connection.sessionId, connection);
  if (hadActiveBefore) {
    useSessionsStore.getState().setActive(connection.sessionId);
  }
  return { sessionId: connection.sessionId, connection };
}

/**
 * Close a session. Removes it from the tab list AND terminates the PTY.
 * Safe to call from both the tab `×` button and the `Cmd+W` keymap — a
 * double invocation is idempotent.
 */
export async function closeSession(id: SessionId): Promise<void> {
  const conn = takeConnection(id);
  // Remove from the store BEFORE awaiting close() so the tab disappears
  // immediately from a user perspective; the PTY shutdown happens in the
  // background. If close() rejects we still want the tab gone — the
  // alternative (keep a dead tab visible until close rejects) is worse UX.
  useSessionsStore.getState().removeSession(id);
  if (!conn) return;
  try {
    await conn.close();
  } catch (err) {
    log.warn('closeSession: connection.close() rejected for', id, err);
  }
}

/**
 * Switch the active session. No connection is closed. Sessions keep running
 * in the background and their output continues to flow into their respective
 * blocks via the per-session command router.
 */
export function switchSession(id: SessionId): void {
  useSessionsStore.getState().setActive(id);
}

/** Convenience re-export so widgets can look up a handle without importing
 *  the internal connection-map module. */
export function getSessionConnection(id: SessionId): ConnectedSession | undefined {
  return getConnection(id);
}

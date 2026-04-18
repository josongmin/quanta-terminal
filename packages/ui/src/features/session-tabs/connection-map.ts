/**
 * Session ↔ ConnectedSession registry.
 *
 * The multi-session store (`entities/session/sessions-store.ts`) holds only
 * SERIALIZABLE domain state: id, shell, cwd, health, etc. Live `ConnectedSession`
 * handles (with subscriptions, write/resize/close closures, and a bridge
 * reference) are NOT serializable and deliberately do not live in any store —
 * putting them there would break zustand's snapshot assumptions and make
 * devtools / future persistence layers explode.
 *
 * This module is the tiny feature-owned map that keeps those handles around.
 * It is module-scoped, mutated only by `features/session-tabs/` actions, and
 * never reaches across to other features directly — those go through the
 * store (domain state) or through this feature's exported action surface.
 *
 * Lifecycle
 * ---------
 * `register`   — called right after a `connectSession` succeeds.
 * `take`       — returns AND removes the handle; used on close so a second
 *                 close() call can't race the first.
 * `get`        — non-destructive lookup (`submitCommand` reads via here).
 * `clearAll`   — test-only teardown.
 */

import type { SessionId } from '@quanta/host-common';
// Cross-slice type import: `ConnectedSession` is produced by the session
// feature's connect flow; the session-tabs feature holds those handles so
// close/write/resize can be invoked later. Type-only, no runtime coupling.
// FIXME(fsd-layer-skip): session-tabs holds session feature's ConnectedSession type
import type { ConnectedSession } from '../session/index.js';

const connections = new Map<SessionId, ConnectedSession>();

export function registerConnection(id: SessionId, conn: ConnectedSession): void {
  connections.set(id, conn);
}

export function getConnection(id: SessionId): ConnectedSession | undefined {
  return connections.get(id);
}

/** Return and remove the handle atomically. Used by `closeSession`. */
export function takeConnection(id: SessionId): ConnectedSession | undefined {
  const conn = connections.get(id);
  if (conn !== undefined) connections.delete(id);
  return conn;
}

export function hasConnection(id: SessionId): boolean {
  return connections.has(id);
}

export function connectionIds(): readonly SessionId[] {
  return Array.from(connections.keys());
}

/** Test-only reset. */
export function __resetConnectionMapForTests(): void {
  connections.clear();
}

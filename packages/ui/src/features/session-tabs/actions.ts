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
import {
  getDefaultSessionProfile,
  getSessionProfile,
  type SessionProfile,
} from '../../entities/session-profile/index.js';
// Cross-slice: startup-commands delivery funnels through the single submit
// path so the commands populate history identically to a user keystroke.
// FIXME(fsd-layer-skip): session-tabs composes the command submit feature to
// dispatch profile startup commands once the PTY reports ready.
import { submitCommand } from '../command/index.js';
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
// Plan 0005 Epic δ: startup commands are a block-UX-only affordance —
// they feed through `submitCommand` which expects the block surface. In P0
// default the submission would write to the PTY without producing any
// visible block, so we skip entirely when the flag is off. Re-enabled the
// moment `flag.blockUx` flips on (next session spawn picks it up).
import { getFeatureFlag } from '../../shared/config/feature-flags.js';

const log = createLogger('session-tabs.actions');

export interface CreateSessionOptions {
  readonly bridge: HostBridge;
  readonly cols: number;
  readonly rows: number;
  readonly onData: (sessionId: SessionId, bytesB64: string) => void;
  /**
   * Optional session profile. Accepts either:
   *   - a `SessionProfile` object (caller already resolved it, e.g. picker UI);
   *   - a profile id string — looked up in `useSessionProfiles`, silently
   *     falling back to the default profile if the id is unknown;
   *   - `undefined` — resolves to the current default profile.
   *
   * The built-in Default profile carries no overrides, so `createSession`
   * without a profile argument behaves identically to the pre-profiles API:
   * host defaults for shell/cwd/env.
   */
  readonly profile?: SessionProfile | string;
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
  const { bridge, cols, rows, onData, profile } = options;
  // Resolve the profile once up front. A string id that doesn't exist in the
  // profiles store silently falls back to the default — avoids hard-erroring
  // the Cmd+T path over stale UI state (e.g. a profile was deleted between
  // keystroke and spawn).
  const resolvedProfile: SessionProfile =
    typeof profile === 'string'
      ? getSessionProfile(profile) ?? getDefaultSessionProfile()
      : profile ?? getDefaultSessionProfile();
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
    // The default profile carries empty strings / no env — connectSession
    // normalizes empty-string shell/cwd to "omit this field in spawn()", so
    // the host default-resolution still applies when the user picked Default.
    ...(resolvedProfile.shell ? { shell: resolvedProfile.shell } : {}),
    ...(resolvedProfile.cwd ? { cwd: resolvedProfile.cwd } : {}),
    ...(resolvedProfile.env ? { env: resolvedProfile.env } : {}),
  });
  resolvedSessionId = connection.sessionId;
  registerConnection(connection.sessionId, connection);
  if (hadActiveBefore) {
    useSessionsStore.getState().setActive(connection.sessionId);
  }
  // Startup commands: after the session has reached `ready` — which is true
  // the moment `connectSession` resolves (see `features/session/connect.ts`
  // where the entity is seeded with `health: 'ready'` immediately after the
  // spawn reply lands) — feed each configured command through the canonical
  // submit path so they accumulate in the block store and command history
  // exactly as if the user typed them. A small inter-command gap prevents
  // the shell from coalescing two lines into a single prompt and lets each
  // block's boundary-detector latch.
  // Epic δ P0 gate: startup commands flow through `submitCommand`, which
  // requires the block surface. Skip them silently when the flag is off —
  // the user-visible effect is "startup commands wait for P1 (blockUx)".
  const startupCommands = resolvedProfile.startupCommands;
  if (
    startupCommands &&
    startupCommands.length > 0 &&
    getFeatureFlag('blockUx')
  ) {
    void runStartupCommands(bridge, connection.sessionId, startupCommands);
  }
  return { sessionId: connection.sessionId, connection };
}

/**
 * Gap between successive startup-command submissions. Tuned short enough that
 * a user doesn't perceive sequential commands as laggy (50 ms is imperceptible)
 * but long enough for the interactive shell to emit its next prompt marker
 * between them — a zero-gap burst frequently causes the second command's
 * bytes to land on the previous block when OSC 133 boundary markers have not
 * yet arrived. See the boundary-detector discussion in
 * `features/session/connect.ts`.
 */
const STARTUP_COMMAND_GAP_MS = 50;

/**
 * Deliver `commands` to the PTY one at a time, awaiting the canonical
 * {@link submitCommand} path so each one becomes a block and hits history.
 * Failures are swallowed with a warn log — a broken startup command should
 * never derail session creation; the user sees the error attached to the
 * block in the UI via the normal write-failed handling.
 *
 * The active session is flipped to the target before each submission (and
 * restored afterwards) because {@link submitCommand} reads the active
 * session off `useSessionStore` — without this, a user who created Session
 * A (with startup commands) while Session B was active would have the
 * commands land on B's block list.
 */
async function runStartupCommands(
  bridge: HostBridge,
  sessionId: SessionId,
  commands: readonly string[],
): Promise<void> {
  // Import lazily to avoid a circular import with the entities session store.
  const { useSessionStore } = await import('../../entities/session/index.js');
  const previousSingularId = useSessionStore.getState().id;
  for (let i = 0; i < commands.length; i += 1) {
    const cmd = commands[i]!;
    try {
      // Pin the singular-session mirror to the target for the duration of
      // the submit so the block gets stamped with the right session id.
      useSessionStore.getState().setSession({ id: sessionId });
      const result = await submitCommand({ text: cmd, bridge });
      if (!result.ok) {
        log.warn('startup command rejected', sessionId, cmd, result.reason);
      }
    } catch (err) {
      log.warn('startup command threw', sessionId, cmd, err);
    }
    if (i < commands.length - 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, STARTUP_COMMAND_GAP_MS));
    }
  }
  // Restore the previous singular-session pointer so we don't silently steal
  // focus from a session the user was already looking at.
  if (previousSingularId !== null) {
    useSessionStore.getState().setSession({ id: previousSingularId });
  }
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

/**
 * Move the session at `fromIndex` to `toIndex` in the tab row. Thin
 * passthrough to the store action — exists so widgets and keymap handlers
 * call into the `features/session-tabs` action surface rather than reaching
 * through to the store directly. Out-of-range indices / no-op moves are
 * silently ignored by the store.
 */
export function reorderSessions(fromIndex: number, toIndex: number): void {
  useSessionsStore.getState().reorderSessions(fromIndex, toIndex);
}

/**
 * Move the currently active tab by `delta` positions (`+1` right, `-1` left).
 * Clamps at the boundaries; when the active tab is already at the far edge
 * in the requested direction the call is a no-op. Returns `true` when the
 * tab moved, so callers can skip preventDefault when the press would have
 * been inert anyway.
 */
export function moveActiveTabBy(delta: number): boolean {
  if (delta === 0) return false;
  const coll = useSessionsStore.getState();
  if (coll.activeId === null) return false;
  const fromIdx = coll.order.indexOf(coll.activeId);
  if (fromIdx < 0) return false;
  const toIdx = Math.max(0, Math.min(coll.order.length - 1, fromIdx + delta));
  if (toIdx === fromIdx) return false;
  coll.reorderSessions(fromIdx, toIdx);
  return true;
}

/** Convenience re-export so widgets can look up a handle without importing
 *  the internal connection-map module. */
export function getSessionConnection(id: SessionId): ConnectedSession | undefined {
  return getConnection(id);
}

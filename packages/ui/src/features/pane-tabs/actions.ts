/**
 * Pane-tabs actions — orchestrate split/close/focus against the session
 * lifecycle.
 *
 * The pane tree is a PURE UI state holder (entities/pane). Splitting a pane
 * must also spawn a new PTY session; closing a pane must tear one down. This
 * module composes `usePaneStore` with the `session-tabs` action trio so the
 * keymap handlers and the PaneGrid widget stay free of lifecycle glue.
 *
 * Contract
 * --------
 *   - `splitActivePane` spawns a new session, then grafts it into the pane
 *     tree under the current focus. Focus moves to the newly spawned leaf.
 *   - `closeActivePane` removes the currently focused leaf from the tree AND
 *     closes its PTY. When the tree becomes empty the caller (TerminalPage)
 *     is free to spawn a replacement session (mirrors the existing
 *     single-session Cmd+W path).
 *   - `focusPaneByDirection` and `focusPaneSibling` are thin wrappers that
 *     additionally plumb the focused session id into `switchSession`, so
 *     per-session stores (Composer, BlockList, TuiSurface) re-target.
 */

import type { HostBridge, SessionId } from '@quanta/host-common';
import { usePaneStore, type FocusDir, type SplitDir } from '../../entities/pane/index.js';
// Cross-slice: pane-tabs composes the session-tabs feature for PTY lifecycle.
// FIXME(fsd-layer-skip): pane-tabs composes session-tabs for PTY lifecycle
import { createSession, closeSession, switchSession } from '../session-tabs/index.js';
import { createLogger } from '../../shared/lib/logger.js';

const log = createLogger('pane-tabs.actions');

export interface SplitPaneOptions {
  readonly bridge: HostBridge;
  readonly cols: number;
  readonly rows: number;
  readonly onData: (sessionId: SessionId, bytesB64: string) => void;
  readonly dir: SplitDir;
}

/**
 * Split the currently-focused pane. On success, the new session id is
 * returned and the pane tree is updated with focus on the new leaf. On
 * failure, the pane tree is left untouched and the promise rejects.
 */
export async function splitActivePane(options: SplitPaneOptions): Promise<SessionId> {
  const { bridge, cols, rows, onData, dir } = options;
  const result = await createSession({ bridge, cols, rows, onData });
  // Graft the new session into the tree.
  usePaneStore.getState().splitActive(dir, result.sessionId);
  // Mirror the new session into the active-session pointer so the rest of
  // the UI (BlockList, Composer) re-targets.
  switchSession(result.sessionId);
  return result.sessionId;
}

/**
 * Close the active pane. Returns the session id that was torn down, or
 * `null` if the tree was empty. The PTY close runs in the background — the
 * pane tree is updated synchronously so the UI reacts immediately.
 */
export async function closeActivePane(): Promise<SessionId | null> {
  const closedId = usePaneStore.getState().closeActive();
  if (closedId === null) return null;
  try {
    await closeSession(closedId);
  } catch (err) {
    log.warn('closeActivePane: closeSession rejected for', closedId, err);
  }
  // After the close, the new focus leaf determines the active session.
  const next = usePaneStore.getState();
  const activeLeaf = next.root
    ? nodeAtPath(next.root, next.focusPath)
    : null;
  if (activeLeaf && activeLeaf.kind === 'leaf') {
    switchSession(activeLeaf.sessionId);
  }
  return closedId;
}

// Avoids an import cycle if nodeAt ever grows feature-facing sugar.
import { nodeAt as nodeAtPath } from '../../entities/pane/index.js';

/** Move the pane focus in a cardinal direction, then mirror into the active session. */
export function focusPaneByDirection(dir: FocusDir): void {
  usePaneStore.getState().focusNext(dir);
  const s = usePaneStore.getState();
  const leaf = s.root ? nodeAtPath(s.root, s.focusPath) : null;
  if (leaf && leaf.kind === 'leaf') switchSession(leaf.sessionId);
}

/** Move to the next / previous pane in visit order. */
export function focusPaneSibling(delta: 1 | -1): void {
  usePaneStore.getState().focusSibling(delta);
  const s = usePaneStore.getState();
  const leaf = s.root ? nodeAtPath(s.root, s.focusPath) : null;
  if (leaf && leaf.kind === 'leaf') switchSession(leaf.sessionId);
}

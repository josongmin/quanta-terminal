/**
 * External file drag-and-drop → composer bridge.
 *
 * Tauri fires `tauri://drag-drop` (and the companion `drag-enter`,
 * `drag-leave`, `drag-over` events) whenever the user drags files from the
 * OS file manager over the app window. When `dragDropEnabled: true` is set
 * on the window (see `src-tauri/tauri.conf.json`), the event payload's
 * `paths` array contains the absolute paths of the dropped files.
 *
 * This module subscribes via the webview-scoped `getCurrentWebviewWindow()
 * .onDragDropEvent` helper (the Tauri 2 API that unifies the three drag
 * sub-events into a single `DragDropEvent` union) and dispatches each
 * dropped path into the composer through the `@quanta/ui` insertion bus —
 * shell-quoted when it contains characters that need escaping, joined by a
 * single space so `mv a.txt b.txt` reads naturally. The widget owns the
 * actual state update; this module stays a thin I/O seam.
 *
 * Failure handling: a non-Tauri runtime (test, browser mock) throws from
 * `getCurrentWebviewWindow` or does not fire drag events. We swallow the
 * setup error and return a no-op `dispose` so callers can install this
 * unconditionally without branching on the bridge kind.
 */

import { dispatchComposerInsertText } from '@quanta/ui';

export interface DragDropHandle {
  readonly dispose: () => void;
}

type UnlistenFn = () => void;

/** The subset of the Tauri drag-drop event payload we consume. */
interface DragDropEventPayload {
  readonly type: 'enter' | 'over' | 'drop' | 'leave';
  readonly paths?: readonly string[];
}

interface DragDropEvent {
  readonly payload: DragDropEventPayload;
}

/**
 * Install the drag-drop → composer wiring. Returns a handle whose `dispose`
 * unlistens from the underlying Tauri subscription. Idempotent across hot
 * reload: the caller is responsible for disposing the prior handle first.
 */
export async function installDragDropBridge(): Promise<DragDropHandle> {
  const noop: DragDropHandle = { dispose: () => {} };
  try {
    // Lazy import so the whole module tree-shakes out under the mock bridge
    // build (Vite keeps it when the Tauri runtime is present at import time).
    const mod = await import('@tauri-apps/api/webviewWindow');
    const window = mod.getCurrentWebviewWindow();
    const unlisten: UnlistenFn = await window.onDragDropEvent((event: DragDropEvent) => {
      const payload = event.payload;
      if (payload.type !== 'drop') return;
      const paths = payload.paths ?? [];
      if (paths.length === 0) return;
      // Single dispatch per drop so the composer coalesces into one state
      // update. We rely on the bus's `quote: true` + `applyInsert` joining
      // logic to separate individual paths with a space.
      for (const p of paths) {
        dispatchComposerInsertText(p, { mode: 'append', quote: true });
      }
    });
    return { dispose: unlisten };
  } catch {
    // Either the Tauri webview API is unavailable (non-Tauri host) or the
    // window has gone away. Nothing to do — callers install unconditionally.
    return noop;
  }
}

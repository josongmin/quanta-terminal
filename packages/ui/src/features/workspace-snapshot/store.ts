/**
 * Workspace-snapshot store — holds the live list of snapshots in memory and
 * owns the wiring to the IDB adapter + the auto-capture lifecycle hooks.
 *
 * Responsibilities
 * ----------------
 * - keep a local mirror of `snapshots` and the `autoRestore` setting;
 * - write-through to the adapter whenever the list changes;
 * - capture on `visibilitychange → hidden` and `beforeunload` (auto slot);
 * - surface `hydrate()` (load on boot) and `autoRestoreIfPresent()` (re-open
 *   the auto capture if the flag is on and one exists).
 *
 * The store deliberately holds only plain-data snapshots. The heavy lifting
 * (tearing down live sessions, respawning from metadata) lives in
 * `serialize.ts` and is invoked from the palette commands / boot hook.
 */

import { create } from 'zustand';
import { createLogger } from '../../shared/lib/logger.js';
import {
  AUTO_SNAPSHOT_ID,
  AUTO_SNAPSHOT_NAME,
  isAutoSnapshot,
  type WorkspaceSnapshot,
} from './model.js';
import {
  createIdbSnapshotAdapter,
  type SnapshotAdapter,
} from './adapter.js';
import {
  captureSnapshot,
  restoreSnapshot,
  type RestoreSnapshotDeps,
} from './serialize.js';

const log = createLogger('workspace-snapshot');

/** localStorage key that persists the autoRestore flag. Kept separate from
 *  IDB because it's a tiny boolean that must be available synchronously on
 *  boot — IDB open is async. */
export const AUTO_RESTORE_STORAGE_KEY = 'quanta:workspace-snapshot:auto-restore';

export interface WorkspaceSnapshotState {
  readonly snapshots: readonly WorkspaceSnapshot[];
  /** When true, boot re-opens the auto snapshot (if one exists). */
  readonly autoRestore: boolean;
  /** True once `hydrate()` has finished reading the adapter on boot. */
  readonly hydrated: boolean;
}

export interface WorkspaceSnapshotActions {
  /** Append or replace a snapshot (match by id). Persists via adapter. */
  saveSnapshot(snap: WorkspaceSnapshot): Promise<void>;
  deleteSnapshot(id: string): Promise<void>;
  /** Toggle / set auto-restore. Persists to localStorage. */
  setAutoRestore(enabled: boolean): void;
  /** Hydrate from the adapter. Safe to call multiple times — subsequent
   *  calls overwrite the in-memory list with what's on disk. */
  hydrate(): Promise<void>;
  /** Test helper — wipe everything in memory (does NOT touch the adapter). */
  reset(): void;
}

function readAutoRestoreFromStorage(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    const raw = localStorage.getItem(AUTO_RESTORE_STORAGE_KEY);
    if (raw === null) return true; // default on
    return raw === 'true';
  } catch {
    return true;
  }
}

function writeAutoRestoreToStorage(value: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(AUTO_RESTORE_STORAGE_KEY, String(value));
  } catch {
    // private-mode safari / quota exceeded — best-effort.
  }
}

/** Ambient adapter — created lazily on first store access so tests can install
 *  a mock via `setSnapshotAdapter` before the module is used. */
let adapter: SnapshotAdapter | null = null;

export function setSnapshotAdapter(next: SnapshotAdapter | null): void {
  adapter = next;
}

function getAdapter(): SnapshotAdapter {
  if (!adapter) adapter = createIdbSnapshotAdapter();
  return adapter;
}

export const useWorkspaceSnapshotStore = create<
  WorkspaceSnapshotState & WorkspaceSnapshotActions
>((set) => ({
  snapshots: [],
  autoRestore: readAutoRestoreFromStorage(),
  hydrated: false,

  async saveSnapshot(snap) {
    // Update in-memory state synchronously FIRST — it is authoritative.
    set((prev) => {
      // Replace-by-id so the auto-slot overwrites in place.
      const without = prev.snapshots.filter((s) => s.id !== snap.id);
      return { ...prev, snapshots: [...without, snap] };
    });
    // Then persist async (best-effort; do not roll back on failure).
    try {
      await getAdapter().save(snap);
    } catch (err) {
      log.warn('saveSnapshot: adapter.save rejected', { id: snap.id, err });
    }
  },

  async deleteSnapshot(id) {
    try {
      await getAdapter().deleteOne(id);
    } catch (err) {
      log.warn('deleteSnapshot: adapter.deleteOne rejected', { id, err });
    }
    set((prev) => ({
      ...prev,
      snapshots: prev.snapshots.filter((s) => s.id !== id),
    }));
  },

  setAutoRestore(enabled) {
    writeAutoRestoreToStorage(enabled);
    set((prev) => (prev.autoRestore === enabled ? prev : { ...prev, autoRestore: enabled }));
  },

  async hydrate() {
    try {
      const rows = await getAdapter().loadAll();
      const sorted = [...rows].sort((a, b) => a.createdAt - b.createdAt);
      set((prev) => ({ ...prev, snapshots: sorted, hydrated: true }));
    } catch (err) {
      log.warn('hydrate: adapter.loadAll rejected', { err });
      set((prev) => ({ ...prev, hydrated: true }));
    }
  },

  reset() {
    set({ snapshots: [], autoRestore: readAutoRestoreFromStorage(), hydrated: false });
  },
}));

// ----------------------------------------------------------------------------
// High-level helpers used by commands + boot wiring.
// ----------------------------------------------------------------------------

/**
 * Named-snapshot save: validates the name, builds the snapshot via
 * `captureSnapshot`, and pushes it through the store. Rejects when the name
 * collides with the reserved auto-slot name.
 */
export async function saveNamedSnapshot(name: string): Promise<WorkspaceSnapshot> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new Error('saveNamedSnapshot: name must not be empty');
  }
  if (trimmed === AUTO_SNAPSHOT_NAME) {
    throw new Error(
      `saveNamedSnapshot: "${AUTO_SNAPSHOT_NAME}" is reserved for automatic captures`,
    );
  }
  const snap = captureSnapshot({ name: trimmed });
  await useWorkspaceSnapshotStore.getState().saveSnapshot(snap);
  return snap;
}

/**
 * Capture the current workspace into the reserved auto-slot, overwriting any
 * previous auto capture. Called from the visibilitychange / beforeunload
 * hooks — see `bindAutoCapture`.
 */
export async function saveAutoSnapshot(): Promise<WorkspaceSnapshot> {
  const snap = captureSnapshot({ name: AUTO_SNAPSHOT_NAME, id: AUTO_SNAPSHOT_ID });
  await useWorkspaceSnapshotStore.getState().saveSnapshot(snap);
  return snap;
}

/**
 * Look up the auto snapshot (if any) and restore it. Returns `false` when
 * nothing was restored (no snapshot, or autoRestore is off).
 */
export async function autoRestoreIfPresent(
  deps: RestoreSnapshotDeps = {},
): Promise<boolean> {
  const state = useWorkspaceSnapshotStore.getState();
  if (!state.autoRestore) return false;
  const auto = state.snapshots.find((s) => s.id === AUTO_SNAPSHOT_ID);
  if (!auto) return false;
  await restoreSnapshot({ ...deps, snapshot: auto });
  return true;
}

/**
 * Install auto-capture hooks on `document.visibilitychange` and
 * `window.beforeunload`. Returns an uninstall fn for tests / HMR.
 */
export interface AutoCaptureBinding {
  readonly uninstall: () => void;
}

export function bindAutoCapture(): AutoCaptureBinding {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { uninstall: () => {} };
  }
  const onVis = (): void => {
    if (document.visibilityState === 'hidden') {
      // Intentionally fire-and-forget; the page may be gone before the
      // promise resolves. The IDB put is queued inside the browser's tx
      // machinery so it survives the tab going to the background.
      void saveAutoSnapshot().catch((err) => {
        log.warn('auto-capture: save failed', { err });
      });
    }
  };
  const onUnload = (): void => {
    void saveAutoSnapshot().catch(() => {
      // nothing we can do at unload — the tab is going away.
    });
  };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('beforeunload', onUnload);
  return {
    uninstall: () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('beforeunload', onUnload);
    },
  };
}

/** Filter the snapshot list into (auto, named) pairs for the settings UI. */
export function splitSnapshots(
  snapshots: readonly WorkspaceSnapshot[],
): { readonly auto: WorkspaceSnapshot | null; readonly named: readonly WorkspaceSnapshot[] } {
  let auto: WorkspaceSnapshot | null = null;
  const named: WorkspaceSnapshot[] = [];
  for (const s of snapshots) {
    if (isAutoSnapshot(s)) {
      auto = s;
    } else {
      named.push(s);
    }
  }
  // Newest-first for the named list — users expect the most recent save at
  // the top of the picker.
  named.sort((a, b) => b.createdAt - a.createdAt);
  return { auto, named };
}

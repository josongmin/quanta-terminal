/**
 * Keybinding override store — zustand layer that sits on top of the built-in
 * `KEYBINDING_REGISTRY` and lets the user customize individual shortcuts.
 *
 * Design:
 *   - The store persists ONLY the diff from defaults (`{ [id]: shortcut }`),
 *     so a future registry change (new action, renamed default) does not
 *     stomp user preferences silently — the user sees the new default unless
 *     they explicitly rebind.
 *   - `resolveShortcut(id)` is the single read path: override if present,
 *     else the definition's default, else `null` when the id is unknown.
 *   - `setOverride` / `clearOverride` / `reset` mutate the map and persist.
 *     All writes go through `writeStored` which swallows quota errors
 *     (matches the pattern in sibling settings stores).
 *
 * Why keep this separate from `shared/lib/keymap.ts`: that module is the
 * event listener plumbing and is deliberately stateless. User customization
 * is a feature concern — it owns persistence, i18n, and the settings UI.
 */

import { create } from 'zustand';

import { findKeybinding, KEYBINDING_REGISTRY } from './registry.js';

export const KEYBINDINGS_STORAGE_KEY = 'quanta:keybindings';

export type KeybindingOverrides = Readonly<Record<string, string>>;

export interface KeybindingsStore {
  /** Override map. Keys are definition ids; values are shortcut specs. */
  readonly overrides: KeybindingOverrides;
  readonly setOverride: (id: string, shortcut: string) => void;
  readonly clearOverride: (id: string) => void;
  /** Wipe every override — restores pristine defaults. */
  readonly reset: () => void;
  /**
   * Resolve the effective shortcut for a given id. Override wins over the
   * definition's default. Returns `null` for unknown ids so callers can
   * fail closed.
   */
  readonly resolveShortcut: (id: string) => string | null;
}

/**
 * Pure resolution helper — exported so the keymap subscriber and tests can
 * resolve without subscribing to the store directly. A subscriber that wants
 * to react to changes should use `useKeybindingsStore(s => s.resolveShortcut(id))`
 * which re-renders when the override map updates.
 */
export function resolveShortcut(
  id: string,
  overrides: KeybindingOverrides,
): string | null {
  const override = overrides[id];
  if (typeof override === 'string' && override.length > 0) return override;
  const def = findKeybinding(id);
  return def ? def.defaultShortcut : null;
}

function readStoredOverrides(
  getItem?: (key: string) => string | null,
): KeybindingOverrides {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return {};
  let raw: string | null;
  try {
    raw = get(KEYBINDINGS_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeStored(next: KeybindingOverrides): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEYBINDINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage full / private mode — swallow; an ephemeral override is still
    // useful for the current session.
  }
}

/**
 * Sync keybinding overrides from localStorage changes in other tabs.
 * The `storage` event only fires in tabs that did NOT make the write, so
 * there is no risk of a feedback loop where a tab re-processes its own write.
 * We parse `e.newValue` directly rather than re-reading localStorage so that
 * the update is based on the value that was written in the other tab.
 */
function subscribeKeybindingsCrossTabSync(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key !== KEYBINDINGS_STORAGE_KEY) return;
    const fresh = readStoredOverrides((key) => (key === KEYBINDINGS_STORAGE_KEY ? e.newValue : null));
    useKeybindingsStore.setState({ overrides: fresh });
  });
}

// Register the cross-tab sync listener once at module initialisation time,
// matching the pattern used by sibling settings stores in this codebase.
subscribeKeybindingsCrossTabSync();

export const useKeybindingsStore = create<KeybindingsStore>((set, get) => {
  const initial = readStoredOverrides();
  return {
    overrides: initial,
    setOverride: (id, shortcut) => {
      if (!findKeybinding(id)) return; // unknown id: ignore
      if (shortcut.length === 0) return;
      const prev = get().overrides;
      if (prev[id] === shortcut) return;
      const next: KeybindingOverrides = { ...prev, [id]: shortcut };
      writeStored(next);
      set({ overrides: next });
    },
    clearOverride: (id) => {
      const prev = get().overrides;
      if (!(id in prev)) return;
      const next: Record<string, string> = { ...prev };
      delete next[id];
      writeStored(next);
      set({ overrides: next });
    },
    reset: () => {
      if (Object.keys(get().overrides).length === 0) return;
      writeStored({});
      set({ overrides: {} });
    },
    resolveShortcut: (id) => resolveShortcut(id, get().overrides),
  };
});

/** Test-only: wipe the in-memory store. Also clears localStorage. */
export function __resetKeybindingsForTests(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(KEYBINDINGS_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  useKeybindingsStore.setState({ overrides: {} });
}

/** Convenience — snapshot of every action's effective shortcut. */
export function getEffectiveShortcuts(
  overrides: KeybindingOverrides = useKeybindingsStore.getState().overrides,
): ReadonlyArray<{ id: string; shortcut: string }> {
  return KEYBINDING_REGISTRY.map((def) => ({
    id: def.id,
    shortcut: overrides[def.id] ?? def.defaultShortcut,
  }));
}

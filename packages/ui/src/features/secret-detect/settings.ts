/**
 * Secret-redaction settings + per-block reveal state.
 *
 * Two concerns, one module (both are small and both are owned by the
 * secret-detect feature):
 *
 * 1. `useSecretRedactSettings` — persistent user preference for "redact
 *    secrets in output". Defaults to ON; persisted to localStorage so the
 *    setting survives reloads. Consumed by the settings panel and the
 *    BlockBody renderer.
 *
 * 2. `useSecretRevealStore` — ephemeral "show secrets for THIS block"
 *    toggles. Per-block opt-in means a user who clicks "Show secrets" on
 *    one card does NOT accidentally un-mask every other card in the list.
 *    Not persisted — a fresh session starts fully redacted.
 */

import { create } from 'zustand';

/* -------------------- persistent redact-in-output setting ------------------- */

export const SECRET_REDACT_STORAGE_KEY = 'quanta:secret-redact';

export interface SecretRedactSettings {
  /** Master switch. When `false`, no redaction happens regardless of per-block reveal state. */
  readonly enabled: boolean;
}

export interface SecretRedactStore extends SecretRedactSettings {
  readonly setEnabled: (next: boolean) => void;
}

/**
 * Read the stored redact setting from localStorage. Returns the default
 * (enabled=true) when storage is unavailable or the stored value is
 * corrupt. Exposed for tests so they can assert persistence across reloads.
 */
export function readStoredRedactSettings(
  getItem?: (key: string) => string | null,
): SecretRedactSettings {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return { enabled: true };
  let raw: string | null;
  try {
    raw = get(SECRET_REDACT_STORAGE_KEY);
  } catch {
    return { enabled: true };
  }
  if (raw === null) return { enabled: true };
  try {
    const parsed = JSON.parse(raw) as Partial<SecretRedactSettings>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : true,
    };
  } catch {
    return { enabled: true };
  }
}

function writeStoredRedact(next: SecretRedactSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SECRET_REDACT_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-mode Safari / storage full: swallow.
  }
}

export const useSecretRedactSettings = create<SecretRedactStore>((set, get) => {
  const initial = readStoredRedactSettings();
  return {
    ...initial,
    setEnabled: (next) => {
      if (get().enabled === next) return;
      writeStoredRedact({ enabled: next });
      set({ enabled: next });
    },
  };
});

/* ------------------------ per-block reveal state ---------------------------- */

export interface SecretRevealState {
  /** Set of block ids whose output should render unredacted. */
  readonly revealed: ReadonlySet<string>;
}

export interface SecretRevealStore extends SecretRevealState {
  readonly toggle: (blockId: string) => void;
  readonly reveal: (blockId: string) => void;
  readonly hide: (blockId: string) => void;
  /** Clear every reveal — useful on session clear / logout. */
  readonly clear: () => void;
}

export const useSecretRevealStore = create<SecretRevealStore>((set, get) => ({
  revealed: new Set<string>(),
  toggle: (blockId) => {
    const cur = get().revealed;
    const next = new Set(cur);
    if (next.has(blockId)) {
      next.delete(blockId);
    } else {
      next.add(blockId);
    }
    set({ revealed: next });
  },
  reveal: (blockId) => {
    const cur = get().revealed;
    if (cur.has(blockId)) return;
    const next = new Set(cur);
    next.add(blockId);
    set({ revealed: next });
  },
  hide: (blockId) => {
    const cur = get().revealed;
    if (!cur.has(blockId)) return;
    const next = new Set(cur);
    next.delete(blockId);
    set({ revealed: next });
  },
  clear: () => {
    if (get().revealed.size === 0) return;
    set({ revealed: new Set() });
  },
}));

/** Convenience hook — returns whether this block is currently revealed. */
export function useBlockRevealed(blockId: string): boolean {
  return useSecretRevealStore((s) => s.revealed.has(blockId));
}

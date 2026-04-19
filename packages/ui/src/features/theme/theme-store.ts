/**
 * Theme store — three values: 'light' | 'dark' | 'system'.
 *
 * The user's choice is persisted in localStorage under a well-known key so a
 * reload immediately applies the last-selected theme without a flash of the
 * default. When the user picks 'system', the provider reads
 * `prefers-color-scheme` at render time; when the user picks an explicit
 * value, system changes are ignored.
 *
 * Why Zustand (and not Context): the theme value is read from widgets far
 * away from the provider (settings panel, toolbars); Zustand's selector
 * subscriptions avoid unnecessary re-renders while still offering stable
 * action identities.
 */

import { create } from 'zustand';

export type ThemePreference = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'quanta:theme';
const VALID: readonly ThemePreference[] = ['light', 'dark', 'system'];

export interface ThemeStore {
  readonly theme: ThemePreference;
  readonly setTheme: (next: ThemePreference) => void;
  /** Test-only reset — re-reads storage, used by Vitest between tests. */
  readonly _rehydrate: () => void;
}

/** Pure helper exported for tests. */
export function readStoredTheme(
  getItem?: (key: string) => string | null,
): ThemePreference {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return 'system';
  let raw: string | null;
  try {
    raw = get(STORAGE_KEY);
  } catch {
    return 'system';
  }
  if (raw === null) return 'system';
  return (VALID as readonly string[]).includes(raw) ? (raw as ThemePreference) : 'system';
}

function writeStoredTheme(next: ThemePreference): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private-mode Safari throws on writes; swallow so the store still
    // reflects the intent for this session.
  }
}

export const useThemeStore = create<ThemeStore>((set) => ({
  theme: readStoredTheme(),
  setTheme: (next) => {
    if (!VALID.includes(next)) return;
    writeStoredTheme(next);
    set({ theme: next });
  },
  _rehydrate: () => {
    set({ theme: readStoredTheme() });
  },
}));

/** Module-level helpers so non-React callers (tests, debug scripts) don't
 *  have to subscribe. */
export function getTheme(): ThemePreference {
  return useThemeStore.getState().theme;
}

export function setTheme(next: ThemePreference): void {
  useThemeStore.getState().setTheme(next);
}

export const THEME_STORAGE_KEY = STORAGE_KEY;

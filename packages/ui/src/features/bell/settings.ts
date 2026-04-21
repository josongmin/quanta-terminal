/**
 * Bell preference store.
 *
 * Two toggles, both persisted to localStorage so the user's choice survives
 * a reload:
 *   - `visualBell` — default ON. Flashes the terminal area briefly on BEL.
 *   - `audibleBell` — default OFF. Plays a short WebAudio beep on BEL.
 *
 * Mirrors the pattern in `features/secret-detect/settings.ts` — same storage
 * shape, same tolerate-missing-keys behaviour. No audio file is ever loaded;
 * the beep is synthesised in `beep.ts` with a WebAudio oscillator.
 */

import { create } from 'zustand';

export const BELL_SETTINGS_STORAGE_KEY = 'quanta:bell-settings';

export interface BellSettings {
  readonly visualBell: boolean;
  readonly audibleBell: boolean;
}

export interface BellSettingsStore extends BellSettings {
  readonly setVisualBell: (next: boolean) => void;
  readonly setAudibleBell: (next: boolean) => void;
}

/**
 * Read bell preferences from localStorage. Returns the defaults (visual ON,
 * audible OFF) when storage is unavailable or the payload is corrupt.
 */
export function readStoredBellSettings(
  getItem?: (key: string) => string | null,
): BellSettings {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  const defaults: BellSettings = { visualBell: true, audibleBell: false };
  if (!get) return defaults;
  let raw: string | null;
  try {
    raw = get(BELL_SETTINGS_STORAGE_KEY);
  } catch {
    return defaults;
  }
  if (raw === null) return defaults;
  try {
    const parsed = JSON.parse(raw) as Partial<BellSettings>;
    return {
      visualBell:
        typeof parsed.visualBell === 'boolean' ? parsed.visualBell : defaults.visualBell,
      audibleBell:
        typeof parsed.audibleBell === 'boolean'
          ? parsed.audibleBell
          : defaults.audibleBell,
    };
  } catch {
    return defaults;
  }
}

function writeStored(next: BellSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(BELL_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage full / private mode: swallow — a runtime-only preference is
    // better than throwing up the UI.
  }
}

export const useBellSettings = create<BellSettingsStore>((set, get) => {
  const initial = readStoredBellSettings();
  return {
    ...initial,
    setVisualBell: (next) => {
      if (get().visualBell === next) return;
      const merged: BellSettings = { ...get(), visualBell: next };
      writeStored(merged);
      set({ visualBell: next });
    },
    setAudibleBell: (next) => {
      if (get().audibleBell === next) return;
      const merged: BellSettings = { ...get(), audibleBell: next };
      writeStored(merged);
      set({ audibleBell: next });
    },
  };
});

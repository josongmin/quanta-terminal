/**
 * Font settings store — user-controlled monospace font family, pixel size, and
 * programming-ligature toggle.
 *
 * Three values persist to localStorage under `quanta.font-settings`:
 *   - `family`   — one of `FONT_FAMILY_OPTIONS[].id`. Defaults to `'system'`
 *                  which falls through to `ui-monospace, monospace` so the
 *                  OS-native mono is used when the user hasn't expressed a
 *                  preference. `'firacode'` etc. fall back to the same system
 *                  stack if the named face isn't installed — we don't fetch
 *                  remote fonts.
 *   - `size`     — integer pixels in [10, 24]. Clamped in `setSize` so keymap
 *                  callers (zoom-bind siblings) can't push outside the slider
 *                  range.
 *   - `ligatures`— when `true`, applies `'calt' on, 'liga' on` via the
 *                  `--q-font-features` CSS variable (plumbed into composer,
 *                  block output, TUI surface, and the canvas via a
 *                  font-feature-settings declaration). `false` explicitly
 *                  disables both (default-off fonts won't leak through).
 *
 * Application strategy — write three CSS custom properties on the document
 * root:
 *   --quanta-font-family    (also mirrored to --q-font-mono so the 50+
 *                            existing `var(--q-font-mono)` callsites pick up
 *                            the change with zero extra wiring)
 *   --quanta-font-size      (mirrored to --q-font-size-term)
 *   --quanta-font-features  (new — consumed by terminal canvas / composer /
 *                            ansi-output modules)
 *
 * Canvas2D path: the 2D context cannot read CSS variables, so the backend
 * exposes `_setFontOverride` / `_getFontOverride`; we push the family + size
 * + feature string directly via `notifyCanvasBackendsOfFontChange()` after
 * every store update. The backend invalidates its glyph atlas and fires the
 * upstream invalidation hook so the next rAF repaints with the new font.
 */

import { create } from 'zustand';

export const FONT_SETTINGS_STORAGE_KEY = 'quanta.font-settings';

export const FONT_SIZE_MIN = 10;
export const FONT_SIZE_MAX = 24;
export const FONT_SIZE_DEFAULT = 14;

/** Curated family list. `fallback` is the CSS `font-family` string written
 *  to `--quanta-font-family` when this id is active. `system` is the
 *  bare system-monospace stack; everything else names a specific face
 *  followed by the same system fallback, so an uninstalled face degrades
 *  gracefully without a remote fetch. */
export interface FontFamilyOption {
  readonly id: string;
  readonly label: string;
  readonly fallback: string;
}

export const FONT_FAMILY_OPTIONS: ReadonlyArray<FontFamilyOption> = [
  {
    id: 'system',
    label: 'System Monospace',
    fallback: 'ui-monospace, monospace',
  },
  {
    // JetBrains Mono is the font currently bundled in fonts.css — it's the
    // only face we can guarantee will render without the user installing
    // anything. Listed first among named faces so the default UX with a
    // reasonable ligature-capable font is one click away.
    id: 'jetbrains',
    label: 'JetBrains Mono',
    fallback: "'JetBrains Mono', ui-monospace, monospace",
  },
  {
    id: 'firacode',
    label: 'Fira Code',
    fallback: "'Fira Code', ui-monospace, monospace",
  },
  {
    id: 'cascadia',
    label: 'Cascadia Code',
    fallback: "'Cascadia Code', ui-monospace, monospace",
  },
] as const;

export const DEFAULT_FONT_FAMILY_ID = 'system';
export const DEFAULT_LIGATURES = true;

export interface FontSettings {
  readonly family: string;
  readonly size: number;
  readonly ligatures: boolean;
}

export interface FontSettingsStore extends FontSettings {
  readonly setFamily: (family: string) => void;
  readonly setSize: (px: number) => void;
  readonly toggleLigatures: () => void;
  /** Test-only: reset to defaults + rehydrate from localStorage. */
  readonly _rehydrate: () => void;
}

/** Clamp + round to integer px. `Number.isFinite` rejects NaN/Infinity so a
 *  malformed storage entry or a runaway slider input can't crash the render. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return FONT_SIZE_DEFAULT;
  const n = Math.round(px);
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, n));
}

function isKnownFamily(id: string): boolean {
  for (const opt of FONT_FAMILY_OPTIONS) {
    if (opt.id === id) return true;
  }
  return false;
}

export function resolveFamilyCss(familyId: string): string {
  for (const opt of FONT_FAMILY_OPTIONS) {
    if (opt.id === familyId) return opt.fallback;
  }
  return FONT_FAMILY_OPTIONS[0]!.fallback;
}

/** Build the `font-feature-settings` shorthand for the ligature toggle.
 *  Explicitly turning OFF both `calt` and `liga` matters: several
 *  ligature-capable fonts enable them by default, so `'calt' off, 'liga' off`
 *  is required to kill ligatures at the CSS level. */
export function resolveFeatureSettings(ligatures: boolean): string {
  return ligatures ? `'calt' on, 'liga' on` : `'calt' off, 'liga' off`;
}

export function readStoredFontSettings(
  getItem?: (key: string) => string | null,
): FontSettings {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  const fallback: FontSettings = {
    family: DEFAULT_FONT_FAMILY_ID,
    size: FONT_SIZE_DEFAULT,
    ligatures: DEFAULT_LIGATURES,
  };
  if (!get) return fallback;
  let raw: string | null;
  try {
    raw = get(FONT_SETTINGS_STORAGE_KEY);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<FontSettings>;
    const family =
      typeof parsed.family === 'string' && isKnownFamily(parsed.family)
        ? parsed.family
        : DEFAULT_FONT_FAMILY_ID;
    const size =
      typeof parsed.size === 'number' ? clampFontSize(parsed.size) : FONT_SIZE_DEFAULT;
    const ligatures =
      typeof parsed.ligatures === 'boolean' ? parsed.ligatures : DEFAULT_LIGATURES;
    return { family, size, ligatures };
  } catch {
    return fallback;
  }
}

function writeStoredFontSettings(next: FontSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(FONT_SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-mode Safari / storage full — ignore. The session-local state
    // still reflects the user's intent until reload.
  }
}

/**
 * Apply the resolved font settings to `document.documentElement` as CSS
 * custom properties. We also mirror to `--q-font-mono` / `--q-font-size-term`
 * so the existing ~50 stylesheets that reference those tokens pick up the
 * change with no CSS-side edits. SSR-safe — no-op when `document` is absent.
 */
export function applyFontSettingsToDocument(settings: FontSettings): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!root) return;
  const familyCss = resolveFamilyCss(settings.family);
  const featureCss = resolveFeatureSettings(settings.ligatures);
  // New public vars.
  root.style.setProperty('--quanta-font-family', familyCss);
  root.style.setProperty('--quanta-font-size', `${settings.size}px`);
  root.style.setProperty('--quanta-font-features', featureCss);
  // Mirrors — the existing token names drive the bulk of the app so
  // overriding them at :root scope repaints every referenced element.
  root.style.setProperty('--q-font-mono', familyCss);
  root.style.setProperty('--q-font-size-term', `${settings.size}px`);
  root.style.setProperty('--q-font-features', featureCss);
}

/**
 * Listener registry for backends / Canvas2DBackend instances that need to
 * be told about font changes out-of-band of CSS (the 2D context cannot read
 * CSS variables). The terminal-canvas widget subscribes on mount; the
 * subscription fires every time any `set*` action runs.
 */
type FontChangeListener = (settings: FontSettings) => void;
const fontChangeListeners = new Set<FontChangeListener>();

export function subscribeFontChange(listener: FontChangeListener): () => void {
  fontChangeListeners.add(listener);
  return () => {
    fontChangeListeners.delete(listener);
  };
}

function notifyListeners(settings: FontSettings): void {
  for (const l of fontChangeListeners) {
    try {
      l(settings);
    } catch {
      // Never let one misbehaving listener kill the others.
    }
  }
}

export const useFontSettings = create<FontSettingsStore>((set, get) => {
  const initial = readStoredFontSettings();
  // Apply on boot so a fresh mount reflects persisted preferences before the
  // first paint.
  applyFontSettingsToDocument(initial);
  return {
    ...initial,
    setFamily: (family) => {
      const next = isKnownFamily(family) ? family : DEFAULT_FONT_FAMILY_ID;
      if (next === get().family) return;
      const settings: FontSettings = {
        family: next,
        size: get().size,
        ligatures: get().ligatures,
      };
      writeStoredFontSettings(settings);
      applyFontSettingsToDocument(settings);
      set({ family: next });
      notifyListeners(settings);
    },
    setSize: (px) => {
      const next = clampFontSize(px);
      if (next === get().size) return;
      const settings: FontSettings = {
        family: get().family,
        size: next,
        ligatures: get().ligatures,
      };
      writeStoredFontSettings(settings);
      applyFontSettingsToDocument(settings);
      set({ size: next });
      notifyListeners(settings);
    },
    toggleLigatures: () => {
      const next = !get().ligatures;
      const settings: FontSettings = {
        family: get().family,
        size: get().size,
        ligatures: next,
      };
      writeStoredFontSettings(settings);
      applyFontSettingsToDocument(settings);
      set({ ligatures: next });
      notifyListeners(settings);
    },
    _rehydrate: () => {
      const fresh = readStoredFontSettings();
      applyFontSettingsToDocument(fresh);
      set(fresh);
      notifyListeners(fresh);
    },
  };
});

export function getFontSettings(): FontSettings {
  const s = useFontSettings.getState();
  return { family: s.family, size: s.size, ligatures: s.ligatures };
}

/**
 * a11y-announce settings — the user's preference for whether newly-arrived
 * terminal output should be piped to an `aria-live` region for screen-reader
 * consumption, plus the politeness level of that region.
 *
 * Why mode+enabled are separate fields
 * ------------------------------------
 * Blind / low-vision users tune the "polite vs assertive" choice once and
 * then flip the feature on/off situationally (e.g. off during noisy
 * `npm install`, on during `git log` review). Keeping the mode around while
 * disabled means they don't have to re-pick it every time.
 *
 * Defaults: `{ mode: 'polite', enabled: false }`. Opt-in, because sighted
 * users would otherwise hear their terminal narrated on every launch.
 * Persisted to localStorage — mirrors the pattern in
 * `features/notifications/settings.ts` / `features/bell/settings.ts`.
 */

import { create } from 'zustand';

export const A11Y_ANNOUNCE_STORAGE_KEY = 'quanta:a11y-announce';

/**
 * Politeness of the live region.
 *
 *   - `off`        — the live region does not announce at all. Still rendered
 *                    in the DOM (empty) so mounting/unmounting does not cause
 *                    AT focus churn.
 *   - `polite`     — screen reader waits for a pause before speaking the
 *                    update. Best for streaming output where you don't want
 *                    to interrupt the user.
 *   - `assertive`  — speak over whatever the AT is currently reading.
 *                    Appropriate for short bursts (errors, prompts), rarely
 *                    for long running output.
 *
 * We keep the `off` mode distinct from the `enabled` flag: the flag is the
 * master on/off toggle and `mode` is the preferred politeness to restore
 * when the user re-enables. The keyboard shortcut cycles off → polite →
 * assertive → off by toggling BOTH fields so a single keybind is enough.
 */
export type A11yAnnounceMode = 'off' | 'polite' | 'assertive';

export interface A11yAnnounceSettings {
  readonly enabled: boolean;
  /**
   * Preferred politeness. When `enabled=false`, this is the mode that will
   * be restored when the user flips the toggle back on (so their choice is
   * not forgotten during a temporary mute).
   */
  readonly mode: A11yAnnounceMode;
}

export interface A11yAnnounceSettingsStore extends A11yAnnounceSettings {
  readonly setEnabled: (next: boolean) => void;
  readonly setMode: (next: A11yAnnounceMode) => void;
  /**
   * Keyboard shortcut action: cycle through the three states in order
   *
   *     off → polite → assertive → off
   *
   * The cycle affects BOTH `enabled` and `mode` so a single keybind is a
   * complete control:
   *   - `off` lands on `{enabled:false, mode:<preserved>}` (mode preserved
   *     so the NEXT enable restores the user's last-chosen politeness).
   *     Actually, for cycle semantics we store `mode=off` and flip enabled
   *     together — see implementation. The off branch writes `mode:'off'`
   *     intentionally so the live region's aria-live attribute is also
   *     'off' (screen readers treat `aria-live="off"` as "don't announce").
   */
  readonly cycleMode: () => void;
}

function isMode(v: unknown): v is A11yAnnounceMode {
  return v === 'off' || v === 'polite' || v === 'assertive';
}

export const DEFAULT_A11Y_ANNOUNCE_SETTINGS: A11yAnnounceSettings = {
  enabled: false,
  mode: 'polite',
};

/**
 * Read a11y-announce preferences from localStorage. Returns defaults on
 * absent/corrupt payload. Partial payloads (missing a field) fall back
 * field-by-field so an older stored shape still loads cleanly.
 */
export function readStoredA11ySettings(
  getItem?: (key: string) => string | null,
): A11yAnnounceSettings {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return DEFAULT_A11Y_ANNOUNCE_SETTINGS;
  let raw: string | null;
  try {
    raw = get(A11Y_ANNOUNCE_STORAGE_KEY);
  } catch {
    return DEFAULT_A11Y_ANNOUNCE_SETTINGS;
  }
  if (raw === null) return DEFAULT_A11Y_ANNOUNCE_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<A11yAnnounceSettings>;
    return {
      enabled:
        typeof parsed.enabled === 'boolean'
          ? parsed.enabled
          : DEFAULT_A11Y_ANNOUNCE_SETTINGS.enabled,
      mode: isMode(parsed.mode) ? parsed.mode : DEFAULT_A11Y_ANNOUNCE_SETTINGS.mode,
    };
  } catch {
    return DEFAULT_A11Y_ANNOUNCE_SETTINGS;
  }
}

function writeStored(next: A11yAnnounceSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(A11Y_ANNOUNCE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // storage full / private mode: swallow — a runtime-only preference
    // beats crashing the UI.
  }
}

export const useA11yAnnounceSettings = create<A11yAnnounceSettingsStore>((set, get) => {
  const initial = readStoredA11ySettings();
  return {
    ...initial,
    setEnabled: (next) => {
      if (get().enabled === next) return;
      const merged: A11yAnnounceSettings = { ...get(), enabled: next };
      writeStored(merged);
      set({ enabled: next });
    },
    setMode: (next) => {
      // Track `enabled` alongside so `mode='off'` implies `enabled=false`
      // and any named politeness implies enabled (the user explicitly
      // picked a speaking mode). Callers that want to decouple use
      // setEnabled + setMode separately.
      const enabled = next !== 'off';
      const cur = get();
      if (cur.mode === next && cur.enabled === enabled) return;
      const merged: A11yAnnounceSettings = { mode: next, enabled };
      writeStored(merged);
      set(merged);
    },
    cycleMode: () => {
      const cur = get();
      // Effective current mode: if disabled, treat as 'off' regardless of
      // the preserved `mode` so the cycle's first step from disabled lands
      // at 'polite' (intuitive).
      const effective: A11yAnnounceMode = cur.enabled ? cur.mode : 'off';
      const nextMode: A11yAnnounceMode =
        effective === 'off' ? 'polite' : effective === 'polite' ? 'assertive' : 'off';
      const nextEnabled = nextMode !== 'off';
      const merged: A11yAnnounceSettings = { mode: nextMode, enabled: nextEnabled };
      if (cur.mode === merged.mode && cur.enabled === merged.enabled) return;
      writeStored(merged);
      set(merged);
    },
  };
});

/**
 * Resolve the effective politeness that the LiveRegion should project onto
 * its `aria-live` attribute. When the feature is disabled we surface `off`
 * so the region is inert; when enabled we pass through the user's `mode`
 * (which is guaranteed to be non-off under the cycle invariant, but we
 * still coalesce defensively).
 */
export function resolveEffectiveAnnounceMode(
  settings: A11yAnnounceSettings,
): A11yAnnounceMode {
  if (!settings.enabled) return 'off';
  return settings.mode === 'off' ? 'polite' : settings.mode;
}

/**
 * AI explain-error settings — persisted user preferences for the inline
 * "Explain this error" affordance on failed blocks.
 *
 * Shape
 * -----
 *   - `enabled` (boolean, default `true`): master switch for the feature.
 *     When `false`, the `<AiExplainPanel />` renders nothing regardless of
 *     the block's exit code. The keybinding and palette command still fire
 *     requests if explicitly invoked — the setting gates the *auto-mount*,
 *     not the hook.
 *   - `autoExplainThresholdExitCode` (number | null, default `null`):
 *     reserved for a later auto-explain mode. When set to a specific exit
 *     code (or any non-zero when a sentinel is picked in a later pass), the
 *     panel would kick off an `explain()` call automatically. Keeping the
 *     field here now avoids a store-shape migration later; this pass leaves
 *     it at `null` and the panel only explains on user click / shortcut.
 *
 * Persistence
 * -----------
 * localStorage-backed via a tiny hand-rolled hydrate pair (same shape as
 * `features/secret-detect/settings.ts`). Corrupt / missing values fall back
 * to the defaults. Private-mode browsers that reject `setItem` swallow the
 * error — the in-memory store still reflects the user's intent for the
 * session.
 */

import { create } from 'zustand';

export const AI_EXPLAIN_STORAGE_KEY = 'quanta:ai-explain';

export interface AiExplainSettings {
  readonly enabled: boolean;
  /**
   * When not null, failing commands whose exit code matches this value
   * trigger an auto-explain call on block completion. Default is `null`
   * ("always require a user click"); wired but intentionally unused by the
   * panel in this pass to keep auto-request behaviour opt-in.
   */
  readonly autoExplainThresholdExitCode: number | null;
}

export interface AiExplainSettingsStore extends AiExplainSettings {
  readonly setEnabled: (next: boolean) => void;
  readonly setAutoExplainThresholdExitCode: (next: number | null) => void;
}

const DEFAULTS: AiExplainSettings = {
  enabled: true,
  autoExplainThresholdExitCode: null,
};

export function readStoredAiExplainSettings(
  getItem?: (key: string) => string | null,
): AiExplainSettings {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  if (!get) return DEFAULTS;
  let raw: string | null;
  try {
    raw = get(AI_EXPLAIN_STORAGE_KEY);
  } catch {
    return DEFAULTS;
  }
  if (raw === null) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<AiExplainSettings>;
    const enabled =
      typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled;
    const threshold =
      typeof parsed.autoExplainThresholdExitCode === 'number' &&
      Number.isFinite(parsed.autoExplainThresholdExitCode)
        ? parsed.autoExplainThresholdExitCode
        : parsed.autoExplainThresholdExitCode === null
          ? null
          : DEFAULTS.autoExplainThresholdExitCode;
    return { enabled, autoExplainThresholdExitCode: threshold };
  } catch {
    return DEFAULTS;
  }
}

function writeStoredAiExplainSettings(next: AiExplainSettings): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(AI_EXPLAIN_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-mode Safari / storage full — swallow.
  }
}

export const useAiExplainSettings = create<AiExplainSettingsStore>((set, get) => {
  const initial = readStoredAiExplainSettings();
  return {
    ...initial,
    setEnabled: (next) => {
      const cur = get();
      if (cur.enabled === next) return;
      const merged: AiExplainSettings = {
        enabled: next,
        autoExplainThresholdExitCode: cur.autoExplainThresholdExitCode,
      };
      writeStoredAiExplainSettings(merged);
      set({ enabled: next });
    },
    setAutoExplainThresholdExitCode: (next) => {
      const cur = get();
      if (cur.autoExplainThresholdExitCode === next) return;
      const merged: AiExplainSettings = {
        enabled: cur.enabled,
        autoExplainThresholdExitCode: next,
      };
      writeStoredAiExplainSettings(merged);
      set({ autoExplainThresholdExitCode: next });
    },
  };
});

/** Test helper — reset to defaults and clear the backing storage entry. */
export function __resetAiExplainSettingsForTests(): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(AI_EXPLAIN_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
  useAiExplainSettings.setState({ ...DEFAULTS });
}

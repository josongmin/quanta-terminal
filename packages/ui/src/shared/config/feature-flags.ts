/**
 * Feature flags — Plan 0005 Epic δ.
 *
 * The flag surface is intentionally tiny: a single `blockUx` flag today,
 * with the type-level `[k: string]: boolean` catch-all reserved for future
 * flags (AI, split-pane polish, etc.).
 *
 * `blockUx` gates the P1 block presentation layer — `<BlockList />`,
 * `<BlockCard />`, `<Composer />`, `<CommandCorrectionHint />`,
 * `<ShellIntegrationBanner />`, `<BlockTagStrip />`, `<AiExplainPanel />`
 * and related widgets. When the flag is false (P0 default), none of those
 * widgets mount and the default UI is a plain grid fed by the session-level
 * `VtEmulator` via `SessionInputSurface` + `TuiRenderSurface`. Setting the
 * flag true (e.g. for P1-gated tests, opt-in dogfood users) re-enables the
 * block surface end-to-end.
 *
 * Why a tiny zustand store (and not a prop / Context): the flag is read
 * from deeply-nested widgets AND from imperative modules (router,
 * connect.ts, actions.ts). Zustand gives us a selector-based hook for the
 * React surface and a module-level `getState()` for the imperative surface
 * without forcing every consumer to thread a prop through.
 *
 * Persistence: localStorage under `quanta:feature-flags` (a single JSON
 * object so future flags piggyback without a storage migration). Writes
 * are best-effort — Safari private mode throws on setItem, so we catch
 * and proceed; the flag still takes effect for the current session.
 *
 * Env override: if `QUANTA_FLAG_BLOCK_UX === 'on'` at bundle time
 * (surfaced via `import.meta.env.QUANTA_FLAG_BLOCK_UX`), the flag starts
 * as `true` regardless of what localStorage holds. Useful for P1 dev
 * sessions and for CI runs that want the full block UI without toggling
 * at runtime.
 */

import { create } from 'zustand';

export interface FeatureFlags {
  /**
   * P1 Block UX. When false (P0 default), BlockList / BlockCard / Composer /
   * CommandCorrectionHint / ShellIntegrationBanner / BlockTagStrip / AiExplainPanel
   * and related widgets do NOT mount. The default UI is a plain grid fed by the
   * session-level VtEmulator.
   */
  readonly blockUx: boolean;
  /**
   * Plan 0005 P1-B opt-out auto-install. When true (default), the session
   * orchestrator fires `bridge.shellInstallAuto` fire-and-forget on first
   * spawn so users get OSC 133 shell integration without running the wizard.
   * Users who prefer the wizard path (or who are locked down by policy) can
   * set this to false via the settings panel.
   */
  readonly shellIntegrationAutoInstall: boolean;
  /**
   * Plan 0005 P1-E session restore. When true, the terminal page awaits
   * `replaySession(id)` before subscribing to a freshly-spawned PTY so the
   * grid appears seeded with the last-known state rather than blank. Off by
   * default while the journal format is still under review; flip from the
   * settings UI or via `QUANTA_FLAG_SESSION_RESTORE=on` at bundle time.
   */
  readonly sessionRestore: boolean;
  /** Reserved future flags. */
  readonly [k: string]: boolean;
}

export const DEFAULT_FLAGS: FeatureFlags = {
  blockUx: false,
  // Plan 0005 P1-B — opt-OUT default: the roadmap calls for auto-install to
  // be on for every new user, with a kill switch for policy-restricted
  // environments. If/when we need an opt-in rollout (e.g. enterprise
  // dogfood), flip this to false and schedule a gradual ramp.
  shellIntegrationAutoInstall: true,
  // Plan 0005 P1-E — default-off while the journal format is under review.
  // Tauri builds can flip this on by setting `QUANTA_FLAG_SESSION_RESTORE=on`
  // at bundle time; future P1-E dogfood graduates to default-on in Tauri and
  // off in the browser (no filesystem journal there today).
  sessionRestore: false,
};

/** Storage key — a single JSON blob for forward compatibility. */
export const FEATURE_FLAGS_STORAGE_KEY = 'quanta:feature-flags';

/** Env override key. Bundled read-once; runtime changes require reload. */
const ENV_OVERRIDE_KEY = 'QUANTA_FLAG_BLOCK_UX';

/**
 * Read `import.meta.env.QUANTA_FLAG_BLOCK_UX` in a way that survives
 * CJS / classic-script runtimes (tests, older bundlers). Returns `'on'`
 * only when the override is explicitly set to `on`; any other value is
 * ignored so a malformed env flag falls back to the localStorage path.
 */
function readEnvOverride(): 'on' | null {
  try {
    const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> })
      .env;
    if (!env) return null;
    const raw = env[ENV_OVERRIDE_KEY];
    return raw === 'on' ? 'on' : null;
  } catch {
    return null;
  }
}

/**
 * Pure helper — read the persisted flag object from the given getter.
 * Defaults to `localStorage` when available. Exported for tests.
 *
 * Invalid / malformed JSON falls back to `DEFAULT_FLAGS`. Unknown keys
 * in the stored blob are preserved (future-flag forward compatibility)
 * but coerced to `boolean` via `Boolean(...)` so a stray string
 * persistence can't leak into consumers.
 */
export function readStoredFlags(
  getItem?: (key: string) => string | null,
): FeatureFlags {
  const get =
    getItem ??
    (typeof localStorage !== 'undefined'
      ? (k: string): string | null => localStorage.getItem(k)
      : null);
  const envOverride = readEnvOverride();
  const base: FeatureFlags = envOverride === 'on'
    ? { ...DEFAULT_FLAGS, blockUx: true }
    : { ...DEFAULT_FLAGS };
  if (!get) return base;
  let raw: string | null;
  try {
    raw = get(FEATURE_FLAGS_STORAGE_KEY);
  } catch {
    return base;
  }
  if (raw === null) return base;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return base;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return base;
  }
  const merged: Record<string, boolean> = { ...base };
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    merged[k] = Boolean(v);
  }
  // Env override wins over stored value (security: dev/CI can force-on).
  if (envOverride === 'on') merged.blockUx = true;
  return merged as FeatureFlags;
}

function writeStoredFlags(next: FeatureFlags): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(FEATURE_FLAGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private-mode Safari / disabled storage — ignore. The current-session
    // store value still reflects the intent.
  }
}

interface FeatureFlagsStore {
  readonly flags: FeatureFlags;
  readonly set: <K extends keyof FeatureFlags>(flag: K, value: FeatureFlags[K]) => void;
  /** Reset all flags to `DEFAULT_FLAGS`. Test-friendly; also usable from a
   *  "reset to defaults" settings button. Persisted. */
  readonly reset: () => void;
  /** Test-only — re-reads storage. Keeps the public API clean while letting
   *  Vitest invalidate the cached flags between cases. */
  readonly _rehydrate: () => void;
}

export const useFeatureFlagsStore = create<FeatureFlagsStore>((set) => ({
  flags: readStoredFlags(),
  set: (flag, value) => {
    set((state) => {
      const next: FeatureFlags = { ...state.flags, [flag]: value } as FeatureFlags;
      writeStoredFlags(next);
      return { flags: next };
    });
  },
  reset: () => {
    writeStoredFlags(DEFAULT_FLAGS);
    set({ flags: { ...DEFAULT_FLAGS } });
  },
  _rehydrate: () => {
    set({ flags: readStoredFlags() });
  },
}));

// ----- Public API -----

/**
 * React hook — subscribe to a single feature flag. Returns `false` for any
 * key that is not present in the store (unknown flag).
 */
export function useFeatureFlag(flag: keyof FeatureFlags): boolean {
  return useFeatureFlagsStore((s) => Boolean(s.flags[flag]));
}

/**
 * Module-level getter — for imperative modules (router, connect.ts,
 * session-tabs actions) that can't use hooks. Reads the live zustand value
 * so a runtime change via `setFeatureFlag` is immediately visible.
 */
export function getFeatureFlag(flag: keyof FeatureFlags): boolean {
  return Boolean(useFeatureFlagsStore.getState().flags[flag]);
}

/**
 * Module-level setter — writes through the store (which persists). Only
 * accepts keys that exist on `FeatureFlags`. Passing an unknown key
 * no-ops (the index signature accepts any string at the type level; we
 * reject anything outside the current flag set at runtime so a typo
 * doesn't silently create a ghost flag).
 */
export function setFeatureFlag<K extends keyof FeatureFlags>(
  flag: K,
  value: FeatureFlags[K],
): void {
  // Restrict to actually-known flags. The index signature makes `keyof`
  // accept `string`, so we validate by checking the concrete DEFAULT_FLAGS.
  if (!(flag in DEFAULT_FLAGS)) return;
  useFeatureFlagsStore.getState().set(flag, value);
}

/**
 * Test-only — reset every flag to defaults. Exposed as a regular export
 * (not prefixed `__`) because production callers legitimately want a
 * "restore defaults" action from the settings UI.
 */
export function resetFeatureFlags(): void {
  useFeatureFlagsStore.getState().reset();
}

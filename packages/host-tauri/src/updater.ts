/**
 * Tauri updater wrapper (FIX 2, P0).
 *
 * The underlying `@tauri-apps/plugin-updater` API is stable but noisy; this
 * module narrows it to the two operations host-tauri actually needs:
 *
 *   - `checkForUpdates()` — probes the configured endpoint. Never throws;
 *     returns a discriminated union so callers can `switch` on outcome.
 *   - `installUpdate(update)` — downloads and installs an update fetched by
 *     `checkForUpdates`. Also never throws; returns `Ok`/`Err`.
 *
 * Why no throws: updater failures are non-fatal background events. The boot
 * path invokes `checkForUpdates()` once, non-blocking, and feeds the result
 * into the banner dispatcher; we don't want a transient network failure to
 * surface as an unhandled rejection at startup and trigger the crash hook.
 *
 * Banner dispatcher hook:
 *   UI registers a callback via `setUpdaterBannerDispatcher`; when set, the
 *   outcome is forwarded so the UI can show an "Update available — click to
 *   install" banner. Unset by default so unit tests don't require the UI.
 */

/**
 * Minimal shape we depend on from `@tauri-apps/plugin-updater`. We model
 * only the two surfaces the wrapper uses so the module is decoupled from
 * the plugin's full `.d.ts` — that file ships with the real dependency in
 * production bundles, but for typechecking inside this tree we don't want
 * to require it to be installed (the sidecar tree owns installation).
 */
interface PluginUpdateHandle {
  available?: boolean;
  version: string;
  currentVersion: string;
  body?: string | null;
  downloadAndInstall: () => Promise<void>;
}
interface PluginModule {
  check: () => Promise<PluginUpdateHandle | null>;
}

/**
 * The production loader. We go through a string variable the TS compiler
 * cannot statically resolve so that running the wrapper's tests doesn't
 * require the real plugin package to be installed on disk. In the shipped
 * bundle, Vite resolves the string at build time.
 */
const PLUGIN_SPECIFIER = '@tauri-apps/plugin-updater';
const defaultLoader = (): Promise<PluginModule> =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new Function('s', 'return import(s)')(PLUGIN_SPECIFIER) as Promise<PluginModule>;

/** Lazy-loaded reference so tests can stub the module without ESM hoisting. */
let pluginLoader: () => Promise<PluginModule> = defaultLoader;

/**
 * Test-only setter. Swap the loader so `checkForUpdates` uses a fake plugin.
 * Passing `null` restores the default dynamic import.
 */
export function __setUpdaterPluginLoader(loader: (() => Promise<PluginModule>) | null): void {
  pluginLoader = loader === null ? defaultLoader : loader;
}

/**
 * A minimal projection of the `Update` object the plugin returns. We store
 * only the fields the UI banner actually needs — `version`, `body`, and
 * `downloadAndInstall` — so the wrapper stays resilient across minor plugin
 * version bumps. The opaque `__raw` handle is passed verbatim back to
 * `installUpdate` so the wrapper doesn't need to reconstruct an Update.
 */
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  body: string | null;
  /**
   * Opaque handle on the plugin's `Update` object. Kept as `unknown` so the
   * wrapper doesn't leak the plugin's internal type into the public API.
   * Consumers must not inspect this field; it is only meaningful as the
   * argument to `installUpdate`.
   */
  __raw: unknown;
}

export type CheckForUpdatesResult =
  | { status: 'available'; update: AvailableUpdate }
  | { status: 'up-to-date' }
  | { status: 'error'; error: string };

export type InstallUpdateResult = { status: 'installed' } | { status: 'error'; error: string };

export type UpdaterBannerDispatcher = (result: CheckForUpdatesResult) => void;

let bannerDispatcher: UpdaterBannerDispatcher | null = null;

/**
 * UI registers a dispatcher that turns an updater outcome into a banner.
 * Pass `null` to clear (tests use this between cases).
 */
export function setUpdaterBannerDispatcher(fn: UpdaterBannerDispatcher | null): void {
  bannerDispatcher = fn;
}

function reasonText(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Check for an available update. Safe to call on every boot — failures are
 * caught and surfaced as an `error` variant; the caller never sees a throw.
 */
export async function checkForUpdates(): Promise<CheckForUpdatesResult> {
  let result: CheckForUpdatesResult;
  try {
    const plugin = await pluginLoader();
    const update = await plugin.check();
    if (!update || update.available === false) {
      result = { status: 'up-to-date' };
    } else {
      result = {
        status: 'available',
        update: {
          version: update.version,
          currentVersion: update.currentVersion,
          body: update.body ?? null,
          __raw: update,
        },
      };
    }
  } catch (err) {
    result = { status: 'error', error: reasonText(err) };
  }
  if (bannerDispatcher) {
    try {
      bannerDispatcher(result);
    } catch {
      // A broken banner dispatcher must not loop back through the crash
      // hook — swallow silently.
    }
  }
  return result;
}

/**
 * Install an update returned by `checkForUpdates`. The handle is the
 * `__raw` field on the `available` result. Returns `error` on any plugin
 * rejection; the caller is responsible for restart scheduling.
 */
export async function installUpdate(update: AvailableUpdate): Promise<InstallUpdateResult> {
  // Shape-check the opaque handle so a caller that fabricated an object
  // doesn't reach the plugin with a missing method.
  const raw = update.__raw as { downloadAndInstall?: () => Promise<void> } | null;
  if (!raw || typeof raw.downloadAndInstall !== 'function') {
    return {
      status: 'error',
      error: 'updater: AvailableUpdate.__raw missing downloadAndInstall; did you mutate it?',
    };
  }
  try {
    await raw.downloadAndInstall();
    return { status: 'installed' };
  } catch (err) {
    return { status: 'error', error: reasonText(err) };
  }
}

/**
 * Platform detection — shared, memoized entry point for the UI package.
 *
 * Problem this solves
 * -------------------
 * Prior to this module, platform sniffing was duplicated across at least four
 * places (`features/input/input-host.ts::detectPlatform`,
 * `features/tui/TuiRenderSurface.tsx::detectPlatform`,
 * `widgets/terminal-canvas/TerminalCanvas.tsx::detectPlatform`, and the keymap
 * helpers' `isMac/isWindows/isLinux` probes). Each copy had its own regex and
 * fallback, which meant that fixes to one (e.g. handling the iPadOS
 * user-agent quirk) had to be replayed in three other files. Review 4 (#21)
 * flagged the drift.
 *
 * The fix: one function, memoized on first call. Every consumer imports the
 * same `getPlatform()` and gets the same answer for the lifetime of the
 * process. Tests can reset the cache via `__resetPlatformCacheForTests`.
 *
 * Output shape
 * ------------
 * `Platform` mirrors the enum `features/input` already uses for its IME
 * blur-policy branch: `'macos' | 'windows' | 'linux'`. Callers that need a
 * fourth "other" bucket (the terminal canvas renderers do) keep their
 * dedicated helper — this module intentionally stays minimal so the
 * overwhelming majority of call sites can consume the same 3-way answer.
 *
 * Detection order
 * ---------------
 *   1. `navigator.platform` — legacy but still populated everywhere.
 *   2. `navigator.userAgent` — fallback when `platform` is '' (some
 *      stripped-down Electron / WebView builds).
 *   3. Default `'linux'` — safest non-mac fallback (keybind hints render as
 *      `Ctrl+K`, which also reads correctly on WSL, ChromeOS, and BSDs).
 */

export type Platform = 'macos' | 'windows' | 'linux';

let cached: Platform | null = null;

/**
 * Return the current platform. Memoized on first call so repeated reads are
 * free. Safe outside a browser (SSR / Node tests) — returns `'linux'` when
 * `navigator` is unavailable.
 */
export function getPlatform(): Platform {
  if (cached !== null) return cached;
  cached = detect();
  return cached;
}

/**
 * Test-only: drop the memoized value so `stubPlatform()` style tests can
 * observe a new `navigator.platform` override. Not exported from the package
 * barrel — importers must reach into this file directly, which keeps
 * production code from calling it by accident.
 */
export function __resetPlatformCacheForTests(): void {
  cached = null;
}

function detect(): Platform {
  if (typeof navigator === 'undefined') return 'linux';
  const plat = (navigator.platform ?? '').toLowerCase();
  const ua = (navigator.userAgent ?? '').toLowerCase();
  const combined = `${plat} ${ua}`;
  if (/mac|iphone|ipad|ipod/u.test(combined)) return 'macos';
  if (/win/u.test(combined)) return 'windows';
  if (/linux|x11|cros/u.test(combined)) return 'linux';
  return 'linux';
}

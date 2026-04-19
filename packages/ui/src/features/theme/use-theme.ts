/**
 * `useResolvedTheme` — returns the concrete 'light' or 'dark' currently in
 * effect, resolving 'system' against `prefers-color-scheme`.
 *
 * Callers that need the raw preference (for a theme picker UI) should read
 * `useThemeStore(s => s.theme)` directly. This hook is for widgets that only
 * care about the resolved value (e.g. "am I rendering on a light background?").
 */

import { useEffect, useState } from 'react';
import { useThemeStore, type ThemePreference } from './theme-store.js';

export type ResolvedTheme = 'light' | 'dark';

export function resolveTheme(
  pref: ThemePreference,
  prefersDark: boolean,
): ResolvedTheme {
  if (pref === 'light') return 'light';
  if (pref === 'dark') return 'dark';
  return prefersDark ? 'dark' : 'light';
}

/** Returns the current system preference. SSR-safe: falls back to 'dark'. */
export function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return true;
  }
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function useResolvedTheme(): ResolvedTheme {
  const pref = useThemeStore((s) => s.theme);
  const [prefersDark, setPrefersDark] = useState<boolean>(() => getSystemPrefersDark());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => setPrefersDark(mq.matches);
    // addEventListener is the modern API; Safari <14 used addListener but we
    // ship Electron-class runtimes everywhere so the modern path is enough.
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return resolveTheme(pref, prefersDark);
}

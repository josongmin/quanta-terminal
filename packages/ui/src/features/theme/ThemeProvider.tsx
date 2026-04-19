/**
 * ThemeProvider — applies `data-theme` on `<html>` based on the theme store
 * and the system preference.
 *
 * Rendering contract:
 *   - Mounts as a transparent wrapper; its children render unchanged.
 *   - On mount and whenever the resolved theme changes, it sets
 *     `document.documentElement.dataset.theme` to `'light'` or `'dark'`.
 *   - On unmount it leaves the attribute as-is — an unmount in production
 *     only happens during a full re-bootstrap, and clearing the attribute
 *     would cause a flash to default tokens during the transition.
 *
 * SSR safety: every `document`/`window` access is guarded.
 */

import { useEffect, type ReactNode } from 'react';
import { useResolvedTheme } from './use-theme.js';

export interface ThemeProviderProps {
  readonly children: ReactNode;
}

export function ThemeProvider(props: ThemeProviderProps) {
  const resolved = useResolvedTheme();
  useEffect(() => {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);
  return <>{props.children}</>;
}

ThemeProvider.displayName = 'ThemeProvider';

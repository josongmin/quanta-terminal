/**
 * Theme helpers — reads design token values from CSS variables so xterm.js
 * and React code both consume the same palette.
 */

import type { ITheme } from '@xterm/xterm';

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function buildXtermTheme(): ITheme {
  return {
    background: cssVar('--q-bg-terminal', '#0B0C10'),
    foreground: cssVar('--q-fg', '#E6E8EE'),
    cursor: cssVar('--q-term-cursor', '#7FB4FF'),
    cursorAccent: cssVar('--q-term-cursor-accent', '#0B0C10'),
    selectionBackground: cssVar('--q-term-selection', 'rgba(94, 160, 255, 0.28)'),
    black: cssVar('--q-ansi-black', '#0B0C10'),
    red: cssVar('--q-ansi-red', '#FF5C57'),
    green: cssVar('--q-ansi-green', '#5AF78E'),
    yellow: cssVar('--q-ansi-yellow', '#F3F99D'),
    blue: cssVar('--q-ansi-blue', '#57C7FF'),
    magenta: cssVar('--q-ansi-magenta', '#FF6AC1'),
    cyan: cssVar('--q-ansi-cyan', '#9AEDFE'),
    white: cssVar('--q-ansi-white', '#E6E8EE'),
    brightBlack: cssVar('--q-ansi-bright-black', '#4E5263'),
    brightRed: cssVar('--q-ansi-bright-red', '#FF6E67'),
    brightGreen: cssVar('--q-ansi-bright-green', '#5AF78E'),
    brightYellow: cssVar('--q-ansi-bright-yellow', '#F3F99D'),
    brightBlue: cssVar('--q-ansi-bright-blue', '#71D1FF'),
    brightMagenta: cssVar('--q-ansi-bright-magenta', '#FF92D0'),
    brightCyan: cssVar('--q-ansi-bright-cyan', '#B4F9FF'),
    brightWhite: cssVar('--q-ansi-bright-white', '#FFFFFF'),
  };
}

export const TERMINAL_FONT = {
  family: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  size: 13,
  lineHeight: 1.5,
  letterSpacing: 0,
} as const;

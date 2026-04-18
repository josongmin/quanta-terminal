/**
 * 256-color palette resolver.
 *
 * Indices 0..15 are "the 16 named colors" — we resolve them to the CSS tokens
 * shared with the named / bright color classes (so a theme change propagates
 * to indexed colors too). Indices 16..231 form the standard 6×6×6 color cube.
 * Indices 232..255 are the 24-step greyscale ramp.
 *
 * Returning a CSS `var(--…)` or an `rgb(…)` string keeps the renderer agnostic
 * to whether the color came from a SGR named code or a 256-code; both hit the
 * same terminal palette in the theme.
 */

const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

/** The 16 "named" cells map to the same tokens the class-based renderer uses. */
const NAMED_TOKENS: readonly string[] = [
  'var(--q-ansi-black)',
  'var(--q-ansi-red)',
  'var(--q-ansi-green)',
  'var(--q-ansi-yellow)',
  'var(--q-ansi-blue)',
  'var(--q-ansi-magenta)',
  'var(--q-ansi-cyan)',
  'var(--q-ansi-white)',
  'var(--q-ansi-bright-black)',
  'var(--q-ansi-bright-red)',
  'var(--q-ansi-bright-green)',
  'var(--q-ansi-bright-yellow)',
  'var(--q-ansi-bright-blue)',
  'var(--q-ansi-bright-magenta)',
  'var(--q-ansi-bright-cyan)',
  'var(--q-ansi-bright-white)',
];

/** Resolve an xterm 256-color index to a CSS color string. */
export function indexed256ToCss(index: number): string {
  if (index < 0) return NAMED_TOKENS[0]!;
  if (index < 16) return NAMED_TOKENS[index]!;
  if (index < 232) {
    const i = index - 16;
    const r = CUBE_STEPS[Math.floor(i / 36) % 6]!;
    const g = CUBE_STEPS[Math.floor(i / 6) % 6]!;
    const b = CUBE_STEPS[i % 6]!;
    return `rgb(${r}, ${g}, ${b})`;
  }
  if (index < 256) {
    const grey = 8 + (index - 232) * 10;
    return `rgb(${grey}, ${grey}, ${grey})`;
  }
  return NAMED_TOKENS[7]!;
}

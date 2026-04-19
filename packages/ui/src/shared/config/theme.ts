/**
 * Theme helpers.
 *
 * Historically exposed a `buildXtermTheme()` that produced an xterm.js
 * `ITheme` from CSS variables. After EPIC-I (xterm removal), the custom
 * Rust VT engine is the single renderer and consumes palette entries
 * through `shared/ui/ansi-output/palette` + the CSS tokens directly —
 * there is no intermediary theme object anymore.
 *
 * The file is kept as the canonical home for small terminal-font
 * constants shared between renderer and measurement helpers. If nothing
 * ends up depending on it we can delete the file outright.
 */

/** Canonical terminal monospace stack. Consumed where a JS-side numeric
 *  font size is needed (e.g., canvas measurement). CSS consumers should
 *  prefer the `--q-font-mono` / `--q-font-size-term` tokens. */
export const TERMINAL_FONT = {
  family: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
  size: 13,
  lineHeight: 1.5,
  letterSpacing: 0,
} as const;

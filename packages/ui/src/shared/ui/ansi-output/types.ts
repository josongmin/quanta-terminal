/**
 * Public types for the ANSI render surface.
 *
 * `AnsiSpan` lives here — not under `shared/lib/ansi-parser/` — because it is
 * fundamentally a render-time concept: the block entity store keeps raw PTY
 * bytes; spans exist only for the short window between parsing and painting.
 * Co-locating the type with the renderer keeps producer and consumer of the
 * shape in one place, and lets the parser treat spans as its output contract
 * rather than its domain model.
 *
 * Cross-slice within `shared/` is explicitly permitted by the FSD rule
 * (`check-fsd-layers.mjs` only forbids cross-slice for non-shared layers), so
 * `shared/lib/ansi-parser` consuming this module is legal.
 */

/**
 * Color kinds supported by SGR.
 *
 * - `named`   — 30-37 foreground, 40-47 background.
 * - `bright`  — 90-97 foreground, 100-107 background.
 * - `indexed` — 38;5;N / 48;5;N; N in 0..255.
 * - `rgb`     — 38;2;R;G;B / 48;2;R;G;B; each channel 0..255.
 * - `default` — 39 / 49; maps to the terminal default.
 */
export type AnsiColor =
  | { readonly kind: 'named'; readonly index: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 }
  | { readonly kind: 'bright'; readonly index: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 }
  | { readonly kind: 'indexed'; readonly index: number }
  | { readonly kind: 'rgb'; readonly r: number; readonly g: number; readonly b: number }
  | { readonly kind: 'default' };

/**
 * A single styled run of decoded text.
 *
 * Optional booleans are present only when set; a default span is just `{ text }`.
 * This keeps the serialized form small and `JSON.stringify`-friendly for tests.
 */
export interface AnsiSpan {
  readonly text: string;
  readonly fg?: AnsiColor;
  readonly bg?: AnsiColor;
  readonly bold?: boolean;
  readonly dim?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strike?: boolean;
  readonly inverse?: boolean;
  readonly hidden?: boolean;
  /** OSC 8 href applied to this run, if any. */
  readonly link?: string;
}

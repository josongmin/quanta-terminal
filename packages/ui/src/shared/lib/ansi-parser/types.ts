/**
 * Public types for the ANSI parser.
 *
 * A block accumulates bytes from the PTY stream. The parser converts those
 * bytes into a flat stream of styled `AnsiSpan` records — no tree, no cursor,
 * no screen model. The block renderer composes these spans into a `<pre>`
 * surface; real TUIs (alt-screen) are routed to xterm.js elsewhere per
 * ADR 0008.
 *
 * Design notes:
 *
 * - Every span is a contiguous styled run. A state change (SGR, OSC 8 open,
 *   OSC 8 close) closes the current span. `text` is the UTF-8 decoded string.
 * - Backspace (`\x08`) is preserved as a sentinel control character inside
 *   `text` so the renderer can emulate kernel TTY line-discipline visual
 *   backspace without pulling VT100 into the parser. The renderer decides
 *   whether to apply it based on its `carriageReturnRewrites` prop.
 * - BEL (`\x07`) is dropped by the parser. CR / LF are kept as-is.
 */

// AnsiSpan and AnsiColor are render-time concepts owned by the ansi-output
// slice. They are re-exported here so parser internals (`parser.ts`, `sgr.ts`)
// can keep importing from `./types.js` while the canonical declaration lives
// next to the renderer that consumes them.
export type { AnsiColor, AnsiSpan } from '../../ui/ansi-output/types.js';

/**
 * Sentinel character emitted into span text when the parser encounters a
 * literal backspace in the byte stream. Exposed so the renderer can look
 * for it without magic-string duplication.
 *
 * Chosen to match the real terminal control code so consumers that don't care
 * about visual backspace (e.g. a raw text dumper) see the expected byte.
 */
export const BACKSPACE_MARKER = '\u0008' as const;

/**
 * Side-channel event for DEC private-mode transitions the parser cares about
 * but does NOT surface in the regular `AnsiSpan[]` stream.
 *
 * Phase 3: alt-screen enter/exit (`ESC[?1049h/l`, `?1047h/l`, `?47h/l`) is
 * forwarded through the optional `AnsiParser.onMode` callback so the TUI
 * feature can flip the page layout without forcing the main parser output
 * shape to change.
 *
 * New `kind` variants may be added later (e.g. bracketed-paste `?2004`,
 * mouse mode `?1000`) without breaking the union — consumers default-ignore
 * unknown kinds.
 */
export type AnsiModeEvent =
  | { readonly kind: 'alt_screen_enter' }
  | { readonly kind: 'alt_screen_exit' };

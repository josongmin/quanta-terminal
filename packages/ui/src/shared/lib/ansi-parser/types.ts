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
 * Phase 4: additional DEC private modes are now reported so consumers (e.g.
 * a side-by-side harness or a standalone byte-stream inspector) can
 * reconstruct the terminal's input-relevant mode state without cross-wiring
 * into the Rust engine. The vocabulary mirrors EPIC-E's
 * `TerminalModeSnapshot` (`packages/ui/src/features/input/types.ts`) so
 * downstream code can apply events 1:1 without translating names.
 *
 * Consumers MUST handle unknown kinds gracefully — we explicitly reserve the
 * right to extend this union (and only this union) without a breaking change.
 * Existing `alt_screen_enter` / `alt_screen_exit` event shapes are preserved
 * verbatim; nothing about their order or payload changed in Phase 4.
 */
export type AnsiModeEvent =
  | { readonly kind: 'alt_screen_enter' }
  | { readonly kind: 'alt_screen_exit' }
  /** DECTCEM — cursor visibility (`?25h` / `?25l`). */
  | { readonly kind: 'cursor_visible_set'; readonly value: boolean }
  /** DECSET 2004 — bracketed paste (`?2004h` / `?2004l`). */
  | { readonly kind: 'bracketed_paste_set'; readonly value: boolean }
  /**
   * Mouse tracking mode selector. Matches `TerminalModeSnapshot.mouseTracking`:
   *   - `?1000 h/l` flips to/from `'button_event'` (VT200 button reporting;
   *     xterm groups 1000 and 1002 into the same "button + motion" bucket
   *     in EPIC-C's mirror, and we follow that convention here).
   *   - `?1002 h/l` same vocabulary: button + drag motion.
   *   - `?1003 h/l` flips to/from `'any_event'` (button + any motion).
   *   - The `'off'` kind fires on the `l` form; `'x10'` is emitted by
   *     `?9 h` (pre-VT200 compatibility — rarely seen but consistent with
   *     the enum and the engine-side mirror).
   */
  | {
      readonly kind: 'mouse_tracking_set';
      readonly mode: 'off' | 'x10' | 'button_event' | 'any_event';
    }
  /**
   * Mouse wire encoding selector. Matches
   * `TerminalModeSnapshot.mouseEncoding`:
   *   - `?1006 h/l` → `'sgr'` / `'default'`
   *   - `?1015 h/l` → `'url_xterm'` / `'default'`
   *   - `?1005 h/l` → `'utf8'` / `'default'`
   */
  | {
      readonly kind: 'mouse_encoding_set';
      readonly encoding: 'default' | 'utf8' | 'sgr' | 'url_xterm';
    }
  /** DECSET 1004 — focus in/out reporting (`?1004h` / `?1004l`). */
  | { readonly kind: 'focus_reporting_set'; readonly value: boolean }
  /** AT&T/DEC cursor blink (`?12h` / `?12l`). */
  | { readonly kind: 'cursor_blinking_set'; readonly value: boolean }
  /** DECOM — origin mode (`?6h` / `?6l`). */
  | { readonly kind: 'origin_mode_set'; readonly value: boolean };

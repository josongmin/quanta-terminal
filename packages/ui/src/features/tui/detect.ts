/**
 * Alt-screen byte-level detector.
 *
 * Mirrors the DEC private-mode subset the ANSI parser reports through
 * `onMode`, but runs OUTSIDE the parser on the raw byte stream that the
 * command router forwards to the active block. This is Path 2 from the
 * Phase-3 brief: a parallel detector that does not require us to swap every
 * `new AnsiParser()` site in the UI (BlockCard creates a parser per block).
 *
 * The detector is a small FSM that tolerates escape sequences straddling
 * chunk boundaries (a multi-KB TUI transition can trivially cross a 4 KiB
 * PTY read). It emits `alt_screen_enter` / `alt_screen_exit` events via
 * the injected callback in the exact order they appear in the stream.
 *
 * Implementation notes:
 *   - We look for the byte sequence `ESC '[' '?' <digits> ('h' | 'l')`, and
 *     match the digit run against `1049` / `1047` / `47`. Other private
 *     modes (`?25`, `?1000`, `?2004`, ...) are consumed by the FSM but do
 *     not emit anything.
 *   - Multi-parameter CSIs like `ESC[?1049;25h` are handled: we scan every
 *     `;`-separated number and fire at most one alt-screen event per CSI
 *     (matches `AnsiParser.onMode`).
 *   - Non-private CSIs (`ESC[A`, `ESC[0m`, ...) and unrelated escape
 *     families (OSC, DCS, APC, PM) are consumed and dropped — the detector
 *     only needs to recognize alt-screen shape, not everything real xterm
 *     parses.
 *   - We do NOT decode UTF-8 — escape sequences are ASCII, which means a
 *     multi-byte codepoint straddling a chunk boundary never lands inside
 *     our FSM state.
 */

/**
 * Alt-screen subset of the parser's `AnsiModeEvent` union. The detector
 * only emits these two kinds — we intentionally define the narrow shape
 * HERE rather than importing from `shared/lib/ansi-parser/` so this slice
 * does not become another non-render-path consumer of the parser module
 * (see the `check-one-render-path` CI rule). Shape and field names are
 * kept byte-identical to the parser's declaration so install.ts can
 * forward events 1:1 without translating. See
 * `shared/lib/ansi-parser/types.ts::AnsiModeEvent` for the wide union.
 */
export type AltScreenModeEvent =
  | { readonly kind: 'alt_screen_enter' }
  | { readonly kind: 'alt_screen_exit' };

const ESC = 0x1b;
const BEL = 0x07;

/**
 * Detector FSM states. Kept small and explicit — no table, one switch.
 *
 *   Ground          — outside any escape.
 *   Escape          — saw ESC; the next byte decides the family.
 *   Csi             — inside CSI; accumulate parameter + intermediate bytes.
 *   IgnoreUntilSt   — inside OSC / DCS / APC / PM; swallow until BEL or ST.
 */
type DetectorState = 'Ground' | 'Escape' | 'Csi' | 'IgnoreUntilSt';

export interface AltScreenDetector {
  /** Feed a chunk of raw bytes. Mode events fire synchronously in-order. */
  feed(bytes: Uint8Array): void;
  /** Reset FSM state. Useful for test teardown and block resets. */
  reset(): void;
}

export function createAltScreenDetector(
  onMode: (ev: AltScreenModeEvent) => void,
): AltScreenDetector {
  let state: DetectorState = 'Ground';
  /** CSI parameter + intermediate accumulator — ASCII only. */
  let csiBuf = '';
  /** Tracks the ESC-pending condition inside OSC/DCS/APC/PM for ST match. */
  let stEscPending = false;

  const handleCsi = (final: number): void => {
    if (final !== 0x68 /* h */ && final !== 0x6c /* l */) return;
    if (!csiBuf.startsWith('?')) return;
    const body = csiBuf.slice(1);
    let hasAltScreen = false;
    for (const raw of body.split(';')) {
      const trimmed = raw.trim();
      if (trimmed === '1049' || trimmed === '1047' || trimmed === '47') {
        hasAltScreen = true;
        break;
      }
    }
    if (!hasAltScreen) return;
    onMode({ kind: final === 0x68 ? 'alt_screen_enter' : 'alt_screen_exit' });
  };

  const step = (b: number): void => {
    switch (state) {
      case 'Ground':
        if (b === ESC) {
          state = 'Escape';
        }
        return;
      case 'Escape':
        switch (b) {
          case 0x5b /* [ */:
            state = 'Csi';
            csiBuf = '';
            return;
          case 0x5d /* ] */:
          case 0x50 /* P */:
          case 0x5f /* _ */:
          case 0x5e /* ^ */:
            state = 'IgnoreUntilSt';
            stEscPending = false;
            return;
          default:
            // Two-char escapes (charset selects, cursor save, etc.) — drop
            // one byte and return to Ground. We don't need to model them.
            state = 'Ground';
            return;
        }
      case 'Csi':
        // Parameter bytes 0x30-0x3F.
        if (b >= 0x30 && b <= 0x3f) {
          csiBuf += String.fromCharCode(b);
          return;
        }
        // Intermediate bytes 0x20-0x2F.
        if (b >= 0x20 && b <= 0x2f) {
          csiBuf += String.fromCharCode(b);
          return;
        }
        // Final byte 0x40-0x7E.
        if (b >= 0x40 && b <= 0x7e) {
          handleCsi(b);
          state = 'Ground';
          csiBuf = '';
          return;
        }
        // Garbage inside CSI; abort.
        state = 'Ground';
        csiBuf = '';
        return;
      case 'IgnoreUntilSt':
        if (stEscPending) {
          stEscPending = false;
          if (b === 0x5c /* \ */) {
            state = 'Ground';
            return;
          }
          // Lone ESC inside OSC/DCS/... — abort and go back to Ground.
          state = 'Ground';
          return;
        }
        if (b === BEL) {
          state = 'Ground';
          return;
        }
        if (b === ESC) {
          stEscPending = true;
          return;
        }
        // Any other byte is swallowed.
        return;
    }
  };

  return {
    feed(bytes) {
      for (let i = 0; i < bytes.length; i += 1) {
        const b = bytes[i];
        if (b === undefined) continue;
        step(b);
      }
    },
    reset() {
      state = 'Ground';
      csiBuf = '';
      stEscPending = false;
    },
  };
}

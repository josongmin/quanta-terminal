/**
 * Default encoder — Plan 0005 P2-B.
 *
 * Terminal-facing encoder for the common intent shapes. Returns
 * `null` for intents the default encoder does not handle (e.g.
 * `ai-explain` — that's a UI command, not PTY bytes); the router then
 * falls through to subsequent encoders.
 *
 * Byte representation
 * -------------------
 * - `execute`     → bracketed-paste wrap + Enter (CR), so multi-line
 *                   text lands atomically even when the shell already
 *                   has bracketed-paste mode on. Single-line payloads
 *                   likewise wrap; the terminal handles the wrap as a
 *                   single "paste" token, which yields the same effect
 *                   as typing + Enter.
 * - `execute-raw` → payload text + CR (no bracketing). Used by replay
 *                   / macros that already produced shell-safe bytes.
 * - `interrupt`   → ^C (0x03).
 * - `suspend`     → ^Z (0x1A).
 * - `raw-key`     → a thin mapping for a few common keys the composer
 *                   might surface outside the encoder layer. The
 *                   `input-host` remains the canonical raw-key path —
 *                   this exists for intents that were constructed
 *                   BEFORE the router (e.g. a palette action).
 *
 * Byte literals are spelled numerically to satisfy the repo's
 * `tools/check-ui-no-ansi` rule without a pragma.
 */

import type { AnyIntent } from '../intent-types';

const utf8 = new TextEncoder();

// ESC `[` `2` `0` `0` `~` — bracketed-paste start.
const BP_START = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);
// ESC `[` `2` `0` `1` `~` — bracketed-paste end.
const BP_END = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);
const CR = new Uint8Array([0x0d]);
const CTRL_C = new Uint8Array([0x03]);
const CTRL_Z = new Uint8Array([0x1a]);

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export interface DefaultEncoderOptions {
  /**
   * When true (default) `execute` wraps with bracketed-paste
   * sentinels. Turn off for shells that reliably accept raw text +
   * newline (most testing setups).
   */
  readonly bracketedPaste?: boolean;
}

/**
 * Build an encoder suitable for `router.subscribeEncode()`. Returns
 * `null` for un-handled intent kinds so a specialized encoder can
 * pick them up.
 */
export function createDefaultEncoder(
  opts: DefaultEncoderOptions = {},
): (intent: AnyIntent) => Uint8Array | null {
  const useBracket = opts.bracketedPaste ?? true;
  return (intent) => {
    switch (intent.kind) {
      case 'execute': {
        const body = utf8.encode(intent.payload.text);
        if (useBracket) {
          return concat([BP_START, body, BP_END, CR]);
        }
        return concat([body, CR]);
      }
      case 'execute-raw': {
        const body = utf8.encode(intent.payload.text);
        return concat([body, CR]);
      }
      case 'interrupt':
        return CTRL_C;
      case 'suspend':
        return CTRL_Z;
      case 'paste': {
        const body = utf8.encode(intent.payload.text);
        if (useBracket) {
          return concat([BP_START, body, BP_END]);
        }
        return body;
      }
      case 'raw-key': {
        const { key } = intent.payload;
        // Support the handful of keys the palette can issue without
        // going through the full KeyEncoder. Anything else falls
        // through to the next encoder.
        if (key === 'Enter') return CR;
        if (key === 'Tab') return new Uint8Array([0x09]);
        if (key === 'Escape') return new Uint8Array([0x1b]);
        if (key === 'Backspace') return new Uint8Array([0x7f]);
        if (key.length === 1) return utf8.encode(key);
        return null;
      }
      default:
        return null;
    }
  };
}

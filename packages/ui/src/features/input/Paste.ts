/**
 * Bracketed-paste encoder — EPIC-E §5 (Paste.ts).
 *
 * When `snapshot.bracketedPaste === true`, wraps the payload with the
 * xterm start/end sentinels. Filters any embedded sentinel sequences
 * from the payload so the application cannot be fooled by a payload
 * containing a synthetic end-sentinel.
 *
 * Note: bytes are assembled via numeric byte constants rather than
 * string escapes to satisfy the I-2 check-ui-no-ansi rule, which
 * allowlists `features/input/` but still flags `\x1b` literals without
 * a pragma. Byte literals are the right tool for a wire-layer encoder
 * anyway — no ANSI parsing happens here, only fixed-byte emission.
 */
import type { ModeSnapshot } from './ModeSnapshot';
import type { EncoderOutput, PasteEvent, TerminalModeSnapshot } from './types';

const utf8Encoder = new TextEncoder();

// ESC (0x1B) [ 2 0 0 ~ — bracketed-paste start.
const START = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]);
// ESC (0x1B) [ 2 0 1 ~ — bracketed-paste end.
const END = new Uint8Array([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]);

/**
 * Locate + strip any occurrences of the start/end sentinel byte
 * sequences from the payload. Byte-level so the check-rule sees no
 * string-escape form of ESC.
 */
function stripEmbeddedSentinels(input: Uint8Array): Uint8Array {
  const sentinels = [START, END];
  let current: Uint8Array = input;
  for (const needle of sentinels) {
    current = stripNeedle(current, needle);
  }
  return current;
}

function stripNeedle(haystack: Uint8Array, needle: Uint8Array): Uint8Array {
  const out = new Uint8Array(haystack.length);
  let w = 0;
  let i = 0;
  while (i < haystack.length) {
    if (i + needle.length <= haystack.length && matchAt(haystack, i, needle)) {
      i += needle.length;
      continue;
    }
    out[w++] = haystack[i++]!;
  }
  return out.slice(0, w);
}

function matchAt(hay: Uint8Array, at: number, needle: Uint8Array): boolean {
  for (let j = 0; j < needle.length; j++) {
    if (hay[at + j] !== needle[j]) return false;
  }
  return true;
}

function concat(a: Uint8Array, b: Uint8Array, c: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length + c.length);
  out.set(a, 0);
  out.set(b, a.length);
  out.set(c, a.length + b.length);
  return out;
}

export class Paste {
  readonly #modeSnapshot: ModeSnapshot | { read(): TerminalModeSnapshot; peekEpoch(): bigint };

  constructor(opts: { modeSnapshot: ModeSnapshot | { read(): TerminalModeSnapshot; peekEpoch(): bigint } }) {
    this.#modeSnapshot = opts.modeSnapshot;
  }

  encode(event: PasteEvent, snapshot?: TerminalModeSnapshot): EncoderOutput {
    const used = snapshot ?? this.#modeSnapshot.read();
    const text = event.text;

    if (!used.bracketedPaste) {
      return {
        bytes: utf8Encoder.encode(text),
        diagnostics: {
          modeReadInconsistency: false,
          deprecatedFallback: false,
          snapshotEpoch: used.snapshotEpoch,
        },
      };
    }

    const payload = stripEmbeddedSentinels(utf8Encoder.encode(text));
    const bytes = concat(START, payload, END);
    return {
      bytes,
      diagnostics: {
        modeReadInconsistency: false,
        deprecatedFallback: false,
        snapshotEpoch: used.snapshotEpoch,
      },
    };
  }
}

/**
 * Plan 0005 P0 audit — Paste encoder edge cases.
 *
 * The existing `Paste.test.ts` covers the happy paths (short, empty,
 * newline-bearing). This file adds the adversarial matrix:
 *
 *   §3.1  Payload containing raw control bytes (0x03, 0x1b) survives
 *         under both bracketed and non-bracketed modes — they are
 *         opaque data.
 *   §3.2  Payload containing ONLY the start/end sentinel sequence
 *         collapses to the sentinel wrapper with an empty body.
 *   §3.3  Multi-megabyte payload does not throw / truncate / OOM.
 *   §3.4  Payload with CRLF is preserved verbatim (no \r\n → \n rewrite).
 *   §3.5  Sentinel-like partial matches (ESC [ 2 0 0 + non-~) are NOT
 *         stripped.
 *   §3.6  Non-ASCII UTF-8 survives the sentinel strip path.
 *
 * The strip path in `Paste.ts` replaces every embedded sentinel *byte
 * sequence* with empty, not the string — so a test with a literal
 * `\x1b[200~` mid-payload proves the byte-level implementation.
 */
import { describe, expect, it } from 'vitest';

import { createStubMirror, ModeSnapshot } from '../ModeSnapshot';
import { Paste } from '../Paste';
import type { TerminalModeSnapshot } from '../types';

const utf8 = new TextEncoder();

function snap(bp: boolean): TerminalModeSnapshot {
  return Object.freeze({
    decckm: false,
    bracketedPaste: bp,
    focusReporting: false,
    mouseTracking: 'off' as const,
    mouseEncoding: 'default' as const,
    modifyOtherKeys: 0 as const,
    kittyKeyboard: 0 as const,
    altScreen: false,
    synchronizedUpdate: false,
    snapshotEpoch: 0n,
  });
}

function toHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

function makePaste(): Paste {
  return new Paste({ modeSnapshot: new ModeSnapshot(createStubMirror()) });
}

// ---------------------------------------------------------------------------
// §3.1 — control bytes in the payload are opaque data, not commands
// ---------------------------------------------------------------------------
describe('audit §3.1 — control bytes in paste payload are opaque', () => {
  it('bp=off: Ctrl+C (0x03) in the middle of pasted text is forwarded raw', () => {
    /**
     * Without bracketed paste, the shell sees a literal 0x03 in the
     * middle of the paste. This will typically be interpreted as SIGINT
     * mid-paste, which is the shell's problem, not the encoder's. The
     * encoder MUST NOT strip it.
     */
    const p = makePaste();
    const out = p.encode({ text: 'ls\x03rm', length: 6 }, snap(false));
    expect(toHex(out.bytes)).toBe('6c7303726d');
  });

  it('bp=on: Ctrl+C in the payload is wrapped but not stripped', () => {
    const p = makePaste();
    const out = p.encode({ text: 'ls\x03rm', length: 6 }, snap(true));
    // ESC [ 2 0 0 ~  'l' 's' 0x03 'r' 'm'  ESC [ 2 0 1 ~
    expect(toHex(out.bytes)).toBe('1b5b3230307e6c7303726d1b5b3230317e');
  });

  it('bp=on: ESC (0x1b) byte that does NOT form a sentinel stays in payload', () => {
    /**
     * ONLY the full sentinel sequences (`ESC [ 2 0 0 ~` / `ESC [ 2 0 1 ~`)
     * are stripped. A bare ESC or an `ESC [ something-else` must pass
     * through unchanged — the stripper is a literal 6-byte match, not a
     * generic CSI parser.
     */
    const p = makePaste();
    const out = p.encode(
      { text: 'a\x1b[3mstyled\x1b[0m', length: 16 },
      snap(true),
    );
    // Body is 'a', ESC, '[', '3', 'm', 's', 't', 'y', 'l', 'e', 'd', ESC, '[', '0', 'm'
    expect(toHex(out.bytes)).toBe(
      '1b5b3230307e611b5b336d7374796c65641b5b306d1b5b3230317e',
    );
  });
});

// ---------------------------------------------------------------------------
// §3.2 — sentinel-only payload
// ---------------------------------------------------------------------------
describe('audit §3.2 — sentinel-only payloads collapse under strip', () => {
  it('payload IS the start sentinel → body is empty, wrapper intact', () => {
    /**
     * Attacker pastes exactly `\x1b[200~` hoping to inject a "real" paste
     * start inside our wrapper. The stripper removes it; the result is
     * an empty bracketed-paste wrapper (length 12 = 6 start + 0 body +
     * 6 end).
     */
    const p = makePaste();
    const out = p.encode(
      { text: '\x1b[200~', length: 6 },
      snap(true),
    );
    expect(toHex(out.bytes)).toBe('1b5b3230307e1b5b3230317e');
    expect(out.bytes.byteLength).toBe(12);
  });

  it('payload IS the end sentinel → body is empty, wrapper intact', () => {
    const p = makePaste();
    const out = p.encode({ text: '\x1b[201~', length: 6 }, snap(true));
    expect(toHex(out.bytes)).toBe('1b5b3230307e1b5b3230317e');
  });

  it('payload is multiple adjacent sentinels → all removed', () => {
    /**
     * Defense-in-depth: a malicious payload could chain sentinels to try
     * to slip one past. The stripper is called per-sentinel in a loop
     * over `[START, END]`, so adjacent duplicates collapse completely.
     */
    const p = makePaste();
    const out = p.encode(
      { text: '\x1b[200~\x1b[200~X\x1b[201~\x1b[201~', length: 28 },
      snap(true),
    );
    // Only 'X' survives inside the wrapper.
    expect(toHex(out.bytes)).toBe('1b5b3230307e581b5b3230317e');
  });
});

// ---------------------------------------------------------------------------
// §3.3 — very large payloads
// ---------------------------------------------------------------------------
describe('audit §3.3 — large payloads do not throw or truncate', () => {
  it('1 MB text passes through (bp=off) at expected length', () => {
    /**
     * Generates a deterministic 1 048 576 byte ASCII payload. No gate,
     * no truncation — the host's write path is responsible for
     * chunking; the encoder just emits the bytes.
     */
    const p = makePaste();
    const text = 'a'.repeat(1_048_576);
    const out = p.encode({ text, length: text.length }, snap(false));
    expect(out.bytes.byteLength).toBe(1_048_576);
    expect(out.bytes[0]).toBe(0x61);
    expect(out.bytes[out.bytes.byteLength - 1]).toBe(0x61);
  });

  it('1 MB with bracketed paste wraps the payload exactly', () => {
    const p = makePaste();
    const text = 'b'.repeat(1_048_576);
    const out = p.encode({ text, length: text.length }, snap(true));
    expect(out.bytes.byteLength).toBe(6 + 1_048_576 + 6);
    // Verify sentinel bytes at the expected boundary.
    const START = [0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e];
    const END = [0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e];
    for (let i = 0; i < 6; i += 1) {
      expect(out.bytes[i]).toBe(START[i]);
      expect(out.bytes[out.bytes.byteLength - 6 + i]).toBe(END[i]);
    }
  });
});

// ---------------------------------------------------------------------------
// §3.4 — CRLF preservation
// ---------------------------------------------------------------------------
describe('audit §3.4 — newline variants preserved verbatim', () => {
  it('bp=off: CRLF pastes as 0x0d 0x0a (no rewrite)', () => {
    /**
     * The encoder MUST NOT normalize line endings. The shell or the
     * application decides semantics.
     */
    const p = makePaste();
    const out = p.encode(
      { text: 'a\r\nb\r\nc', length: 7 },
      snap(false),
    );
    // 0x61 0x0d 0x0a 0x62 0x0d 0x0a 0x63
    expect(toHex(out.bytes)).toBe('610d0a620d0a63');
  });

  it('bp=on: CRLF is inside the bracketed-paste wrapper unchanged', () => {
    const p = makePaste();
    const out = p.encode({ text: 'a\r\nb', length: 4 }, snap(true));
    expect(toHex(out.bytes)).toBe('1b5b3230307e610d0a621b5b3230317e');
  });

  it('bp=on: bare CR (no LF) preserved', () => {
    /** Old Mac line endings. Still data. */
    const p = makePaste();
    const out = p.encode({ text: 'a\rb', length: 3 }, snap(true));
    expect(toHex(out.bytes)).toBe('1b5b3230307e610d621b5b3230317e');
  });
});

// ---------------------------------------------------------------------------
// §3.5 — near-sentinel sequences survive
// ---------------------------------------------------------------------------
describe('audit §3.5 — partial sentinel matches are NOT stripped', () => {
  /**
   * The stripper looks for EXACT 6-byte runs. Anything that merely
   * starts like a sentinel (e.g. `ESC [ 2 0 0` without the `~` or
   * `ESC [ 2 0 2 ~` with a wrong digit) must pass through.
   */
  it('bp=on: ESC [ 2 0 0 <SPACE> is NOT a sentinel, stays in body', () => {
    const p = makePaste();
    const out = p.encode({ text: '\x1b[200 ', length: 6 }, snap(true));
    // Full body bytes: 1b 5b 32 30 30 20
    expect(toHex(out.bytes)).toBe('1b5b3230307e1b5b32303020' + '1b5b3230317e');
  });

  it('bp=on: ESC [ 2 0 2 ~ (one digit off) passes through', () => {
    const p = makePaste();
    const out = p.encode({ text: '\x1b[202~', length: 6 }, snap(true));
    // Body: 1b 5b 32 30 32 7e
    expect(toHex(out.bytes)).toBe('1b5b3230307e1b5b3230327e1b5b3230317e');
  });
});

// ---------------------------------------------------------------------------
// §3.6 — multibyte UTF-8 in the stripper
// ---------------------------------------------------------------------------
describe('audit §3.6 — multibyte UTF-8 survives sentinel-stripper', () => {
  it('bp=on: "한글" + sentinel-in-middle → Korean bytes intact, sentinel gone', () => {
    /**
     * Korean "한글" is 6 UTF-8 bytes: ED 95 9C EA B8 80. Placing a
     * sentinel between them proves the stripper walks BYTES, not
     * characters — important because the stripper was implemented as
     * a pure byte scan in Paste.ts.
     */
    const p = makePaste();
    const out = p.encode(
      { text: '한\x1b[200~글', length: 9 },
      snap(true),
    );
    // Wrapper + ED 95 9C EA B8 80 + Wrapper_end
    expect(toHex(out.bytes)).toBe(
      '1b5b3230307eed959ceab8801b5b3230317e',
    );
  });

  it('bp=off: emoji payload (4-byte UTF-8) passes through verbatim', () => {
    /** Grinning face emoji U+1F600 → F0 9F 98 80. */
    const p = makePaste();
    const out = p.encode({ text: '😀', length: 2 }, snap(false));
    expect(toHex(out.bytes)).toBe('f09f9880');
  });
});

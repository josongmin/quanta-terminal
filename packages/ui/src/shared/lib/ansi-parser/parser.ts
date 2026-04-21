/**
 * Streaming ANSI parser.
 *
 * A single block's PTY output is fed in as `Uint8Array` chunks over time.
 * `feed()` returns any completed spans. Partial bytes at chunk boundaries are
 * held internally: UTF-8 codepoints may straddle chunks, and escape sequences
 * (CSI, OSC) can span many chunks in practice.
 *
 * The FSM — explicit states, no table:
 *
 *   Ground           plain text; flush printable bytes into the current span,
 *                    emit span on style / link change.
 *   Escape           saw `\x1b`; next byte dispatches.
 *     → `[`          → Csi
 *     → `]`          → Osc
 *     → `\\` (ST)    ignored (we already closed the prior state)
 *     → `P` (DCS)    → IgnoreUntilSt  (swallow to ESC \ or BEL)
 *     → `_` (APC)    → IgnoreUntilSt
 *     → `^` (PM)     → IgnoreUntilSt
 *     → `c` (RIS)    full reset — equivalent to internal `reset()`.
 *     → anything else: silently drop, return to Ground. (Charset selects
 *                    `( ) * +` + one byte, cursor-save `7`, etc. — we don't
 *                    care about the payload because blocks aren't a screen.)
 *   Csi              accumulate `CSI` parameter + intermediate bytes.
 *     On final byte `m` → apply SGR, return to Ground.
 *     On any other final byte (A-Z, a-z, @, `) → ignore (cursor, erase),
 *                                                 return to Ground.
 *     Private-mode `?1049h/l`, `?1047h/l`, `?47h/l` (alt-screen) and a
 *     broader Phase-4 set (cursor visibility `?25`, bracketed paste
 *     `?2004`, mouse tracking `?1000/?1002/?1003`, mouse encoding
 *     `?1005/?1006/?1015`, focus reporting `?1004`, cursor blink `?12`,
 *     origin mode `?6`) do not affect the span output, but ARE reported
 *     through the optional `onMode` side-channel callback. The Phase 3 TUI
 *     feature uses this to flip the page layout between BlockList and
 *     xterm; other consumers (dev tools, side-by-side harness) use it to
 *     reconstruct `TerminalModeSnapshot` state from the byte stream. When
 *     `onMode` is unset the CSI is still silently dropped, matching
 *     pre-Phase-3 behaviour.
 *   Osc              accumulate payload; terminator is either BEL or `ESC \`.
 *                    On terminator: if payload starts with `8;`, parse OSC 8.
 *   IgnoreUntilSt    consume bytes until `ESC \` (ST) or BEL; drop all.
 *
 * Emission policy: a span is emitted when (a) the current styled run ends
 * (style change, link change, end of chunk with text), or (b) `flush()` is
 * called and there's unfinished text. Runs of any length are fine; the
 * renderer does not care about span size.
 *
 * Streaming invariants:
 *   - `feed(a); feed(b); flush()` produces the same visible text as
 *     `feed(concat(a,b)); flush()`. Tested explicitly.
 *   - UTF-8 multibyte split across feeds is re-joined via TextDecoder's
 *     `{ stream: true }` mode. Tested explicitly.
 */

import { applySgr, createStyle, resetStyle, spanFromStyle, type Style } from './sgr.js';
import { BACKSPACE_MARKER, type AnsiModeEvent, type AnsiSpan } from './types.js';

const ESC = 0x1b;
const BEL = 0x07;
const BS = 0x08;
// CR (0x0d) and LF (0x0a) are printable from the parser's POV — they fall
// through the `stepGround` default and are pushed into the text buffer as-is.

type FsmState =
  | 'Ground'
  | 'Escape'
  | 'Csi'
  | 'Osc'
  | 'IgnoreUntilSt';

export class AnsiParser {
  private state: FsmState = 'Ground';
  private readonly style: Style = createStyle();
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  /** Pending text bytes for the current styled run. Decoded lazily at flush. */
  private textBuf: number[] = [];
  /** CSI/OSC accumulator — ASCII only, so a string is fine. */
  private seqBuf = '';
  /**
   * True when the previous byte inside `Osc` was `ESC`; next `\\` terminates.
   * Used by both Osc and IgnoreUntilSt for the ST terminator.
   */
  private oscEscPending = false;
  /**
   * Optional side-channel for DEC private-mode transitions the parser would
   * otherwise drop on the floor. See `AnsiModeEvent` for the kinds emitted.
   *
   * Additive and backwards-compatible: when unset the parser behaves exactly
   * as it did before this callback existed. Consumers (see
   * `features/tui/install`) assign after construction. Event dispatch happens
   * AFTER the CSI has been consumed, so callbacks are free to read state
   * without racing the parser.
   */
  public onMode?: (ev: AnsiModeEvent) => void;
  /**
   * Optional hook fired when a **bare** BEL (0x07) is seen in Ground state.
   * BELs that terminate OSC / DCS / APC / PM strings do NOT fire this hook —
   * those are string terminators, not bells (see stepOsc / stepIgnore).
   *
   * Additive and backwards-compatible: when unset the parser still drops the
   * BEL silently, preserving historical behaviour.
   */
  public onBell?: () => void;

  feed(bytes: Uint8Array): AnsiSpan[] {
    const out: AnsiSpan[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i]!;
      this.step(b, out);
    }
    this.drainText(out);
    return out;
  }

  flush(): AnsiSpan[] {
    const out: AnsiSpan[] = [];
    // End-of-stream: decode any buffered bytes to release a trailing
    // partial codepoint as a replacement character. We only do this if there
    // IS pending text — otherwise we'd emit empty spans.
    if (this.textBuf.length > 0) {
      const bytes = new Uint8Array(this.textBuf);
      this.textBuf = [];
      const text = this.decoder.decode(bytes, { stream: false });
      if (text.length > 0) out.push(spanFromStyle(text, this.style));
    } else {
      // Still flush the decoder to drop any retained state for a fresh start.
      this.decoder.decode(new Uint8Array(0), { stream: false });
    }
    return out;
  }

  reset(): void {
    this.state = 'Ground';
    resetStyle(this.style);
    delete this.style.link;
    this.textBuf = [];
    this.seqBuf = '';
    this.oscEscPending = false;
    // Reset the decoder too — a fresh block must not inherit any half-seen
    // multibyte codepoint from the previous block.
    this.decoder.decode(new Uint8Array(0), { stream: false });
  }

  // ---------------------------------------------------------------------------

  private step(b: number, out: AnsiSpan[]): void {
    switch (this.state) {
      case 'Ground':
        this.stepGround(b, out);
        return;
      case 'Escape':
        this.stepEscape(b);
        return;
      case 'Csi':
        this.stepCsi(b, out);
        return;
      case 'Osc':
        this.stepOsc(b, out);
        return;
      case 'IgnoreUntilSt':
        this.stepIgnore(b);
        return;
    }
  }

  private stepGround(b: number, out: AnsiSpan[]): void {
    if (b === ESC) {
      this.drainText(out);
      this.state = 'Escape';
      return;
    }
    if (b === BEL) {
      // Bare BEL in Ground — surface via the optional `onBell` side channel
      // (features/bell wires this into the bell store). When unset we drop
      // silently, matching pre-bell-hook behaviour. BEL inside OSC / DCS is
      // a string terminator and is handled in stepOsc / stepIgnore.
      if (this.onBell) {
        try {
          this.onBell();
        } catch {
          // Never let host callback failure corrupt parser state.
        }
      }
      return;
    }
    if (b === BS) {
      // Kernel TTY line-discipline backspace marker. Kept in the text stream
      // so the renderer can emulate visual backspace when asked. Chosen as
      // the literal 0x08 byte so round-tripping is trivial.
      this.textBuf.push(b);
      return;
    }
    // CR and LF are preserved verbatim. Everything else is a printable byte
    // (from ANSI's perspective — we let TextDecoder deal with UTF-8).
    this.textBuf.push(b);
  }

  private stepEscape(b: number): void {
    // CSI / OSC / DCS / APC / PM entry dispatcher.
    switch (b) {
      case 0x5b: // [
        this.state = 'Csi';
        this.seqBuf = '';
        return;
      case 0x5d: // ]
        this.state = 'Osc';
        this.seqBuf = '';
        this.oscEscPending = false;
        return;
      case 0x50: // P (DCS)
      case 0x5f: // _ (APC)
      case 0x5e: // ^ (PM)
        this.state = 'IgnoreUntilSt';
        this.oscEscPending = false;
        return;
      case 0x5c: // \ (ST) — stray ST has no effect here.
        this.state = 'Ground';
        return;
      case 0x63: // c — RIS (Full Reset / Reset to Initial State).
        // xterm / ECMA-48 semantics: ESC c returns the terminal to its
        // power-on defaults — SGR reset, no active hyperlink, no half-
        // consumed escape sequences, no pending partial UTF-8 codepoint.
        // Internally this is exactly what `reset()` does, so we call it
        // directly. The FSM state switch back to Ground is implicit in
        // `reset()` as well.
        //
        // Note: RIS does not emit a side-channel mode event here — the
        // `AnsiModeEvent` union reports CSI-driven DEC private-mode
        // transitions, not global terminal resets, and consumers already
        // apply their own "reset mirror on RIS" policy at a higher layer.
        // Block-level state (cursor origin, tab stops, etc.) is not modeled
        // by this parser, so the style/link/FSM reset covers everything the
        // parser owns.
        this.reset();
        return;
      default:
        // Two-char escapes like `ESC 7` (save cursor), `ESC M` (reverse index),
        // charset selects `ESC ( B`. We don't model any of these — blocks
        // aren't a screen. Drop and return to Ground.
        //
        // Note: a charset select like `ESC ( B` has a two-byte payload; the
        // next byte (`B`) will be interpreted as Ground text. That's fine for
        // the 99.9% case where the payload is a no-op selector. Real terminal
        // emulators handle this differently, but for block-mode it's
        // acceptable collateral damage.
        this.state = 'Ground';
        return;
    }
  }

  private stepCsi(b: number, out: AnsiSpan[]): void {
    // ECMA-48: parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F,
    // final byte 0x40-0x7E.
    if (b >= 0x30 && b <= 0x3f) {
      this.seqBuf += String.fromCharCode(b);
      return;
    }
    if (b >= 0x20 && b <= 0x2f) {
      this.seqBuf += String.fromCharCode(b);
      return;
    }
    if (b >= 0x40 && b <= 0x7e) {
      this.dispatchCsi(b, out);
      this.state = 'Ground';
      this.seqBuf = '';
      return;
    }
    // Invalid byte inside CSI — abort and return to Ground.
    this.state = 'Ground';
    this.seqBuf = '';
  }

  private dispatchCsi(final: number, out: AnsiSpan[]): void {
    // Private-mode markers like `?1049h` start with `?`. Alt-screen
    // enter/exit fans out to `onMode` when configured (Phase 3 TUI fallback),
    // and Phase 4 extends `onMode` to cover cursor visibility, bracketed
    // paste, mouse tracking/encoding, focus reporting, cursor blink, and
    // origin mode. Anything else stays dropped. Style updates (`m`) are the
    // only other CSI we act on.
    if (final === 0x68 /* h */ || final === 0x6c /* l */) {
      this.maybeDispatchMode(final);
      return;
    }
    if (final !== 0x6d /* m */) return;

    // A bare `CSI m` with no parameters is equivalent to `CSI 0 m`.
    // We also reject private-mode SGR (`CSI ? ... m`) because that's not a
    // real SGR variant; real terminals ignore it.
    if (this.seqBuf.startsWith('?') || this.seqBuf.startsWith('>')) return;

    // Style is about to change; emit current text before mutating.
    this.drainText(out);

    const params = parseSgrParams(this.seqBuf);
    applySgr(params, this.style);
  }

  /**
   * Fan out `onMode` events for the DEC private-mode set/reset we just
   * consumed. Multiple parameters in a single CSI (e.g. `ESC[?25;2004h`)
   * are tolerated: we scan each `;`-separated value and dispatch one event
   * per recognized mode, in source order — matching how real xterm handles
   * batched private-mode changes.
   *
   * Alt-screen transitions (1049 / 1047 / 47) intentionally coalesce to a
   * single `alt_screen_enter` / `alt_screen_exit` per CSI so the pre-Phase-4
   * contract is preserved byte-for-byte. All other recognized modes emit one
   * event each. Unknown codes are ignored (the CSI itself is still consumed
   * by the FSM).
   *
   * Mode-to-event mapping mirrors EPIC-E's `TerminalModeSnapshot` vocabulary
   * (see `packages/ui/src/features/input/types.ts`) so consumers can apply
   * events 1:1 against the mirror without translating names.
   */
  private maybeDispatchMode(final: number): void {
    if (this.onMode === undefined) return;
    if (!this.seqBuf.startsWith('?')) return;
    // `?1049;25` → `1049;25`, stripping the leading marker only.
    const body = this.seqBuf.slice(1);
    const isSet = final === 0x68; /* h */
    const emit = this.onMode;
    // Fire alt-screen at most once per CSI, regardless of how many of the
    // three alt-screen codes appear. Pathological `?1049;1047h` still
    // produces exactly one event, preserving Phase-3 semantics.
    let altScreenFired = false;
    for (const raw of body.split(';')) {
      // Trim intermediates like 0x20 in case a terminal emits `?1049 h`.
      const code = raw.trim();
      if (code === '') continue;
      if (code === '1049' || code === '1047' || code === '47') {
        if (altScreenFired) continue;
        altScreenFired = true;
        emit({ kind: isSet ? 'alt_screen_enter' : 'alt_screen_exit' });
        continue;
      }
      switch (code) {
        case '6':
          emit({ kind: 'origin_mode_set', value: isSet });
          continue;
        case '9':
          // Pre-VT200 X10 compatibility mouse reporting. Rarely seen today,
          // but included so a `TerminalModeSnapshot` rehydrator has a place
          // to land the `'x10'` variant of `mouseTracking`.
          emit({
            kind: 'mouse_tracking_set',
            mode: isSet ? 'x10' : 'off',
          });
          continue;
        case '12':
          emit({ kind: 'cursor_blinking_set', value: isSet });
          continue;
        case '25':
          emit({ kind: 'cursor_visible_set', value: isSet });
          continue;
        case '1000':
        case '1002':
          // EPIC-C's mirror collapses 1000 (button reporting) and 1002
          // (button + drag) into `'button_event'`. We follow that
          // vocabulary so events can be applied without translation.
          emit({
            kind: 'mouse_tracking_set',
            mode: isSet ? 'button_event' : 'off',
          });
          continue;
        case '1003':
          emit({
            kind: 'mouse_tracking_set',
            mode: isSet ? 'any_event' : 'off',
          });
          continue;
        case '1004':
          emit({ kind: 'focus_reporting_set', value: isSet });
          continue;
        case '1005':
          emit({
            kind: 'mouse_encoding_set',
            encoding: isSet ? 'utf8' : 'default',
          });
          continue;
        case '1006':
          emit({
            kind: 'mouse_encoding_set',
            encoding: isSet ? 'sgr' : 'default',
          });
          continue;
        case '1015':
          emit({
            kind: 'mouse_encoding_set',
            encoding: isSet ? 'url_xterm' : 'default',
          });
          continue;
        case '2004':
          emit({ kind: 'bracketed_paste_set', value: isSet });
          continue;
        default:
          // Unknown private mode — dropped. Keeps the side-channel
          // conservative: we never surface a mode we can't name.
          continue;
      }
    }
  }

  private stepOsc(b: number, out: AnsiSpan[]): void {
    if (this.oscEscPending) {
      this.oscEscPending = false;
      if (b === 0x5c /* \ */) {
        // ST terminator.
        this.finishOsc(out);
        this.state = 'Ground';
        this.seqBuf = '';
        return;
      }
      // Lone ESC inside OSC — the spec calls this malformed; we abort.
      this.state = 'Ground';
      this.seqBuf = '';
      return;
    }
    if (b === BEL) {
      this.finishOsc(out);
      this.state = 'Ground';
      this.seqBuf = '';
      return;
    }
    if (b === ESC) {
      this.oscEscPending = true;
      return;
    }
    this.seqBuf += String.fromCharCode(b);
  }

  private finishOsc(out: AnsiSpan[]): void {
    // Only OSC 8 (hyperlinks) is in scope. Everything else (title 0/1/2,
    // working-dir 7, clipboard 52, iTerm2 1337, etc.) is silently ignored.
    const payload = this.seqBuf;
    if (!payload.startsWith('8;')) return;

    // Format: `8;<params>;<URL>`. Params are key=value pairs joined by `:`
    // (currently we ignore them; `id=` is the only defined one) but we must
    // tolerate them.
    const firstSemi = payload.indexOf(';');
    const secondSemi = payload.indexOf(';', firstSemi + 1);
    if (secondSemi === -1) return;
    const url = payload.slice(secondSemi + 1);

    // Style is about to change (link opens or closes); emit pending text.
    this.drainText(out);

    if (url === '') {
      // Close.
      delete this.style.link;
    } else {
      // Open. Nesting policy: innermost wins — a new OSC 8 open simply
      // overwrites the current `link`. This matches real terminals.
      this.style.link = url;
    }
  }

  private stepIgnore(b: number): void {
    if (this.oscEscPending) {
      this.oscEscPending = false;
      if (b === 0x5c /* \ */) {
        this.state = 'Ground';
        this.seqBuf = '';
        return;
      }
      return;
    }
    if (b === BEL) {
      this.state = 'Ground';
      this.seqBuf = '';
      return;
    }
    if (b === ESC) {
      this.oscEscPending = true;
      return;
    }
    // Drop everything else.
  }

  // ---------------------------------------------------------------------------

  /**
   * If there are buffered text bytes, decode them (streaming — partial UTF-8
   * codepoints stay held inside the decoder) and push a span. If the resulting
   * decoded text is empty (e.g. because we only have a partial codepoint),
   * nothing is emitted.
   */
  private drainText(out: AnsiSpan[]): void {
    if (this.textBuf.length === 0) return;
    const bytes = new Uint8Array(this.textBuf);
    this.textBuf = [];
    const text = this.decoder.decode(bytes, { stream: true });
    if (text.length === 0) return;
    out.push(spanFromStyle(text, this.style));
  }
}

/**
 * Parse an SGR parameter string like `"1;31;48;5;200"` into a number array.
 * An empty string maps to `[0]` per ECMA-48. Empty slots (e.g. `"1;;3"`) map
 * to `0` — this matches xterm behavior.
 */
function parseSgrParams(raw: string): readonly number[] {
  if (raw.length === 0) return [0];
  const out: number[] = [];
  let acc = 0;
  let seen = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charCodeAt(i);
    if (ch === 0x3b /* ; */) {
      out.push(seen ? acc : 0);
      acc = 0;
      seen = false;
      continue;
    }
    // Sub-parameter separator `:` is spec'd (ECMA-48) but vanishingly rare in
    // real SGR streams; treat as `;` to stay tolerant.
    if (ch === 0x3a /* : */) {
      out.push(seen ? acc : 0);
      acc = 0;
      seen = false;
      continue;
    }
    if (ch >= 0x30 && ch <= 0x39) {
      acc = acc * 10 + (ch - 0x30);
      seen = true;
      continue;
    }
    // Anything else (including `?` private marker we already filtered) is
    // ignored; real CSI won't reach here after dispatch.
  }
  out.push(seen ? acc : 0);
  return out;
}

export { BACKSPACE_MARKER };

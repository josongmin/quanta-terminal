/**
 * Alt-screen mode side-channel tests.
 *
 * The parser's public `onMode` callback fires when a DEC private-mode CSI
 * for alt-screen transitions (`?1049`, `?1047`, `?47` set/reset) is consumed.
 * These events are additive — they do not change the `AnsiSpan[]` stream,
 * which keeps all pre-existing tests green.
 *
 * Scope:
 *   - `?1049h/l`, `?1047h/l`, `?47h/l` all map to enter/exit respectively.
 *   - Events fire once per DEC sequence. A parser that never has `onMode`
 *     assigned behaves exactly as it did before Phase 3.
 *   - Nested enters do not double-fire unless the stream re-issues the
 *     sequence.
 *   - Multi-parameter CSIs like `?1049;25h` (enter alt-screen + show cursor
 *     together) still surface a single alt-screen enter.
 */

import { describe, expect, it } from 'vitest';
import { AnsiParser } from '../parser.js';
import type { AnsiModeEvent } from '../types.js';

const enc = new TextEncoder();

function driveWithEvents(input: string): {
  readonly events: AnsiModeEvent[];
  readonly text: string;
} {
  const events: AnsiModeEvent[] = [];
  const p = new AnsiParser();
  p.onMode = (ev) => events.push(ev);
  const spans = p.feed(enc.encode(input));
  const tail = p.flush();
  const text = [...spans, ...tail].map((s) => s.text).join('');
  return { events, text };
}

describe('AnsiParser.onMode (alt-screen side-channel)', () => {
  it('fires alt_screen_enter on ESC[?1049h', () => {
    const { events, text } = driveWithEvents('\x1b[?1049hHELLO');
    expect(events).toEqual([{ kind: 'alt_screen_enter' }]);
    expect(text).toBe('HELLO');
  });

  it('fires alt_screen_exit on ESC[?1049l', () => {
    const { events, text } = driveWithEvents('x\x1b[?1049ly');
    expect(events).toEqual([{ kind: 'alt_screen_exit' }]);
    expect(text).toBe('xy');
  });

  it('fires enter/exit pair across a full mock vim session', () => {
    const stream = 'pre\x1b[?1049h<tui>\x1b[?1049lpost';
    const { events, text } = driveWithEvents(stream);
    expect(events).toEqual([
      { kind: 'alt_screen_enter' },
      { kind: 'alt_screen_exit' },
    ]);
    expect(text).toBe('pre<tui>post');
  });

  it('recognizes legacy ?1047 and ?47 variants', () => {
    expect(driveWithEvents('\x1b[?1047h').events).toEqual([
      { kind: 'alt_screen_enter' },
    ]);
    expect(driveWithEvents('\x1b[?1047l').events).toEqual([
      { kind: 'alt_screen_exit' },
    ]);
    expect(driveWithEvents('\x1b[?47h').events).toEqual([
      { kind: 'alt_screen_enter' },
    ]);
    expect(driveWithEvents('\x1b[?47l').events).toEqual([
      { kind: 'alt_screen_exit' },
    ]);
  });

  it('single CSI with batched params like ?1049;25h emits alt_screen_enter + cursor_visible_set', () => {
    // xterm batches multiple DEC private-modes with `;`. Show-cursor (?25)
    // is a common companion to alt-screen-enter. Phase 4: each recognized
    // mode fires in source order, and alt-screen stays coalesced to one
    // event across the three alt-screen codes (1049/1047/47).
    const { events } = driveWithEvents('\x1b[?1049;25h');
    expect(events).toEqual([
      { kind: 'alt_screen_enter' },
      { kind: 'cursor_visible_set', value: true },
    ]);
  });

  it('batched CSI with only non-alt-screen modes still emits their Phase-4 events', () => {
    // Phase 4: show-cursor (?25) now surfaces as `cursor_visible_set` even
    // when no alt-screen code is present. Spans are unaffected.
    const { events, text } = driveWithEvents('\x1b[?25htext');
    expect(events).toEqual([{ kind: 'cursor_visible_set', value: true }]);
    expect(text).toBe('text');
  });

  it('nested enters do not coalesce — the stream decides fire count', () => {
    // Two alt-screen-enters in a row (a TUI that nests would emit this).
    // The parser is a mechanical forwarder: two sequences → two events.
    const { events } = driveWithEvents('\x1b[?1049h\x1b[?1049h');
    expect(events).toEqual([
      { kind: 'alt_screen_enter' },
      { kind: 'alt_screen_enter' },
    ]);
  });

  it('without onMode attached, parser behaviour is unchanged', () => {
    // This is the contract that keeps existing tests green: alt-screen CSIs
    // are still silently dropped when no consumer subscribes.
    const p = new AnsiParser();
    const spans = p.feed(enc.encode('\x1b[?1049hHELLO\x1b[?1049l'));
    const tail = p.flush();
    const text = [...spans, ...tail].map((s) => s.text).join('');
    expect(text).toBe('HELLO');
  });

  it('alt-screen CSI straddling a feed boundary still fires once', () => {
    // Escape sequences may cross chunk boundaries. The parser holds state
    // in `seqBuf`, so a split between `?1049` and `h` must still dispatch.
    const p = new AnsiParser();
    const events: AnsiModeEvent[] = [];
    p.onMode = (ev) => events.push(ev);
    p.feed(enc.encode('\x1b[?10'));
    p.feed(enc.encode('49h'));
    expect(events).toEqual([{ kind: 'alt_screen_enter' }]);
  });
});

/**
 * Phase 4 extension — non-alt-screen private modes surface through the same
 * `onMode` side-channel. The vocabulary mirrors `TerminalModeSnapshot`
 * (EPIC-E), so consumers can apply events to the mirror without translation.
 */
describe('AnsiParser.onMode (Phase 4 non-alt-screen modes)', () => {
  function drive(input: string): AnsiModeEvent[] {
    const events: AnsiModeEvent[] = [];
    const p = new AnsiParser();
    p.onMode = (ev) => events.push(ev);
    p.feed(enc.encode(input));
    p.flush();
    return events;
  }

  it('?25h fires cursor_visible_set=true', () => {
    expect(drive('\x1b[?25h')).toEqual([
      { kind: 'cursor_visible_set', value: true },
    ]);
  });

  it('?25l fires cursor_visible_set=false', () => {
    expect(drive('\x1b[?25l')).toEqual([
      { kind: 'cursor_visible_set', value: false },
    ]);
  });

  it('?2004h fires bracketed_paste_set=true', () => {
    expect(drive('\x1b[?2004h')).toEqual([
      { kind: 'bracketed_paste_set', value: true },
    ]);
  });

  it('?2004l fires bracketed_paste_set=false', () => {
    expect(drive('\x1b[?2004l')).toEqual([
      { kind: 'bracketed_paste_set', value: false },
    ]);
  });

  it('?1000h fires mouse_tracking_set=button_event (VT200 button reporting)', () => {
    expect(drive('\x1b[?1000h')).toEqual([
      { kind: 'mouse_tracking_set', mode: 'button_event' },
    ]);
  });

  it('?1000l fires mouse_tracking_set=off', () => {
    expect(drive('\x1b[?1000l')).toEqual([
      { kind: 'mouse_tracking_set', mode: 'off' },
    ]);
  });

  it('?1002h fires mouse_tracking_set=button_event (button + drag, same bucket)', () => {
    expect(drive('\x1b[?1002h')).toEqual([
      { kind: 'mouse_tracking_set', mode: 'button_event' },
    ]);
  });

  it('?1003h fires mouse_tracking_set=any_event', () => {
    expect(drive('\x1b[?1003h')).toEqual([
      { kind: 'mouse_tracking_set', mode: 'any_event' },
    ]);
  });

  it('?1003l fires mouse_tracking_set=off', () => {
    expect(drive('\x1b[?1003l')).toEqual([
      { kind: 'mouse_tracking_set', mode: 'off' },
    ]);
  });

  it('?9h fires mouse_tracking_set=x10 (legacy pre-VT200)', () => {
    expect(drive('\x1b[?9h')).toEqual([
      { kind: 'mouse_tracking_set', mode: 'x10' },
    ]);
  });

  it('?1006h fires mouse_encoding_set=sgr', () => {
    expect(drive('\x1b[?1006h')).toEqual([
      { kind: 'mouse_encoding_set', encoding: 'sgr' },
    ]);
  });

  it('?1006l fires mouse_encoding_set=default', () => {
    expect(drive('\x1b[?1006l')).toEqual([
      { kind: 'mouse_encoding_set', encoding: 'default' },
    ]);
  });

  it('?1005h fires mouse_encoding_set=utf8', () => {
    expect(drive('\x1b[?1005h')).toEqual([
      { kind: 'mouse_encoding_set', encoding: 'utf8' },
    ]);
  });

  it('?1015h fires mouse_encoding_set=url_xterm', () => {
    expect(drive('\x1b[?1015h')).toEqual([
      { kind: 'mouse_encoding_set', encoding: 'url_xterm' },
    ]);
  });

  it('?1004h fires focus_reporting_set=true', () => {
    expect(drive('\x1b[?1004h')).toEqual([
      { kind: 'focus_reporting_set', value: true },
    ]);
  });

  it('?1004l fires focus_reporting_set=false', () => {
    expect(drive('\x1b[?1004l')).toEqual([
      { kind: 'focus_reporting_set', value: false },
    ]);
  });

  it('?12h fires cursor_blinking_set=true', () => {
    expect(drive('\x1b[?12h')).toEqual([
      { kind: 'cursor_blinking_set', value: true },
    ]);
  });

  it('?12l fires cursor_blinking_set=false', () => {
    expect(drive('\x1b[?12l')).toEqual([
      { kind: 'cursor_blinking_set', value: false },
    ]);
  });

  it('?6h fires origin_mode_set=true', () => {
    expect(drive('\x1b[?6h')).toEqual([
      { kind: 'origin_mode_set', value: true },
    ]);
  });

  it('?6l fires origin_mode_set=false', () => {
    expect(drive('\x1b[?6l')).toEqual([
      { kind: 'origin_mode_set', value: false },
    ]);
  });

  it('batched multi-mode CSI emits each event in source order', () => {
    // `?25;2004h` — cursor visible + bracketed paste, in that order. Both
    // events fire in the order they appear in the parameter list.
    expect(drive('\x1b[?25;2004h')).toEqual([
      { kind: 'cursor_visible_set', value: true },
      { kind: 'bracketed_paste_set', value: true },
    ]);
  });

  it('batched CSI mixing alt-screen with other modes preserves order + coalescing', () => {
    // `?1049;25;2004h` — alt-screen enter fires once, followed by cursor
    // and bracketed-paste events in order.
    expect(drive('\x1b[?1049;25;2004h')).toEqual([
      { kind: 'alt_screen_enter' },
      { kind: 'cursor_visible_set', value: true },
      { kind: 'bracketed_paste_set', value: true },
    ]);
  });

  it('batched CSI with two alt-screen codes still coalesces to one event', () => {
    // Pathological but harmless: `?1049;1047h` — both are alt-screen enter.
    // Phase-4 preserves the pre-existing contract of a single event per CSI.
    expect(drive('\x1b[?1049;1047h')).toEqual([
      { kind: 'alt_screen_enter' },
    ]);
  });

  it('unknown private mode (?9999) is consumed silently', () => {
    expect(drive('\x1b[?9999h')).toEqual([]);
  });

  it('mixed known + unknown modes only fires events for known ones', () => {
    // `?9999;25h` — unknown then known; only `cursor_visible_set` fires.
    expect(drive('\x1b[?9999;25h')).toEqual([
      { kind: 'cursor_visible_set', value: true },
    ]);
  });

  it('without onMode attached, Phase-4 modes are still dropped silently', () => {
    // Backward-compat guardrail: the extended vocabulary must NOT introduce
    // any span-level side effects when no consumer subscribes.
    const p = new AnsiParser();
    const spans = p.feed(enc.encode('pre\x1b[?25hmid\x1b[?2004hpost'));
    const tail = p.flush();
    const text = [...spans, ...tail].map((s) => s.text).join('');
    expect(text).toBe('premidpost');
  });
});

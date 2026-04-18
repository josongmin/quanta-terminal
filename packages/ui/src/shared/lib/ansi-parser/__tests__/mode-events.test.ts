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

  it('single CSI with batched params like ?1049;25h emits one enter', () => {
    // xterm batches multiple DEC private-modes with `;`. Show-cursor (?25)
    // is a common companion to alt-screen-enter. Emit one event, not two.
    const { events } = driveWithEvents('\x1b[?1049;25h');
    expect(events).toEqual([{ kind: 'alt_screen_enter' }]);
  });

  it('batched CSI with only unrelated modes emits nothing', () => {
    // Show-cursor alone: no alt-screen involvement.
    const { events, text } = driveWithEvents('\x1b[?25htext');
    expect(events).toEqual([]);
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

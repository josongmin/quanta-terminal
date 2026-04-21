/**
 * Alt-screen byte-level detector.
 *
 * Mirrors `AnsiParser.onMode` assertions but on the raw-byte FSM Path 2
 * uses. The detector must tolerate chunk boundaries splitting an escape
 * sequence, multi-parameter CSIs, and unrelated private modes.
 */

import { describe, expect, it } from 'vitest';
import { createAltScreenDetector, type AltScreenModeEvent } from '../detect.js';

const enc = new TextEncoder();

function run(input: string): AltScreenModeEvent[] {
  const events: AltScreenModeEvent[] = [];
  const d = createAltScreenDetector((ev) => events.push(ev));
  d.feed(enc.encode(input));
  return events;
}

describe('createAltScreenDetector', () => {
  it('fires enter on ESC[?1049h', () => {
    expect(run('\x1b[?1049h')).toEqual([{ kind: 'alt_screen_enter' }]);
  });

  it('fires exit on ESC[?1049l', () => {
    expect(run('\x1b[?1049l')).toEqual([{ kind: 'alt_screen_exit' }]);
  });

  it('recognizes ?1047 and ?47 variants', () => {
    expect(run('\x1b[?1047h')).toEqual([{ kind: 'alt_screen_enter' }]);
    expect(run('\x1b[?47h')).toEqual([{ kind: 'alt_screen_enter' }]);
    expect(run('\x1b[?1047l')).toEqual([{ kind: 'alt_screen_exit' }]);
    expect(run('\x1b[?47l')).toEqual([{ kind: 'alt_screen_exit' }]);
  });

  it('ignores unrelated private modes (?25 show cursor, ?2004 bracketed paste)', () => {
    expect(run('\x1b[?25h\x1b[?2004h')).toEqual([]);
  });

  it('emits both events for a full vim-shaped session', () => {
    const events = run('pre\x1b[?1049h<tui>\x1b[?1049lpost');
    expect(events).toEqual([
      { kind: 'alt_screen_enter' },
      { kind: 'alt_screen_exit' },
    ]);
  });

  it('batched params like ?1049;25h emit a single enter', () => {
    expect(run('\x1b[?1049;25h')).toEqual([{ kind: 'alt_screen_enter' }]);
  });

  it('handles a sequence that straddles feed boundaries', () => {
    const events: AltScreenModeEvent[] = [];
    const d = createAltScreenDetector((ev) => events.push(ev));
    d.feed(enc.encode('\x1b[?10'));
    d.feed(enc.encode('49h'));
    expect(events).toEqual([{ kind: 'alt_screen_enter' }]);
  });

  it('ignores OSC payloads even if they contain ?1049-looking bytes', () => {
    // An OSC 0 title of "?1049h" would otherwise look like a false positive.
    // The detector's IgnoreUntilSt state must swallow until BEL / ST.
    const events = run('\x1b]0;fake ?1049h\x07done');
    expect(events).toEqual([]);
  });

  it('ignores DCS payloads', () => {
    const events = run('\x1bPfake ?1049h\x1b\\after');
    expect(events).toEqual([]);
  });

  it('nested enters fire twice (store layer handles coalescing)', () => {
    const events = run('\x1b[?1049h\x1b[?1049h');
    expect(events).toEqual([
      { kind: 'alt_screen_enter' },
      { kind: 'alt_screen_enter' },
    ]);
  });

  it('reset drops FSM state mid-sequence', () => {
    const events: AltScreenModeEvent[] = [];
    const d = createAltScreenDetector((ev) => events.push(ev));
    d.feed(enc.encode('\x1b[?10'));
    d.reset();
    // 49h on its own is plain text — no event, no crash.
    d.feed(enc.encode('49h'));
    expect(events).toEqual([]);
  });
});

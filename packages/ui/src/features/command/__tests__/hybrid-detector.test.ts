/**
 * SOTA coverage for `features/command/hybrid-detector.ts`.
 *
 * The hybrid detector is a state machine that interleaves four independent
 * boundary signals — OSC 133, prompt-regex, cursor-home, idle — and merges
 * them through a confidence-ranked arbitration layer. These tests focus on
 * the MAIN surface (feed / tick / reset / setSignals, ordering, integration
 * scenarios). The per-signal edge cases live in sibling suites:
 *
 *   - `hybrid-detector-osc133.test.ts` — OSC 133 payload shapes + parser edges.
 *   - `hybrid-detector-heuristic.test.ts` — prompt-regex fallback.
 *   - `hybrid-detector-confidence.test.ts` — arbitration window + suppression.
 *
 * Design notes
 * ------------
 *  - `makeClock()` returns an injectable `now()` that tests advance by hand,
 *    so no test relies on real wall clock / `vi.useFakeTimers`. This keeps
 *    the spec deterministic and independent of Vitest's timer polyfill.
 *  - OSC 133 sequences are built with `osc133(kind, payload?)` helper so the
 *    fixtures read as `osc133('A')` / `osc133('D', '0;cwd=/tmp')` instead of
 *    inscrutable byte arrays.
 */

import { describe, expect, it } from 'vitest';
import { createHybridBoundaryDetector } from '../hybrid-detector.js';
import type {
  BoundaryEvent,
  HybridBoundaryDetectorOptions,
} from '../hybrid-detector-types.js';

// ----- Helpers -----

function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Build `ESC ] 133 ; <kind>[;payload] BEL`. */
function osc133(kind: 'A' | 'B' | 'C' | 'D', payload?: string): Uint8Array {
  const body = payload ? `${kind};${payload}` : kind;
  return concat(
    new Uint8Array([0x1b, 0x5d]), // ESC ]
    ascii(`133;${body}`),
    new Uint8Array([0x07]), // BEL
  );
}

/** Variant with ST (`ESC \`) terminator rather than BEL. */
function osc133St(
  kind: 'A' | 'B' | 'C' | 'D',
  payload?: string,
): Uint8Array {
  const body = payload ? `${kind};${payload}` : kind;
  return concat(
    new Uint8Array([0x1b, 0x5d]),
    ascii(`133;${body}`),
    new Uint8Array([0x1b, 0x5c]), // ESC \
  );
}

function makeClock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (v) => {
      t = v;
    },
  };
}

type PartialOptions = Partial<HybridBoundaryDetectorOptions> & {
  readonly shellIntegration?: HybridBoundaryDetectorOptions['shellIntegration'];
};

function makeDetector(partial: PartialOptions = {}) {
  const clock = makeClock();
  const options: HybridBoundaryDetectorOptions = {
    shellIntegration: partial.shellIntegration ?? 'installed',
    now: partial.now ?? clock.now,
    ...(partial.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: partial.idleTimeoutMs }
      : {}),
    ...(partial.suppressionWindowMs !== undefined
      ? { suppressionWindowMs: partial.suppressionWindowMs }
      : {}),
    ...(partial.promptPatterns !== undefined
      ? { promptPatterns: partial.promptPatterns }
      : {}),
    ...(partial.onEvent !== undefined ? { onEvent: partial.onEvent } : {}),
    ...(partial.onSuppressed !== undefined
      ? { onSuppressed: partial.onSuppressed }
      : {}),
  };
  const detector = createHybridBoundaryDetector(options);
  return { detector, clock };
}

// ----- A. Construction + smoke tests -----

describe('createHybridBoundaryDetector — construction & basic surface', () => {
  it('returns a detector whose feed/tick/setSignals/reset are callable', () => {
    const { detector } = makeDetector();
    expect(typeof detector.feed).toBe('function');
    expect(typeof detector.tick).toBe('function');
    expect(typeof detector.setSignals).toBe('function');
    expect(typeof detector.reset).toBe('function');
  });

  it('feed returns an empty array for an empty chunk', () => {
    const { detector } = makeDetector();
    const out = detector.feed(new Uint8Array(0));
    expect(out).toEqual([]);
  });

  it('feed with unrelated ASCII bytes emits no events', () => {
    const { detector } = makeDetector();
    const out = detector.feed(ascii('hello world'));
    expect(out).toEqual([]);
  });

  it('tick before idle threshold emits nothing', () => {
    const { detector, clock } = makeDetector({ idleTimeoutMs: 400 });
    detector.feed(ascii('starting'));
    clock.advance(100);
    expect(detector.tick(clock.now())).toEqual([]);
  });
});

// ----- B. OSC 133 lifecycle -----

describe('hybrid-detector — OSC 133 lifecycle', () => {
  it('emits prompt_start on OSC 133 A', () => {
    const { detector } = makeDetector();
    const out = detector.feed(osc133('A'));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('prompt_start');
    expect(out[0]?.source).toBe('osc133');
    expect(out[0]?.confidence).toBe(1.0);
  });

  it('emits command_start on OSC 133 B', () => {
    const { detector } = makeDetector();
    const out = detector.feed(osc133('B'));
    expect(out[0]?.kind).toBe('command_start');
  });

  it('emits output_start on OSC 133 C', () => {
    const { detector } = makeDetector();
    const out = detector.feed(osc133('C'));
    expect(out[0]?.kind).toBe('output_start');
  });

  it('emits command_end on OSC 133 D with exit code', () => {
    const { detector } = makeDetector();
    const out = detector.feed(osc133('D', '0'));
    expect(out[0]?.kind).toBe('command_end');
    expect(out[0]?.exitCode).toBe(0);
    expect(out[0]?.source).toBe('osc133');
  });

  it('emits the full A→B→C→D lifecycle in order within one feed', () => {
    const { detector } = makeDetector();
    const chunk = concat(
      osc133('A'),
      ascii('user@host:~$ '),
      osc133('B'),
      ascii('ls\n'),
      osc133('C'),
      ascii('file1 file2\n'),
      osc133('D', '0'),
    );
    const out = detector.feed(chunk);
    expect(out.map((e) => e.kind)).toEqual([
      'prompt_start',
      'command_start',
      'output_start',
      'command_end',
    ]);
  });

  it('honours ST-terminated OSC sequences (`ESC \\` instead of BEL)', () => {
    const { detector } = makeDetector();
    const out = detector.feed(osc133St('D', '42'));
    expect(out[0]?.kind).toBe('command_end');
    expect(out[0]?.exitCode).toBe(42);
  });
});

// ----- C. Chunk straddling -----

describe('hybrid-detector — chunk straddling', () => {
  it('OSC 133 D split across two feeds surfaces on the second feed', () => {
    const { detector } = makeDetector();
    const full = osc133('D', '7');
    const splitAt = 6;
    const first = full.slice(0, splitAt);
    const rest = full.slice(splitAt);
    const out1 = detector.feed(first);
    expect(out1).toEqual([]);
    const out2 = detector.feed(rest);
    expect(out2).toHaveLength(1);
    expect(out2[0]?.kind).toBe('command_end');
    expect(out2[0]?.exitCode).toBe(7);
  });

  it('OSC 133 fed byte-by-byte still resolves exactly once', () => {
    const { detector } = makeDetector();
    const bytes = osc133('A');
    let collected: BoundaryEvent[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      collected = collected.concat(detector.feed(bytes.slice(i, i + 1)));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]?.kind).toBe('prompt_start');
  });
});

// ----- D. Heuristic regex -----

describe('hybrid-detector — heuristic regex source', () => {
  it('emits prompt_start for `$ ` at start of a new line (installed integration: 0.8)', () => {
    const { detector } = makeDetector({ shellIntegration: 'installed' });
    const out = detector.feed(ascii('output\n$ '));
    expect(out.map((e) => e.kind)).toContain('prompt_start');
    const match = out.find((e) => e.source === 'heuristic_regex');
    expect(match?.confidence).toBe(0.8);
  });

  it('emits prompt_start for zsh `% ` at 0.6 when shell integration missing', () => {
    const { detector } = makeDetector({ shellIntegration: 'missing' });
    const out = detector.feed(ascii('done\n% '));
    const match = out.find((e) => e.source === 'heuristic_regex');
    expect(match?.confidence).toBe(0.6);
  });

  it('fires only once per line even when prompt text extends', () => {
    const { detector, clock } = makeDetector({ suppressionWindowMs: 1000 });
    clock.set(2_000_000);
    const out1 = detector.feed(ascii('line\n$ '));
    const promptCount1 = out1.filter(
      (e) => e.source === 'heuristic_regex',
    ).length;
    expect(promptCount1).toBeGreaterThanOrEqual(1);
    // Immediate follow-up with more text on the same line must NOT fire
    // again — the arbitration window suppresses it.
    const out2 = detector.feed(ascii('ls'));
    expect(out2.filter((e) => e.source === 'heuristic_regex')).toHaveLength(0);
  });
});

// ----- E. Cursor-home detector -----

describe('hybrid-detector — cursor-home source', () => {
  it('emits prompt_start when cursor-home and erase-line occur back-to-back', () => {
    const { detector } = makeDetector({ shellIntegration: 'installed' });
    // ESC [ H followed by ESC [ K → prompt-redraw signature.
    const chunk = concat(
      new Uint8Array([0x1b, 0x5b, 0x48]), // ESC [ H
      new Uint8Array([0x1b, 0x5b, 0x4b]), // ESC [ K
    );
    const out = detector.feed(chunk);
    const event = out.find((e) => e.source === 'cursor_home');
    expect(event?.kind).toBe('prompt_start');
    expect(event?.confidence).toBe(0.5);
  });

  it('ignores standalone cursor-home without erase', () => {
    const { detector } = makeDetector();
    const out = detector.feed(new Uint8Array([0x1b, 0x5b, 0x48]));
    expect(out.filter((e) => e.source === 'cursor_home')).toHaveLength(0);
  });

  it('ignores standalone erase-line without cursor-home', () => {
    const { detector } = makeDetector();
    const out = detector.feed(new Uint8Array([0x1b, 0x5b, 0x4b]));
    expect(out.filter((e) => e.source === 'cursor_home')).toHaveLength(0);
  });
});

// ----- F. Idle detector -----

describe('hybrid-detector — idle source', () => {
  it('emits command_end on tick when idle threshold has elapsed', () => {
    const { detector, clock } = makeDetector({ idleTimeoutMs: 400 });
    detector.feed(ascii('running'));
    clock.advance(500);
    const out = detector.tick(clock.now());
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('command_end');
    expect(out[0]?.source).toBe('idle');
    expect(out[0]?.confidence).toBe(0.1);
    expect(out[0]?.exitCode).toBeNull();
  });

  it('only emits idle once per quiet window', () => {
    const { detector, clock } = makeDetector({ idleTimeoutMs: 400 });
    detector.feed(ascii('busy'));
    clock.advance(500);
    const a = detector.tick(clock.now());
    clock.advance(200);
    const b = detector.tick(clock.now());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('re-arms after new bytes arrive', () => {
    const { detector, clock } = makeDetector({ idleTimeoutMs: 400 });
    detector.feed(ascii('first'));
    clock.advance(500);
    detector.tick(clock.now());
    clock.advance(50);
    detector.feed(ascii('second'));
    clock.advance(500);
    const out = detector.tick(clock.now());
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('idle');
  });

  it('tick before threshold is a no-op', () => {
    const { detector, clock } = makeDetector({ idleTimeoutMs: 400 });
    detector.feed(ascii('x'));
    clock.advance(100);
    expect(detector.tick(clock.now())).toEqual([]);
  });
});

// ----- G. setSignals gate -----

describe('hybrid-detector — setSignals gating', () => {
  it('disabling osc133 suppresses OSC 133 events', () => {
    const { detector } = makeDetector();
    detector.setSignals({ osc133: false });
    const out = detector.feed(osc133('A'));
    expect(out).toEqual([]);
  });

  it('disabling heuristic_regex suppresses regex matches', () => {
    const { detector } = makeDetector();
    detector.setSignals({ heuristic_regex: false });
    const out = detector.feed(ascii('x\n$ '));
    expect(out.filter((e) => e.source === 'heuristic_regex')).toHaveLength(0);
  });

  it('disabling idle suppresses the tick event', () => {
    const { detector, clock } = makeDetector({ idleTimeoutMs: 400 });
    detector.setSignals({ idle: false });
    detector.feed(ascii('x'));
    clock.advance(500);
    expect(detector.tick(clock.now())).toEqual([]);
  });

  it('re-enabling a source restores emissions', () => {
    const { detector } = makeDetector();
    detector.setSignals({ osc133: false });
    expect(detector.feed(osc133('A'))).toEqual([]);
    detector.setSignals({ osc133: true });
    expect(detector.feed(osc133('B'))).toHaveLength(1);
  });

  it('unspecified sources in the patch retain their state', () => {
    const { detector } = makeDetector();
    detector.setSignals({ osc133: false });
    detector.setSignals({ heuristic_regex: false }); // should not re-enable osc133
    expect(detector.feed(osc133('A'))).toEqual([]);
  });
});

// ----- H. reset -----

describe('hybrid-detector — reset()', () => {
  it('clears arbitration memory so a previously-suppressed kind re-fires', () => {
    const { detector, clock } = makeDetector({
      idleTimeoutMs: 400,
      suppressionWindowMs: 1000,
    });
    const first = detector.feed(osc133('A'));
    expect(first).toHaveLength(1);
    clock.advance(100);
    // Within suppression window + same kind + same source → suppressed.
    const suppressed = detector.feed(osc133('A'));
    expect(suppressed).toEqual([]);
    detector.reset();
    clock.advance(50);
    const afterReset = detector.feed(osc133('A'));
    expect(afterReset).toHaveLength(1);
  });

  it('clears partial OSC parser state (no stale escape carry after reset)', () => {
    const { detector } = makeDetector();
    // Feed an incomplete OSC then reset — subsequent bytes must be treated
    // as plain text, not the tail of a half-parsed sequence.
    const partial = osc133('D', '0').slice(0, 5);
    detector.feed(partial);
    detector.reset();
    // Now feed the BEL that would have terminated the old OSC. It must not
    // produce a command_end event.
    const out = detector.feed(new Uint8Array([0x07]));
    expect(out).toEqual([]);
  });

  it('clears idle-armed flag so tick can fire again', () => {
    const { detector, clock } = makeDetector({ idleTimeoutMs: 400 });
    detector.feed(ascii('x'));
    clock.advance(500);
    detector.tick(clock.now());
    detector.reset();
    // After reset, the "now" is the reset moment. A tick 500 ms later
    // fires again.
    clock.advance(500);
    const out = detector.tick(clock.now());
    expect(out).toHaveLength(1);
  });
});

// ----- I. onEvent / onSuppressed sinks -----

describe('hybrid-detector — telemetry sinks', () => {
  it('invokes onEvent exactly for emitted events in order', () => {
    const events: BoundaryEvent[] = [];
    const { detector } = makeDetector({
      onEvent: (e) => events.push(e),
    });
    detector.feed(concat(osc133('A'), osc133('B')));
    expect(events.map((e) => e.kind)).toEqual(['prompt_start', 'command_start']);
  });

  it('invokes onSuppressed when a lower-confidence event loses arbitration', () => {
    const suppressed: BoundaryEvent[] = [];
    const { detector, clock } = makeDetector({
      suppressionWindowMs: 1000,
      onSuppressed: (e) => suppressed.push(e),
    });
    clock.set(5_000_000);
    // Fire a heuristic regex prompt_start first.
    detector.feed(ascii('x\n$ '));
    clock.advance(50);
    // Then an authoritative OSC 133 A for the same kind — upgrades.
    const out = detector.feed(osc133('A'));
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('osc133');
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.source).toBe('heuristic_regex');
  });
});

// ----- J. Integration: mode event ordering across feeds -----

describe('hybrid-detector — integration scenarios', () => {
  it('emits events in the order they are observed across multiple feeds', () => {
    const { detector, clock } = makeDetector({ suppressionWindowMs: 10 });
    const collected: BoundaryEvent[] = [];
    collected.push(...detector.feed(osc133('A')));
    clock.advance(100);
    collected.push(...detector.feed(osc133('B')));
    clock.advance(100);
    collected.push(...detector.feed(ascii('some output\n')));
    clock.advance(100);
    collected.push(...detector.feed(osc133('D', '0')));
    expect(collected.map((e) => e.kind)).toEqual([
      'prompt_start',
      'command_start',
      'command_end',
    ]);
  });

  it('idle event from prior quiet window surfaces BEFORE bytes from new burst', () => {
    const { detector, clock } = makeDetector({ idleTimeoutMs: 400 });
    detector.feed(ascii('busy'));
    clock.advance(500);
    // New burst arriving after the idle window. The idle event must come
    // first in the returned array so consumers see the command_end for
    // the prior command before the next command's events.
    const out = detector.feed(osc133('A'));
    expect(out[0]?.source).toBe('idle');
    expect(out[1]?.source).toBe('osc133');
  });
});

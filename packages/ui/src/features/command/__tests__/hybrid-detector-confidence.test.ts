/**
 * Confidence-arbitration edges for the hybrid boundary detector.
 *
 * Arbitration rules the tests assert:
 *
 *   - Two events of the same kind within `suppressionWindowMs` resolve by
 *     confidence — higher wins, lower is reported via `onSuppressed`.
 *   - Equal-confidence events: the earlier event keeps its slot; the later
 *     one is dropped (first-come-first-serve tie-break).
 *   - Events outside the window never suppress each other.
 *   - A surviving high-confidence event "retracts" a prior lower one in
 *     telemetry: both are announced (original via `onEvent`, then the
 *     authoritative one via `onEvent`, with the original via `onSuppressed`).
 *   - Cross-kind events never interact (prompt_start vs command_end are
 *     independent tracks).
 *   - Idle tier is suppressed by any higher-confidence command_end inside
 *     the window.
 */

import { describe, expect, it } from 'vitest';
import { createHybridBoundaryDetector } from '../hybrid-detector.js';
import type {
  BoundaryEvent,
  HybridBoundaryDetectorOptions,
} from '../hybrid-detector-types.js';

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

function osc133(kind: 'A' | 'B' | 'C' | 'D', payload?: string): Uint8Array {
  const body = payload ? `${kind};${payload}` : kind;
  return concat(
    new Uint8Array([0x1b, 0x5d]),
    ascii(`133;${body}`),
    new Uint8Array([0x07]),
  );
}

function makeClock(start = 1_000): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } {
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

function makeDetector(
  overrides: Partial<HybridBoundaryDetectorOptions> = {},
) {
  const clock = makeClock();
  const events: BoundaryEvent[] = [];
  const suppressed: BoundaryEvent[] = [];
  const options: HybridBoundaryDetectorOptions = {
    shellIntegration: overrides.shellIntegration ?? 'missing',
    suppressionWindowMs: overrides.suppressionWindowMs ?? 200,
    now: overrides.now ?? clock.now,
    onEvent: (e) => events.push(e),
    onSuppressed: (e) => suppressed.push(e),
    ...(overrides.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: overrides.idleTimeoutMs }
      : {}),
  };
  const detector = createHybridBoundaryDetector(options);
  return { detector, clock, events, suppressed };
}

describe('hybrid-detector — confidence arbitration', () => {
  it('OSC 133 A upgrades a prior heuristic prompt_start within window', () => {
    const { detector, clock, events, suppressed } = makeDetector({
      suppressionWindowMs: 1000,
    });
    // Heuristic fires first on a `$ ` prompt.
    detector.feed(ascii('done\n$ '));
    clock.advance(50);
    // OSC 133 A arrives 50 ms later — inside the window, higher confidence.
    detector.feed(osc133('A'));

    const emittedSources = events.map((e) => e.source);
    expect(emittedSources).toEqual(['heuristic_regex', 'osc133']);
    expect(suppressed.map((e) => e.source)).toEqual(['heuristic_regex']);
  });

  it('lower-confidence heuristic after an OSC 133 is suppressed', () => {
    const { detector, clock, events, suppressed } = makeDetector({
      suppressionWindowMs: 1000,
    });
    detector.feed(osc133('A'));
    clock.advance(30);
    detector.feed(ascii('\n$ '));
    expect(events.map((e) => e.source)).toEqual(['osc133']);
    expect(suppressed.map((e) => e.source)).toEqual(['heuristic_regex']);
  });

  it('two events outside the window both surface (no suppression)', () => {
    const { detector, clock, events } = makeDetector({
      suppressionWindowMs: 200,
    });
    detector.feed(osc133('A'));
    clock.advance(500); // well outside 200 ms window
    detector.feed(osc133('A'));
    expect(events.filter((e) => e.source === 'osc133')).toHaveLength(2);
  });

  it('equal-confidence tie: first event wins, second is suppressed', () => {
    const { detector, clock, events, suppressed } = makeDetector({
      suppressionWindowMs: 1000,
    });
    detector.feed(osc133('A'));
    clock.advance(10);
    detector.feed(osc133('A'));
    expect(events).toHaveLength(1);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]?.source).toBe('osc133');
  });

  it('cross-kind events never interact (prompt_start vs command_end)', () => {
    const { detector, clock, events } = makeDetector({
      suppressionWindowMs: 1000,
    });
    detector.feed(osc133('A'));
    clock.advance(5);
    detector.feed(osc133('D', '0'));
    expect(events.map((e) => e.kind)).toEqual([
      'prompt_start',
      'command_end',
    ]);
  });

  it('idle command_end is suppressed by a higher-confidence OSC 133 D in window', () => {
    const { detector, clock, events, suppressed } = makeDetector({
      suppressionWindowMs: 1000,
      idleTimeoutMs: 400,
    });
    // Trigger idle first.
    detector.feed(ascii('running'));
    clock.advance(500);
    detector.tick(clock.now()); // idle command_end fires
    clock.advance(50);
    // Then OSC 133 D arrives within the window.
    detector.feed(osc133('D', '0'));
    expect(events.map((e) => e.source)).toEqual(['idle', 'osc133']);
    expect(suppressed.map((e) => e.source)).toEqual(['idle']);
  });
});

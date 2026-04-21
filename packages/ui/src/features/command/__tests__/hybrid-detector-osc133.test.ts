/**
 * OSC 133 payload-parser edge cases for the hybrid boundary detector.
 *
 * The FSM in `hybrid-detector.ts` must recognise every variant of OSC 133
 * that real shells emit:
 *
 *   - ESC ] 133 ; A BEL                      (minimal prompt_start)
 *   - ESC ] 133 ; D BEL                      (command_end, exit unknown)
 *   - ESC ] 133 ; D ; 0 BEL                  (command_end, exit 0)
 *   - ESC ] 133 ; D ; 2 ; duration_ms=1234 BEL
 *   - ESC ] 133 ; D ; 0 ; cwd=/tmp BEL
 *   - ESC ] 133 ; D BEL with ESC \ ST instead of BEL
 *   - Malformed payloads (missing code, garbage markers)
 *   - Competing OSC ids (e.g. OSC 7 for cwd) must NOT produce events
 *
 * Separated from `hybrid-detector.test.ts` so the payload matrix is legible
 * at a glance.
 */

import { describe, expect, it } from 'vitest';
import { createHybridBoundaryDetector } from '../hybrid-detector.js';

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

function osc(code: string, payload: string, terminator: 'bel' | 'st'): Uint8Array {
  const body = concat(new Uint8Array([0x1b, 0x5d]), ascii(`${code};${payload}`));
  if (terminator === 'bel') return concat(body, new Uint8Array([0x07]));
  return concat(body, new Uint8Array([0x1b, 0x5c]));
}

function makeDetector() {
  return createHybridBoundaryDetector({
    shellIntegration: 'installed',
    suppressionWindowMs: 10,
    now: () => 1,
  });
}

describe('hybrid-detector — OSC 133 parser edges', () => {
  it('parses `D` with no payload as exitCode=null', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('133', 'D', 'bel'));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('command_end');
    expect(out[0]?.exitCode).toBeNull();
  });

  it('parses `D;0` positional exit code', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('133', 'D;0', 'bel'));
    expect(out[0]?.exitCode).toBe(0);
  });

  it('parses `D;137` (signal-aliased exit) correctly', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('133', 'D;137', 'bel'));
    expect(out[0]?.exitCode).toBe(137);
  });

  it('parses `D;2;duration_ms=1234`', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('133', 'D;2;duration_ms=1234', 'bel'));
    expect(out[0]?.exitCode).toBe(2);
    expect(out[0]?.durationMs).toBe(1234);
  });

  it('parses `D;0;cwd=/home/me;duration_ms=50`', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('133', 'D;0;cwd=/home/me;duration_ms=50', 'bel'));
    expect(out[0]?.exitCode).toBe(0);
    expect(out[0]?.cwd).toBe('/home/me');
    expect(out[0]?.durationMs).toBe(50);
  });

  it('honours `exit=3` keyed form when positional exit is absent', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('133', 'D;exit=3;cwd=/a', 'bel'));
    expect(out[0]?.exitCode).toBe(3);
    expect(out[0]?.cwd).toBe('/a');
  });

  it('accepts ST terminator (ESC \\) in place of BEL', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('133', 'D;9', 'st'));
    expect(out[0]?.kind).toBe('command_end');
    expect(out[0]?.exitCode).toBe(9);
  });

  it('malformed `D;notanumber` degrades to exitCode=null without throwing', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('133', 'D;notanumber', 'bel'));
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('command_end');
    expect(out[0]?.exitCode).toBeNull();
  });

  it('ignores non-133 OSC (e.g. OSC 7 cwd) — no boundary emitted', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('7', 'file:///tmp/foo', 'bel'));
    expect(out).toEqual([]);
  });

  it('ignores OSC 133 with an unknown first letter (e.g. `Z`)', () => {
    const detector = makeDetector();
    const out = detector.feed(osc('133', 'Z', 'bel'));
    expect(out).toEqual([]);
  });

  it('survives OSC 133 D immediately adjacent to OSC 7 cwd update', () => {
    const detector = makeDetector();
    const chunk = concat(
      osc('7', 'file:///tmp', 'bel'),
      osc('133', 'D;0', 'bel'),
    );
    const out = detector.feed(chunk);
    expect(out).toHaveLength(1);
    expect(out[0]?.source).toBe('osc133');
  });

  it('runaway OSC payload (no terminator) aborts without emitting', () => {
    const detector = makeDetector();
    // 5000 bytes of OSC payload with no BEL/ST — parser should self-cap.
    const garbage = new Uint8Array(5000);
    for (let i = 0; i < garbage.length; i += 1) garbage[i] = 0x41; // 'A'
    const chunk = concat(
      new Uint8Array([0x1b, 0x5d]),
      ascii('133;D;'),
      garbage,
    );
    const out = detector.feed(chunk);
    expect(out).toEqual([]);
    // Recovery: a fresh valid OSC after the runaway must still work.
    const recovered = detector.feed(osc('133', 'A', 'bel'));
    expect(recovered).toHaveLength(1);
  });
});

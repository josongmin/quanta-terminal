/**
 * Tab stops — HT (0x09), HTS (ESC H), TBC (`CSI g`), CHT (`CSI I`),
 * CBT (`CSI Z`).
 *
 * CURRENT STATE (2026-04-21): the emulator implements ONLY fixed-every-8
 * tab stops. `executeTab()` jumps to `(floor(col / 8) + 1) * 8`, clamped
 * to the last column. The following are NOT implemented:
 *   - HTS (ESC H) — set tab stop at current column.
 *   - `CSI g` / `CSI 0 g` — clear tab at cursor.
 *   - `CSI 3 g` — clear all tabs.
 *   - `CSI I` (CHT — Cursor Horizontal Tabulation) — tab forward N times.
 *   - `CSI Z` (CBT — Cursor Backward Tabulation) — tab backward N times.
 *
 * TODO (plan 0005 P1): add a `tabStops: Set<number>` on VtEmulator,
 * seeded with {8, 16, 24, ...} at construction and on resize. Wire HTS /
 * TBC / CHT / CBT. The hot-path `executeTab` becomes `find smallest
 * stop > col`.
 *
 * These tests lock the current every-8 behaviour plus the passthrough /
 * no-crash contract for the four unimplemented sequences.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../VtEmulator.js';
import type {
  GridEventEnvelope,
  GridPayload,
} from '../../grid-mirror/types.js';

type Env = GridEventEnvelope<GridPayload>;

class Harness {
  readonly envs: Env[] = [];
  readonly emulator: VtEmulator;

  constructor(rows = 4, cols = 32) {
    this.emulator = new VtEmulator({
      sessionId: 'tabs-test',
      rows,
      cols,
      onEnvelope: (env) => this.envs.push(env),
    });
  }

  feed(s: string | Uint8Array): void {
    const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : s;
    this.emulator.feed(bytes);
  }
}

describe('tab-stops — HT (0x09) default every-8 behaviour', () => {
  it('HT from col 0 jumps to col 8', () => {
    // Invariant: default tab stops are every 8 columns. From col 0 the
    // next stop is at col 8.
    const h = new Harness(3, 32);
    h.feed('\t');
    expect(h.emulator._getCursor().col).toBe(8);
  });

  it('HT from col 3 jumps to col 8 (next multiple)', () => {
    // Invariant: tab advances to the NEXT multiple of 8, not +8 from
    // current column.
    const h = new Harness(3, 32);
    h.feed('abc\t'); // after 'abc', col=3, then HT.
    expect(h.emulator._getCursor().col).toBe(8);
  });

  it('HT from col 8 jumps to col 16', () => {
    // Invariant: already-aligned cursor still advances to the NEXT stop.
    const h = new Harness(3, 32);
    h.feed('\x1b[1;9H'); // col 8 (0-indexed)
    h.feed('\t');
    expect(h.emulator._getCursor().col).toBe(16);
  });

  it('HT clamps to the last column on narrow grids', () => {
    // Invariant: a tab past the last column clamps to `cols - 1` (no wrap,
    // no advance to the next row).
    const h = new Harness(3, 6);
    h.feed('\x1b[1;5H'); // col 4
    h.feed('\t');
    expect(h.emulator._getCursor().col).toBe(5); // clamped to cols-1 = 5
    expect(h.emulator._getCursor().row).toBe(0);
  });
});

describe('tab-stops — unimplemented sequences are passthrough', () => {
  it('HTS (ESC H) is silently dropped — does not alter default stops', () => {
    // Invariant (current): HTS is not dispatched from `stepEscape`. After
    // emitting HTS at col 5, a later HT from col 0 still jumps to col 8
    // (the default every-8 stop), not col 5.
    // TODO-P1: implement HTS + tabStops set; assert HT lands at col 5.
    const h = new Harness(3, 32);
    h.feed('\x1b[1;6H'); // col 5
    h.feed('\x1bH'); // HTS — no-op today
    h.feed('\x1b[1;1H'); // back to col 0
    h.feed('\t');
    expect(h.emulator._getCursor().col).toBe(8);
  });

  it('CSI 3 g (clear all tabs) is silently dropped — default stops persist', () => {
    // Invariant (current): `CSI 3 g` is not dispatched. HT still works.
    // TODO-P1: implement TBC — after `CSI 3 g`, HT should clamp to cols-1.
    const h = new Harness(3, 32);
    h.feed('\x1b[3g'); // clear all tabs — no-op today
    h.feed('\t');
    expect(h.emulator._getCursor().col).toBe(8);
  });

  it('CSI I (CHT — forward tab) is silently dropped — cursor does not move', () => {
    // Invariant (current): CHT final `I` is not dispatched. Cursor stays
    // put. Apps that emit `CSI 3 I` expect 3 tabs forward; today they get
    // zero.
    // TODO-P1: implement CHT.
    const h = new Harness(3, 32);
    h.feed('\x1b[3I');
    expect(h.emulator._getCursor().col).toBe(0);
  });

  it('CSI Z (CBT — backward tab) is silently dropped — cursor does not move', () => {
    // Invariant (current): CBT final `Z` is not dispatched.
    // TODO-P1: implement CBT.
    const h = new Harness(3, 32);
    h.feed('\x1b[1;17H'); // col 16
    h.feed('\x1b[2Z'); // 2 backward tabs — no-op today
    expect(h.emulator._getCursor().col).toBe(16);
  });

  it('CSI 0 g (clear tab at cursor) is silently dropped', () => {
    // Invariant: `CSI g` with default param 0 clears the stop at the
    // current cursor column. Not implemented — the sequence is dispatched
    // (final `g`) but our switch has no `case 'g'`, so it lands in the
    // default branch and is dropped.
    // TODO-P1: implement TBC mode 0.
    const h = new Harness(3, 32);
    h.feed('\x1b[1;9H'); // col 8 (sits on a default stop)
    h.feed('\x1b[0g'); // clear stop here — no-op today
    h.feed('\x1b[1;1H');
    h.feed('\t');
    // HT still lands at col 8 because the default stop was never cleared.
    expect(h.emulator._getCursor().col).toBe(8);
  });
});

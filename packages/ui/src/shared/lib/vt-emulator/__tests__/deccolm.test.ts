/**
 * DECCOLM (80/132 columns) — `CSI ? 3 h` sets 132 cols, `CSI ? 3 l` sets
 * 80 cols. On real xterm, DECCOLM:
 *   - Resizes the grid to the new column count.
 *   - Clears the screen.
 *   - Homes the cursor.
 *   - Resets the scroll region to full-screen.
 *
 * CURRENT STATE (2026-04-21): the emulator does NOT implement DECCOLM.
 * `executeDecSet` has no `case 3` — the sequence is silently dropped. Many
 * TUIs (notably mc, older vim, some man-page viewers) issue it to force
 * wide mode.
 *
 * TODO (plan 0005 P1): implement DECCOLM as a hard resize + clear. We
 * don't currently expose "resize from the emulator" — the host drives
 * resizes via `resize()` in response to SIGWINCH. Adding emulator-driven
 * resizes requires:
 *   1. A resize callback in `VtEmulatorOptions` (e.g. `onResizeRequest`).
 *   2. The emulator then clearing the grid + homing the cursor to match
 *      xterm's DECCOLM behaviour.
 *
 * For now these tests lock the current behaviour: `CSI ? 3 h` and
 * `CSI ? 3 l` are no-ops that leave the grid state untouched, and a
 * misuse doesn't corrupt the FSM.
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

  constructor(rows = 6, cols = 10) {
    this.emulator = new VtEmulator({
      sessionId: 'deccolm-test',
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

describe('deccolm — current-behaviour passthrough', () => {
  it('CSI ? 3 h (set 132 cols) is a no-op — dimensions unchanged', () => {
    // Invariant (current): DECCOLM is not implemented. The grid keeps its
    // constructed dimensions.
    const h = new Harness(5, 10);
    h.feed('\x1b[?3h');
    expect(h.emulator.getDimensions()).toEqual({ rows: 5, cols: 10 });
  });

  it('CSI ? 3 l (set 80 cols) is a no-op — dimensions unchanged', () => {
    // Invariant (current): DECRESET 3 is not implemented.
    const h = new Harness(5, 132);
    h.feed('\x1b[?3l');
    expect(h.emulator.getDimensions()).toEqual({ rows: 5, cols: 132 });
  });

  it('CSI ? 3 h does not clear the screen or move the cursor (current behaviour)', () => {
    // Invariant (current): spec-compliant DECCOLM clears + homes. We do
    // neither. This test captures the current behaviour so an accidental
    // partial implementation (e.g. "just clear the grid") doesn't slip
    // through.
    // TODO-P1: when DECCOLM lands, replace this with the positive clear+home
    // assertion.
    const h = new Harness(4, 10);
    h.feed('Hi');
    h.feed('\x1b[?3h');
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('H');
    expect(h.emulator._getCell(0, 1)?.grapheme).toBe('i');
    expect(h.emulator._getCursor().col).toBe(2);
  });
});

/**
 * Insert mode (IRM) — `CSI 4 h` enters insert mode, `CSI 4 l` returns to
 * replace mode. In insert mode, each printable character inserts at the
 * cursor position and pushes the rest of the line one cell to the right
 * (the rightmost cell falls off).
 *
 * CURRENT STATE (2026-04-21): the emulator does NOT implement IRM.
 * `dispatchCsi` routes `h` / `l` finals WITHOUT a private byte (`priv`
 * empty) to the `default` case — i.e. silently dropped. This matches the
 * spec-compliance suite's existing "IRM gap" assertion in
 * vt-spec-compliance.test.ts.
 *
 * TODO (plan 0005 P1): implement IRM. The work is small:
 *   1. A boolean `insertMode` flag (default false).
 *   2. SM / RM dispatcher for non-private `h`/`l` with param 4.
 *   3. In `printGrapheme`, when `insertMode === true`, shift cells
 *      `[col..cols-1]` right by `width` before writing.
 *
 * Current tests lock the passthrough contract:
 *   - `CSI 4 h` / `CSI 4 l` do not crash, do not advance the cursor, do
 *     not alter grid cells.
 *   - Subsequent prints still use REPLACE semantics (overwrite), NOT
 *     insert — this is the failure mode TUIs in insert-heavy paths will
 *     hit (readline re-edit, nano/mcedit mid-line insertions).
 *
 * Related: `CSI @` (ICH — insert N blanks at cursor) IS implemented via
 * `executeIch`. Apps that need insert semantics can emit `CSI @` instead
 * of `CSI 4 h` + print — most modern shells / editors do. The IRM gap
 * only affects apps that stay in insert mode across multiple prints.
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

  constructor(rows = 4, cols = 10) {
    this.emulator = new VtEmulator({
      sessionId: 'irm-test',
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

describe('insert-mode — passthrough (IRM gap)', () => {
  it('CSI 4 h is silently dropped — does not shift cells on later prints', () => {
    // Invariant (current): IRM-enter is a no-op. Subsequent prints continue
    // to overwrite, not insert.
    const h = new Harness(3, 10);
    h.feed('ABCDE');
    h.feed('\x1b[1;3H'); // cursor to (0, 2)
    h.feed('\x1b[4h'); // IRM on — no-op today
    h.feed('Z');
    // REPLACE semantics: 'Z' overwrites 'C', leaves 'D' and 'E' intact.
    expect(h.emulator._getCell(0, 2)?.grapheme).toBe('Z');
    expect(h.emulator._getCell(0, 3)?.grapheme).toBe('D');
    expect(h.emulator._getCell(0, 4)?.grapheme).toBe('E');
    // FIXME-P1: with IRM implemented, the expected row would be 'ABZCDE' (E
    // survives, nothing falls off on a 10-col grid), and (0, 5) would be 'E'.
  });

  it('CSI 4 l (replace mode) is silently dropped — already the default', () => {
    // Invariant: toggling back to replace mode has no observable effect
    // because insert mode is never engaged.
    const h = new Harness(3, 10);
    h.feed('\x1b[4l');
    h.feed('Hello');
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('H');
    expect(h.emulator._getCell(0, 4)?.grapheme).toBe('o');
  });

  it('CSI 4 h followed by CSI 4 l — FSM returns to Ground cleanly', () => {
    // Invariant: a full enter/exit cycle leaves the emulator in Ground with
    // no lingering param state, so the next CSI dispatches normally.
    const h = new Harness(3, 10);
    h.feed('\x1b[4h\x1b[4l');
    h.feed('\x1b[1;2H'); // CUP (1, 2) — 0-indexed (0, 1)
    h.feed('X');
    expect(h.emulator._getCell(0, 1)?.grapheme).toBe('X');
  });

  it('multiple IRM toggles + writes do not corrupt grid state', () => {
    // Invariant: even under noisy toggling, grid writes behave as plain
    // replace. This guards against accidental half-implementation that
    // might leak state across toggles.
    const h = new Harness(3, 10);
    h.feed('ABC');
    h.feed('\x1b[1;1H');
    h.feed('\x1b[4h');
    h.feed('X');
    h.feed('\x1b[4l');
    h.feed('Y');
    // X replaced A at col 0; Y replaced B at col 1.
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('X');
    expect(h.emulator._getCell(0, 1)?.grapheme).toBe('Y');
    expect(h.emulator._getCell(0, 2)?.grapheme).toBe('C');
  });

  it('CSI @ (ICH) works as the positive path for insertion (sanity)', () => {
    // Invariant: `CSI N @` inserts N blanks at the cursor, shifting cells
    // right. This IS implemented (`executeIch`) — verify that apps relying
    // on this instead of IRM still work. Locks the contract that P1 IRM
    // work doesn't accidentally break ICH.
    const h = new Harness(3, 10);
    h.feed('ABCDE');
    h.feed('\x1b[1;3H'); // (0, 2)
    h.feed('\x1b[2@'); // insert 2 blanks at col 2
    // 'C' 'D' 'E' shift right by 2 → blanks at (0, 2), (0, 3).
    expect(h.emulator._getCell(0, 2)?.grapheme).toBe('');
    expect(h.emulator._getCell(0, 3)?.grapheme).toBe('');
    expect(h.emulator._getCell(0, 4)?.grapheme).toBe('C');
    expect(h.emulator._getCell(0, 5)?.grapheme).toBe('D');
    expect(h.emulator._getCell(0, 6)?.grapheme).toBe('E');
  });
});

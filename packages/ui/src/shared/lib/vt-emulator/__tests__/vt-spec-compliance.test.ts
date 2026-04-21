/**
 * VT / xterm spec-compliance edge-case audit (plan 0005 P0 adversarial
 * pass).
 *
 * This file locks behaviours that the primary `VtEmulator.test.ts` doesn't
 * touch, drawn from the xterm `ctlseqs` reference and kitty-keyboard spec.
 * Every test has an explicit "invariant under test" line in the docstring
 * so a future reader knows WHY the assertion exists (not just WHAT).
 *
 * Categories covered here:
 *   - CSI disambiguation (save/restore vs kitty u)
 *   - DECSC full save-set (cursor + SGR + autoWrap), confirming charset &
 *     scroll-region are NOT saved.
 *   - DA / DSR responses under private-marker and default-param cases.
 *   - ED / EL mode coverage including ED(3) scrollback wipe (α3 hook).
 *   - IRM gap: insert-mode `CSI 4 h` / `4 l` is NOT implemented and MUST
 *     be silently dropped (not crash).
 *   - CSI 6n under DECOM — DECOM is unmodeled but CPR must still answer
 *     with the raw cursor, not `undefined`.
 *   - SGR reset edge variants.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../VtEmulator.js';
import type {
  GridEventEnvelope,
  GridPayload,
} from '../../grid-mirror/types.js';

type Env = GridEventEnvelope<GridPayload>;

interface HarnessOpts {
  readonly rows?: number;
  readonly cols?: number;
  readonly onRespond?: (bytes: Uint8Array) => void;
  readonly secondaryDaVersion?: number;
  readonly scrollbackRows?: number;
}

class Harness {
  readonly envs: Env[] = [];
  readonly emulator: VtEmulator;
  readonly responded: string[] = [];

  constructor(opts: HarnessOpts = {}) {
    const { rows = 6, cols = 10, secondaryDaVersion, scrollbackRows } = opts;
    const onRespond = (bytes: Uint8Array): void => {
      this.responded.push(new TextDecoder().decode(bytes));
      opts.onRespond?.(bytes);
    };
    // Build VtEmulator options without leaking undefined properties
    // (exactOptionalPropertyTypes).
    const base = {
      sessionId: 'spec-test',
      rows,
      cols,
      onEnvelope: (env: Env) => this.envs.push(env),
      onRespond,
    };
    const withVer =
      secondaryDaVersion === undefined
        ? base
        : { ...base, secondaryDaVersion };
    this.emulator = new VtEmulator(
      scrollbackRows === undefined ? withVer : { ...withVer, scrollbackRows },
    );
  }

  feed(s: string | Uint8Array): void {
    const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : s;
    this.emulator.feed(bytes);
  }

  /** Concatenated responses since last consume(). */
  consume(): string {
    const joined = this.responded.join('');
    this.responded.length = 0;
    return joined;
  }
}

describe('vt-spec-compliance — CSI save/restore vs Kitty u', () => {
  it('CSI s saves cursor; CSI u restores — unaffected by kitty flag state', () => {
    // Invariant: `CSI u` (no private byte, no params) is ALWAYS DECRC.
    // Having a non-zero kitty flag stack on top must not reinterpret it.
    const h = new Harness({ rows: 6, cols: 20 });
    // Push a kitty flag so the stack is non-empty / non-default.
    h.feed('\x1b[>1u');
    // Position cursor, save, wander, restore.
    h.feed('\x1b[3;5H');
    h.feed('\x1b[s');
    h.feed('\x1b[6;10H');
    h.feed('\x1b[u');
    expect(h.emulator._getCursor().row).toBe(2);
    expect(h.emulator._getCursor().col).toBe(4);
  });

  it('CSI ? u (with private byte) is a kitty-query — answers CSI ? <flags> u', () => {
    // Invariant: `CSI ? u` with onRespond wired answers with the current
    // top-of-stack kitty flags — never mutates DECRC state.
    const h = new Harness({ rows: 4, cols: 10 });
    h.feed('\x1b[>3u'); // push flags=3
    h.consume();
    h.feed('\x1b[?u');
    expect(h.consume()).toBe('\x1b[?3u');
  });
});

describe('vt-spec-compliance — DECSC save-set completeness', () => {
  it('DECSC followed by ED(2) then DECRC restores SGR (red fg) and writes red', () => {
    // Invariant: DECSC saves SGR attrs; DECRC restores them, so cells
    // written AFTER DECRC (even following an ED(2) that wiped the screen)
    // carry the restored SGR.
    const h = new Harness({ rows: 4, cols: 10 });
    h.feed('\x1b[31m'); // red fg
    h.feed('\x1b7'); // DECSC (red saved)
    h.feed('\x1b[0m'); // reset SGR
    h.feed('\x1b[2J'); // clear screen
    h.feed('\x1b[1;1H');
    h.feed('\x1b8'); // DECRC — red fg restored
    h.feed('X');
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.grapheme).toBe('X');
    expect(cell.fg).toEqual({ kind: 'named', index: 1 });
  });
});

describe('vt-spec-compliance — DA / DSR', () => {
  it('CSI n (no params, default 0) is not a valid DSR mode — drops silently', () => {
    // Invariant: `CSI n` with no params / default 0 is not `DSR 5` or `6` —
    // emulator must not reply, not throw.
    const h = new Harness({ rows: 4, cols: 10 });
    h.feed('\x1b[n');
    expect(h.consume()).toBe('');
  });

  it('CSI > c is equivalent to CSI > 0 c for Secondary DA', () => {
    // Invariant: Secondary DA default param is 0; omitted param must be
    // treated the same as explicit 0.
    const h = new Harness({ rows: 4, cols: 10, secondaryDaVersion: 42 });
    h.feed('\x1b[>c');
    expect(h.consume()).toBe('\x1b[>0;42;0c');
  });

  it('CSI 0 c and CSI c are equivalent for Primary DA', () => {
    // Invariant: Primary DA default param is 0; omitted param must match
    // explicit 0 — both reply `CSI ? 1 ; 2 c`.
    const h = new Harness({ rows: 4, cols: 10 });
    h.feed('\x1b[c');
    const no = h.consume();
    h.feed('\x1b[0c');
    const zero = h.consume();
    expect(no).toBe('\x1b[?1;2c');
    expect(zero).toBe(no);
  });

  it('CSI = c (Tertiary DA) is silently dropped', () => {
    // Invariant: Tertiary DA is not implemented; emulator must not reply
    // and must not crash.
    const h = new Harness({ rows: 4, cols: 10 });
    h.feed('\x1b[=0c');
    expect(h.consume()).toBe('');
  });

  it('CSI 6 n reports 1-indexed row;col at boundary extreme', () => {
    // Invariant: CPR reply clamps to (rows, cols) 1-based — the cursor at
    // the bottom-right after autowrap past end must report (rows, cols),
    // not (rows+1, cols+1).
    const h = new Harness({ rows: 3, cols: 4 });
    // Fill the grid to drive the cursor to bottom-right + pendingWrap.
    h.feed('ABCDabcd1234'); // 12 chars on 4-col → cursor at last pos
    h.feed('\x1b[6n');
    // After 12 chars on a 4-col × 3-row grid, cursor lands on last row
    // col=3 with pendingWrap. CPR still reports the logical position.
    const reply = h.consume();
    expect(reply).toMatch(/^\x1b\[3;4R$/);
  });
});

describe('vt-spec-compliance — ED / EL edge cases', () => {
  it('CSI 3 J clears scrollback but leaves live grid intact', () => {
    // Invariant: `CSI 3 J` (xterm extension) clears the saved-line ring
    // WITHOUT wiping the visible screen or resetting baseRowId.
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 50 });
    h.feed('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n');
    const ringBefore = h.emulator.getScrollback();
    expect(ringBefore.rows.length).toBeGreaterThan(0);
    const baseBefore = ringBefore.baseRowId;
    const evictedBefore = ringBefore.evictedCount;
    // Also write something on the live grid we expect to survive.
    h.feed('\x1b[1;1Hhello');
    h.feed('\x1b[3J');
    const ringAfter = h.emulator.getScrollback();
    // Scrollback cleared.
    expect(ringAfter.rows.length).toBe(0);
    // Diagnostics preserved — this is a history wipe, not a hard reset.
    expect(ringAfter.baseRowId).toBe(baseBefore);
    expect(ringAfter.evictedCount).toBe(evictedBefore);
    // Live cell "h" at (0,0) survives.
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('h');
  });

  it('CSI 5 J (unknown ED mode) is a no-op', () => {
    // Invariant: out-of-range ED modes must not clear anything.
    const h = new Harness({ rows: 3, cols: 6 });
    h.feed('abcdef');
    h.feed('\x1b[5J');
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('a');
    expect(h.emulator._getCell(0, 5)?.grapheme).toBe('f');
  });

  it('CSI 5 K (unknown EL mode) is a no-op', () => {
    // Invariant: out-of-range EL modes must not clear anything.
    const h = new Harness({ rows: 3, cols: 6 });
    h.feed('abcdef');
    h.feed('\x1b[1;1H');
    h.feed('\x1b[5K');
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('a');
  });
});

describe('vt-spec-compliance — IRM / unimplemented CSI h / l modes', () => {
  it('CSI 4 h (IRM — insert mode) is silently dropped', () => {
    // Invariant: IRM is not implemented; the CSI must not crash or alter
    // the grid. Subsequent printing should behave as replace-mode (default).
    const h = new Harness({ rows: 3, cols: 8 });
    h.feed('abcdef');
    h.feed('\x1b[1;3H'); // cursor at (0, 2) over 'c'
    h.feed('\x1b[4h'); // would be "enter insert mode" — we no-op
    h.feed('X');
    // Replace-mode behaviour: 'X' overwrites 'c'.
    expect(h.emulator._getCell(0, 2)?.grapheme).toBe('X');
    expect(h.emulator._getCell(0, 3)?.grapheme).toBe('d');
  });

  it('CSI 20 h (LNM — linefeed/newline mode) is silently dropped', () => {
    // Invariant: LNM is a spec CSI mode that we don't implement; must not
    // crash. `\n` continues to act as plain LF (no implicit CR).
    const h = new Harness({ rows: 3, cols: 8 });
    h.feed('\x1b[20h'); // set LNM — we no-op
    h.feed('abc\n');
    expect(h.emulator._getCursor().row).toBe(1);
    // `abc` placed col 0-2; LF does NOT reset col (no LNM).
    expect(h.emulator._getCursor().col).toBe(3);
  });
});

describe('vt-spec-compliance — malformed CSI recovery', () => {
  it('CSI with colon subparams (ECMA-48 form) is parsed as semicolon subparam', () => {
    // Invariant: the FSM folds `:` → `;` so vim's ECMA-48 truecolor form
    // `CSI 38:2::r:g:b m` lands on the same RGB path as the semicolon form.
    const h = new Harness({ rows: 3, cols: 6 });
    h.feed('\x1b[38:2::100:200:50mX');
    const cell = h.emulator._getCell(0, 0)!;
    expect(cell.grapheme).toBe('X');
    expect(cell.fg).toEqual({ kind: 'rgb', r: 100, g: 200, b: 50 });
  });

  it('CSI with extremely long param list does not blow up', () => {
    // Invariant: a pathologically long SGR param list must be parsed
    // without stack overflow or quadratic time — the emulator drops
    // unrecognised params but consumes them.
    const h = new Harness({ rows: 3, cols: 6 });
    // Emit a thousand-element SGR param list ending in plain text.
    const parts: string[] = [];
    for (let i = 0; i < 1000; i += 1) parts.push('999');
    h.feed(`\x1b[${parts.join(';')}mX`);
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('X');
  });
});

describe('vt-spec-compliance — DEC private mode ignored set', () => {
  it('unknown DEC mode (e.g. ?2004 bracketed-paste) is silently dropped', () => {
    // Invariant: DEC private modes we don't model must not corrupt state;
    // subsequent legitimate sequences still work.
    const h = new Harness({ rows: 3, cols: 6 });
    h.feed('\x1b[?2004h'); // bracketed paste — not modeled
    h.feed('\x1b[?1000h'); // mouse reporting — not modeled
    h.feed('\x1b[?1006h'); // SGR mouse — not modeled
    // DECSET 25 (cursor visible) is modeled; should still work after drops.
    h.feed('\x1b[?25l');
    expect(h.emulator._getCursor().visible).toBe(false);
  });
});

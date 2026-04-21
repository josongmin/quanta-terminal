/**
 * Alt-buffer / main-buffer swap tests for `VtEmulator` (plan 0005 Epic α
 * work item α2).
 *
 * Scope — the emulator now owns the alt/main flip triggered by DEC private
 * modes 47 / 1047 / 1048 / 1049. These tests lock the xterm contract:
 *
 *   - 47   — swap only; no cursor save, no clear on entry.
 *   - 1047 — swap + clear alt on entry; xterm quirk: DECRESET clears alt
 *            too so re-entry is guaranteed blank.
 *   - 1048 — cursor / SGR / autoWrap save/restore (distinct slot from
 *            DECSC so the two don't stomp each other).
 *   - 1049 — the combined sequence vim / htop / less use: save cursor,
 *            swap, clear alt on entry; restore on exit.
 *
 * Event-order contract: `mode_changed { alt_screen: true/false }` MUST be
 * emitted before any `grid_delta` / `cursor_moved` envelope sourced from
 * the new buffer — downstream consumers route deltas based on the
 * currently-announced buffer.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../VtEmulator.js';
import type {
  GridEventEnvelope,
  GridPayload,
  ModeChangedPayload,
} from '../../grid-mirror/types.js';

type Env = GridEventEnvelope<GridPayload>;

class Harness {
  readonly envs: Env[] = [];
  readonly emulator: VtEmulator;

  constructor(rows = 6, cols = 10) {
    this.emulator = new VtEmulator({
      sessionId: 'alt-test',
      rows,
      cols,
      onEnvelope: (env) => this.envs.push(env),
    });
  }

  feed(s: string | Uint8Array): void {
    const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : s;
    this.emulator.feed(bytes);
  }

  clearEnvs(): void {
    this.envs.length = 0;
  }

  cellGrapheme(row: number, col: number): string {
    return this.emulator._getCell(row, col)?.grapheme ?? '';
  }

  rowText(row: number): string {
    const { cols } = this.emulator.getDimensions();
    let out = '';
    for (let c = 0; c < cols; c += 1) {
      const cell = this.emulator._getCell(row, c);
      if (!cell) {
        out += ' ';
        continue;
      }
      if (cell.width === 0) continue;
      out += cell.grapheme === '' ? ' ' : cell.grapheme;
    }
    return out;
  }
}

describe('VtEmulator — alt-buffer swap', () => {
  it('DECSET 1049 → write → DECRESET 1049 restores main byte-exact', () => {
    const h = new Harness(3, 10);
    h.feed('hello');
    // Cursor should be just past "hello".
    const cursorBefore = { ...h.emulator._getCursor() };
    h.feed('\x1b[?1049h');
    // Alt buffer is blank.
    expect(h.cellGrapheme(0, 0)).toBe('');
    h.feed('\x1b[1;1Hworld');
    expect(h.cellGrapheme(0, 0)).toBe('w');
    h.feed('\x1b[?1049l');
    // Main restored byte-exact.
    expect(h.rowText(0).trimEnd()).toBe('hello');
    // Cursor restored to where it was before entering alt.
    const cursorAfter = h.emulator._getCursor();
    expect(cursorAfter.row).toBe(cursorBefore.row);
    expect(cursorAfter.col).toBe(cursorBefore.col);
  });

  it('DECSET 1047 clears alt on entry (even across re-entries)', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[?1047h');
    // Entry: alt is blank.
    expect(h.cellGrapheme(0, 0)).toBe('');
    h.feed('foo');
    expect(h.cellGrapheme(0, 0)).toBe('f');
    h.feed('\x1b[?1047l');
    // Re-enter — per xterm, 1047l also wipes alt so this is blank again.
    h.feed('\x1b[?1047h');
    expect(h.cellGrapheme(0, 0)).toBe('');
    expect(h.cellGrapheme(0, 1)).toBe('');
    expect(h.cellGrapheme(0, 2)).toBe('');
  });

  it('DECSET 47 does NOT clear alt on entry or exit', () => {
    const h = new Harness(3, 5);
    h.feed('\x1b[?47h');
    h.feed('foo');
    expect(h.cellGrapheme(0, 0)).toBe('f');
    h.feed('\x1b[?47l');
    // Re-enter — legacy 47 preserves alt contents.
    h.feed('\x1b[?47h');
    expect(h.cellGrapheme(0, 0)).toBe('f');
    expect(h.cellGrapheme(0, 1)).toBe('o');
    expect(h.cellGrapheme(0, 2)).toBe('o');
  });

  it('DECSET 1048 saves cursor; DECRESET 1048 restores', () => {
    const h = new Harness(10, 20);
    // Position cursor at (row=3, col=5) (0-indexed internally; CUP is 1-indexed).
    h.feed('\x1b[4;6H');
    expect(h.emulator._getCursor().row).toBe(3);
    expect(h.emulator._getCursor().col).toBe(5);
    h.feed('\x1b[?1048h');
    // Move cursor around on main (1048 does NOT switch buffers).
    h.feed('\x1b[11;11H');
    expect(h.emulator._getCursor().row).toBe(9); // clamped to rows-1
    expect(h.emulator._getCursor().col).toBe(10);
    h.feed('\x1b[?1048l');
    expect(h.emulator._getCursor().row).toBe(3);
    expect(h.emulator._getCursor().col).toBe(5);
  });

  it('DECSET 1049 restores cursor on exit even after alt movement', () => {
    const h = new Harness(10, 20);
    h.feed('\x1b[5;8H'); // cursor at (4, 7)
    h.feed('\x1b[?1049h');
    // Scribble on alt; cursor wanders.
    h.feed('\x1b[1;1Hhi there');
    expect(h.emulator._getCursor().row).toBe(0);
    h.feed('\x1b[?1049l');
    expect(h.emulator._getCursor().row).toBe(4);
    expect(h.emulator._getCursor().col).toBe(7);
  });

  it('mode_changed event precedes grid deltas from the new buffer', () => {
    const h = new Harness(5, 10);
    // Prime with main content, then clear the envelope log.
    h.feed('hello');
    h.clearEnvs();
    // DECSET 1049 + a classic vim-style paint on alt.
    h.feed('\x1b[?1049h\x1b[1;1H~ \x1b[2;1H~ ');
    // First event after the setup must be mode_changed { alt_screen: true },
    // followed by grid deltas / cursor moves belonging to alt.
    const first = h.envs[0];
    expect(first).toBeDefined();
    expect(first!.payload.kind).toBe('mode_changed');
    const payload = first!.payload as ModeChangedPayload;
    expect(payload.changes).toContainEqual({ mode: 'alt_screen', value: true });
    expect(payload.state.alt_screen).toBe(true);
    // Envelope is tagged as belonging to the alt buffer.
    expect(first!.buffer_kind).toBe('alt');
    // Subsequent envelopes (after the mode flip) must also be tagged alt.
    for (let i = 1; i < h.envs.length; i += 1) {
      expect(h.envs[i]!.buffer_kind).toBe('alt');
    }
  });

  it('mode_changed { alt_screen: false } precedes main deltas on exit', () => {
    const h = new Harness(5, 10);
    h.feed('original');
    h.feed('\x1b[?1049h');
    h.feed('alt-content');
    h.clearEnvs();
    h.feed('\x1b[?1049l');
    const first = h.envs[0];
    expect(first).toBeDefined();
    expect(first!.payload.kind).toBe('mode_changed');
    const payload = first!.payload as ModeChangedPayload;
    expect(payload.changes).toContainEqual({ mode: 'alt_screen', value: false });
    expect(payload.state.alt_screen).toBe(false);
    expect(first!.buffer_kind).toBe('main');
  });

  it('main buffer preserves multi-row content across 1049 entry/exit', () => {
    const h = new Harness(12, 10);
    const lines = [
      'row-zero',
      'row-one',
      'row-two',
      'row-three',
      'row-four',
      'row-five',
      'row-six',
      'row-seven',
      'row-eight',
      'row-nine',
    ];
    // Write 10 different rows to main via CUP + text.
    for (let r = 0; r < lines.length; r += 1) {
      h.feed(`\x1b[${r + 1};1H${lines[r]}`);
    }
    h.feed('\x1b[?1049h');
    // 10 different rows on alt.
    for (let r = 0; r < 10; r += 1) {
      h.feed(`\x1b[${r + 1};1HALT-${r}`);
    }
    h.feed('\x1b[?1049l');
    for (let r = 0; r < lines.length; r += 1) {
      expect(h.rowText(r).trimEnd()).toBe(lines[r]);
    }
  });

  it('SGR state is saved and restored with 1049', () => {
    const h = new Harness(5, 10);
    // Red bold fg on main, then enter 1049 which should save + switch +
    // clear. Reset SGR and write plain text on alt. Exit 1049 — subsequent
    // main writes should still be red bold.
    h.feed('\x1b[31;1m'); // SGR red-fg + bold
    h.feed('\x1b[?1049h');
    h.feed('\x1b[0m'); // reset SGR on alt
    h.feed('plain');
    h.feed('\x1b[?1049l');
    // Write a single char on main; verify its SGR state.
    h.feed('X');
    // Find where the cursor landed — the 1049-restored cursor is at home
    // (0,0) on our test fixture since no pre-alt cursor position was set.
    // Walk the first row until we find our 'X'.
    let found = false;
    for (let c = 0; c < 10; c += 1) {
      const cell = h.emulator._getCell(0, c);
      if (cell?.grapheme === 'X') {
        expect(cell.bold).toBe(true);
        expect(cell.fg).toEqual({ kind: 'named', index: 1 });
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it('resize on alt buffer clears alt', () => {
    const h = new Harness(5, 10);
    h.feed('\x1b[?1049h');
    h.feed('\x1b[1;1Hkeep me');
    expect(h.cellGrapheme(0, 0)).toBe('k');
    h.emulator.resize(5, 20);
    // Alt has been cleared; every cell is blank.
    for (let c = 0; c < 20; c += 1) {
      expect(h.cellGrapheme(0, c)).toBe('');
    }
  });

  it('nested DECSET 1049 while already on alt is a no-op', () => {
    const h = new Harness(4, 10);
    h.feed('\x1b[?1049h');
    h.feed('\x1b[1;1HA');
    expect(h.cellGrapheme(0, 0)).toBe('A');
    // Second 1049h while still on alt — should NOT clear alt or reset
    // the cursor save. Subsequent writes continue on the existing alt.
    h.feed('\x1b[?1049h');
    h.feed('\x1b[1;2HB');
    expect(h.cellGrapheme(0, 0)).toBe('A');
    expect(h.cellGrapheme(0, 1)).toBe('B');
    // Single exit brings us back to main (blank since we never wrote
    // anything to main before entering alt).
    h.feed('\x1b[?1049l');
    expect(h.cellGrapheme(0, 0)).toBe('');
  });

  it('1047 and 1048 save slot are distinct from DECSC', () => {
    // Regression guard: DECSC (ESC 7) and DECSET 1048 keep separate slots.
    // Save via DECSC at pos A; save via 1048 at pos B; DECRC should land
    // on A not B, and DECRESET 1048 should land on B not A.
    const h = new Harness(8, 20);
    h.feed('\x1b[2;3H'); // pos A = (1, 2)
    h.feed('\x1b7');      // DECSC
    h.feed('\x1b[5;10H'); // pos B = (4, 9)
    h.feed('\x1b[?1048h'); // save pos B
    // Wander elsewhere.
    h.feed('\x1b[8;20H');
    h.feed('\x1b8'); // DECRC — back to A
    expect(h.emulator._getCursor().row).toBe(1);
    expect(h.emulator._getCursor().col).toBe(2);
    h.feed('\x1b[?1048l'); // restore 1048 slot — back to B
    expect(h.emulator._getCursor().row).toBe(4);
    expect(h.emulator._getCursor().col).toBe(9);
  });
});

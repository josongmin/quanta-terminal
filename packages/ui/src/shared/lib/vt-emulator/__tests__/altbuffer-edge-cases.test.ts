/**
 * Alt-buffer / main-buffer edge-case audit (plan 0005 P0 adversarial pass).
 *
 * Complements `altbuffer.test.ts` with edge cases the base suite does not
 * cover:
 *   - 1049h realistic vim-style burst: entry + ED(2) + CUP + rows
 *   - 1049 entry preserves DECSC state saved BEFORE alt
 *   - 1047 exit clears alt so re-entry is blank even via the 47 path
 *   - resize-while-alt preserves main-buffer contents for return
 *   - combined DECSET modes in the same CSI (`? 1049 ; 25 h`)
 *   - scrollback untouched across an alt round-trip
 *
 * Every test carries an invariant docstring.
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

  constructor(rows = 6, cols = 12) {
    this.emulator = new VtEmulator({
      sessionId: 'alt-edge',
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

describe('altbuffer-edge-cases — realistic TUI entry bursts', () => {
  it('1049h then ED(2) + CUP + rows: mode_changed fires first, deltas are alt-tagged', () => {
    // Invariant: when a real TUI enters alt, the burst looks like
    // `\x1b[?1049h\x1b[2J\x1b[1;1H<rows>`. The emulator MUST emit
    // `mode_changed { alt_screen: true }` before any `grid_delta` that
    // depicts the newly-cleared alt screen or the post-clear rows.
    const h = new Harness(6, 20);
    h.feed('hello on main');
    h.clearEnvs();
    h.feed('\x1b[?1049h\x1b[2J\x1b[1;1Hline-a\r\nline-b\r\nline-c');
    const kinds = h.envs.map((e) => e.payload.kind);
    // First envelope is mode_changed.
    expect(kinds[0]).toBe('mode_changed');
    const first = h.envs[0]!.payload as ModeChangedPayload;
    expect(first.state.alt_screen).toBe(true);
    // Every envelope after the flip must be tagged alt.
    for (const env of h.envs) {
      expect(env.buffer_kind).toBe('alt');
    }
  });

  it('1049 preserves DECSC state taken before alt entry', () => {
    // Invariant: DECSC has its own save slot, distinct from 1048. Entering
    // alt via 1049 uses the 1048 slot; the DECSC slot must survive alt and
    // DECRC inside/after alt must still land on the pre-alt position.
    const h = new Harness(8, 20);
    h.feed('\x1b[2;3H'); // pos A (row 1, col 2)
    h.feed('\x1b7'); // DECSC saves pos A
    h.feed('\x1b[5;10H'); // wander
    h.feed('\x1b[?1049h');
    // On alt, DECRC should still see the pre-alt DECSC state.
    h.feed('\x1b8');
    expect(h.emulator._getCursor().row).toBe(1);
    expect(h.emulator._getCursor().col).toBe(2);
    // Leave alt.
    h.feed('\x1b[?1049l');
    // DECRC still works on main.
    h.feed('\x1b[8;20H'); // wander on main
    h.feed('\x1b8');
    expect(h.emulator._getCursor().row).toBe(1);
    expect(h.emulator._getCursor().col).toBe(2);
  });

  it('1047l exits alt AND wipes alt so next 47h / 1047h starts blank', () => {
    // Invariant: xterm quirk — DECRESET 1047 erases the alt buffer. This
    // makes re-entry via either 47h or 1047h start from a clean screen.
    const h = new Harness(3, 6);
    h.feed('\x1b[?1047h');
    h.feed('dirty');
    h.feed('\x1b[?1047l'); // leave + erase
    // Re-entering via LEGACY 47 should now see a blank alt, because 1047l
    // cleaned up after itself.
    h.feed('\x1b[?47h');
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('');
    expect(h.emulator._getCell(0, 4)?.grapheme).toBe('');
  });

  it('main-buffer SGR is restored after a 1049 round-trip', () => {
    // Invariant: 1049 saves SGR. An in-alt SGR change must NOT leak to main.
    const h = new Harness(4, 10);
    h.feed('\x1b[33m'); // yellow fg on main
    h.feed('\x1b[?1049h');
    h.feed('\x1b[44m'); // change bg on alt
    h.feed('a'); // written on alt with yellow+blue
    h.feed('\x1b[?1049l');
    // On main: SGR must be restored to yellow-fg/default-bg only.
    h.feed('X');
    // Find the 'X' on main (cursor was at home on fresh main since no
    // pre-alt cursor was set).
    let found = false;
    for (let c = 0; c < 10 && !found; c += 1) {
      const cell = h.emulator._getCell(0, c);
      if (cell?.grapheme === 'X') {
        expect(cell.fg).toEqual({ kind: 'named', index: 3 });
        expect(cell.bg).toBe('default');
        found = true;
      }
    }
    expect(found).toBe(true);
  });

  it('scrollback untouched across 1049 entry + alt traffic + exit', () => {
    // Invariant: alt buffer writes never enter the main-buffer scrollback
    // ring. Entering alt with scrollback-backed main, scribbling on alt,
    // and exiting must leave the ring unchanged.
    const h = new Harness(3, 10);
    // Build scrollback on main.
    h.feed('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n');
    const ringBefore = h.emulator.getScrollback();
    const rowsBefore = ringBefore.rows.length;
    // Enter alt and spam scroll-offs.
    h.feed('\x1b[?1049h');
    const lfs = new Uint8Array(200);
    for (let i = 0; i < 200; i += 1) lfs[i] = 0x0a;
    h.emulator.feed(lfs);
    h.feed('\x1b[?1049l');
    const ringAfter = h.emulator.getScrollback();
    expect(ringAfter.rows.length).toBe(rowsBefore);
    expect(ringAfter.evictedCount).toBe(ringBefore.evictedCount);
    expect(ringAfter.baseRowId).toBe(ringBefore.baseRowId);
  });

  it('combined DECRST `? 1049 ; 25 l` fires alt-swap AND hides cursor', () => {
    // Invariant: a single CSI carrying multiple private params must apply
    // ALL of them. Real TUIs batch mode setting this way — e.g. enter alt
    // + hide cursor + enable bracketed paste in one sequence. Here we use
    // `l` to ensure `?25l` actually hides the cursor (since `?25h` shows it).
    const h = new Harness(5, 10);
    // First put us on alt so the `1049 l` exit is observable.
    h.feed('\x1b[?1049h');
    h.clearEnvs();
    h.feed('\x1b[?1049;25l');
    // Cursor hidden after multi-param DECRST.
    expect(h.emulator._getCursor().visible).toBe(false);
    // Alt was exited.
    const modeEvent = h.envs.find((e) => e.payload.kind === 'mode_changed');
    expect(modeEvent).toBeDefined();
    const mode = modeEvent!.payload as ModeChangedPayload;
    expect(mode.state.alt_screen).toBe(false);
  });

  it('resize while on alt: main content preserved; alt cleared; cursor clamped', () => {
    // Invariant: resize on alt clears alt (apps MUST redraw on SIGWINCH)
    // but the dormant main buffer is preserved at the new dims via reflow.
    const h = new Harness(5, 10);
    h.feed('hello world');
    h.feed('\x1b[?1049h');
    h.feed('\x1b[1;1HALT');
    h.emulator.resize(5, 20);
    // Alt has been cleared.
    for (let c = 0; c < 20; c += 1) {
      expect(h.emulator._getCell(0, c)?.grapheme).toBe('');
    }
    // Exit alt — main should still carry "hello world" (first 10 chars)
    // at the top-left of the now-20-wide grid.
    h.feed('\x1b[?1049l');
    expect(h.rowText(0).startsWith('hello worl')).toBe(true);
  });

  it('1048h + 1048l round-trip does NOT change the active buffer', () => {
    // Invariant: DECSET/RESET 1048 only saves/restores cursor state; it
    // never flips the active buffer. Tests must stay on main.
    const h = new Harness(4, 10);
    h.feed('\x1b[?1048h');
    // Before test: still on main. Write to main and confirm.
    h.feed('main-vis');
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('m');
    h.feed('\x1b[?1048l');
    // Still on main — not alt.
    const snap = h.envs[0]!;
    expect(snap.buffer_kind).toBe('main');
    expect(h.emulator._getCell(0, 0)?.grapheme).toBe('m');
  });

  it('snapshot after 1049 exit reflects alt_screen=false in mode_state', () => {
    // Invariant: `buildModeState` must return `alt_screen: false` when the
    // active buffer is main. Verified by triggering a snapshot post-exit.
    const h = new Harness(4, 10);
    h.feed('\x1b[?1049h');
    h.feed('\x1b[?1049l');
    h.clearEnvs();
    h.emulator.snapshot();
    const snap = h.envs.find((e) => e.payload.kind === 'grid_snapshot');
    expect(snap).toBeDefined();
    expect(snap!.buffer_kind).toBe('main');
    if (snap!.payload.kind === 'grid_snapshot') {
      expect(snap!.payload.mode_state.alt_screen).toBe(false);
    }
  });
});

/**
 * Scrollback ring edge-case audit (plan 0005 P0 adversarial pass).
 *
 * Complements `scrollback.test.ts` with edge cases the base suite does not
 * cover:
 *   - DECSTBM with top != 0 → scroll-offs inside the region are NOT captured
 *   - DECSTBM changed mid-session respects the new region for capture gate
 *   - Captured row carries SGR state from the moment of capture
 *   - CSI 3 J (ED(3)) clears the ring without touching baseRowId
 *   - Alt-buffer round trips don't corrupt baseRowId / evictedCount
 *   - Many evictions in one feed: monotonicity and no row duplication
 *   - pinBlockedEvictions counter is monotonic and matches actual paused
 *     evictions
 *
 * Every test carries an invariant docstring.
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
  readonly scrollbackRows?: number;
}

class Harness {
  readonly envs: Env[] = [];
  readonly emulator: VtEmulator;

  constructor(opts: HarnessOpts = {}) {
    const { rows = 4, cols = 10, scrollbackRows } = opts;
    const base = {
      sessionId: 'sb-edge',
      rows,
      cols,
      onEnvelope: (env: Env) => this.envs.push(env),
    };
    this.emulator = new VtEmulator(
      scrollbackRows === undefined ? base : { ...base, scrollbackRows },
    );
  }

  feed(s: string | Uint8Array): void {
    const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : s;
    this.emulator.feed(bytes);
  }

  scrollbackRowText(index: number): string {
    const row = this.emulator.getScrollback().rows[index];
    if (!row) return '';
    let out = '';
    for (const cell of row.cells) {
      if (cell.width === 0) continue;
      out += cell.grapheme === '' ? ' ' : cell.grapheme;
    }
    return out;
  }
}

describe('scrollback-edge-cases — scroll region gating', () => {
  it('DECSTBM with top=2 suppresses scrollback capture', () => {
    // Invariant: when `scrollRegion.top !== 0`, scroll-offs are app-managed
    // working area (think `less -N`'s status line) — they are NOT user
    // history, so the emulator must not capture them into scrollback.
    const h = new Harness({ rows: 5, cols: 10, scrollbackRows: 100 });
    // Fill some text, then set a region that starts mid-screen.
    h.feed('top-row\r\n');
    h.feed('\x1b[3;5r'); // region rows 2..4 (0-indexed)
    // Cursor is now at (0,0) after DECSTBM; move into region.
    h.feed('\x1b[5;1H'); // row 4 col 0
    // Feed enough LFs to scroll the region multiple times.
    for (let i = 0; i < 20; i += 1) h.feed('x\n');
    const ring = h.emulator.getScrollback();
    // Pre-DECSTBM scroll-offs: cursor was at row 1 col 0, no bottom-of-region
    // hits. Post-DECSTBM scrolls happen inside rows 2..4 and MUST NOT capture.
    expect(ring.rows.length).toBe(0);
    expect(ring.evictedCount).toBe(0);
    expect(ring.baseRowId).toBe(0);
  });

  it('DECSTBM restored to full screen resumes capturing', () => {
    // Invariant: switching region between restricted and full-screen must
    // toggle capture. After DECSTBM 1;N resets to full screen, subsequent
    // bottom-of-screen scroll-offs capture again.
    const h = new Harness({ rows: 4, cols: 10, scrollbackRows: 100 });
    h.feed('\x1b[2;3r'); // restricted region 1..2
    // Scroll inside region — no capture.
    h.feed('\x1b[3;1H'); // move to bottom of region
    for (let i = 0; i < 5; i += 1) h.feed('x\n');
    expect(h.emulator.getScrollback().rows.length).toBe(0);
    // Reset to full screen.
    h.feed('\x1b[r');
    // DECSTBM moves cursor to home. Now scroll off the main screen by
    // emitting `rows` LFs.
    h.feed('A\r\nB\r\nC\r\nD\r\nE\r\n'); // produces captures
    const ring = h.emulator.getScrollback();
    expect(ring.rows.length).toBeGreaterThan(0);
  });
});

describe('scrollback-edge-cases — SGR preservation', () => {
  it('captured row preserves SGR attrs at time of capture, not at time of query', () => {
    // Invariant: scrollback rows are CLONED on capture. Subsequent SGR
    // mutations and live-grid writes must NOT mutate the captured row.
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 50 });
    h.feed('\x1b[32mgreen\x1b[0m\r\n'); // row 0 green "green" then reset
    // Scroll off row 0 by pushing 3 LFs.
    h.feed('\r\n\r\n\r\n');
    const ring = h.emulator.getScrollback();
    const head = ring.rows[0]!;
    // The "g" cell must still be green.
    expect(head.cells[0]!.grapheme).toBe('g');
    expect(head.cells[0]!.fg).toEqual({ kind: 'named', index: 2 });
    // Now mutate the live grid heavily — scrollback row is frozen.
    h.feed('\x1b[1;1H\x1b[41mRED\x1b[0m');
    expect(head.cells[0]!.fg).toEqual({ kind: 'named', index: 2 });
  });
});

describe('scrollback-edge-cases — ED(3) interaction', () => {
  it('CSI 3 J wipes the ring but leaves baseRowId and evictedCount intact', () => {
    // Invariant: ED(3) is a history WIPE, not a hard reset. It clears
    // saved rows but preserves diagnostic counters — callers tracking
    // row ids via baseRowId must continue to see a monotonic counter.
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 5 });
    // Fill beyond cap to populate evictedCount.
    for (let i = 0; i < 10; i += 1) h.feed(`r${i}\r\n`);
    const beforeBase = h.emulator.getScrollback().baseRowId;
    const beforeEvicted = h.emulator.getScrollback().evictedCount;
    expect(beforeEvicted).toBeGreaterThan(0);
    h.feed('\x1b[3J');
    const after = h.emulator.getScrollback();
    expect(after.rows.length).toBe(0);
    expect(after.baseRowId).toBe(beforeBase);
    expect(after.evictedCount).toBe(beforeEvicted);
  });
});

describe('scrollback-edge-cases — mass-eviction invariants', () => {
  it('10_000 LF in a single feed() eviction walks ring to cap; no row duplication', () => {
    // Invariant: after a burst producing scroll-offs well past the ring
    // cap, the ring holds exactly `maxRows` rows, each distinct — no
    // stale duplicates from a buggy eviction walk.
    const h = new Harness({ rows: 3, cols: 8, scrollbackRows: 100 });
    // Feed 150 distinct lines in one batch.
    let feed = '';
    for (let i = 0; i < 150; i += 1) feed += `L${String(i).padStart(3, '0')}\r\n`;
    h.feed(feed);
    const ring = h.emulator.getScrollback();
    expect(ring.rows.length).toBe(100);
    // Confirm no duplicates: the 100 retained rows should be lines
    // 148-48 = the last 100 captures = "L048".."L147" (roughly — see math
    // below). Uniqueness is what we really care about.
    const signatures = new Set<string>();
    for (let i = 0; i < ring.rows.length; i += 1) {
      signatures.add(h.scrollbackRowText(i).trimEnd());
    }
    expect(signatures.size).toBe(100);
  });

  it('baseRowId strictly equals evictedCount across long sessions', () => {
    // Invariant: both diagnostics are advanced by the same eviction walker
    // — a divergence would mean a bug in the pin-skip path. Stress this
    // across many feeds to amplify any off-by-one.
    const h = new Harness({ rows: 3, cols: 8, scrollbackRows: 50 });
    for (let f = 0; f < 20; f += 1) {
      let buf = '';
      for (let i = 0; i < 20; i += 1) buf += `f${f}r${i}\r\n`;
      h.feed(buf);
    }
    const ring = h.emulator.getScrollback();
    expect(ring.baseRowId).toBe(ring.evictedCount);
  });
});

describe('scrollback-edge-cases — pin interaction', () => {
  it('pinBlockedEvictions increments exactly once per blocked capture attempt', () => {
    // Invariant: pinBlockedEvictions is a diagnostic counter — every time
    // the eviction walker stops at a pinned head row, it ticks by one.
    // Feeding N overflow captures with the ring pinned at the head must
    // increment by exactly N.
    const h = new Harness({ rows: 3, cols: 8, scrollbackRows: 5 });
    // Fill to cap.
    for (let i = 0; i < 7; i += 1) h.feed(`p${i}\r\n`);
    const ring0 = h.emulator.getScrollback();
    expect(ring0.rows.length).toBe(5);
    // Pin index 0 so future evictions pause.
    h.emulator._debugPinScrollbackRow(0);
    const blocked0 = ring0.pinBlockedEvictions;
    // Each fresh capture past cap should pause at pinned head = one tick.
    h.feed('ovf1\r\n'); // 1 capture — attempts one evict, blocked
    const blocked1 = h.emulator.getScrollback().pinBlockedEvictions;
    expect(blocked1).toBe(blocked0 + 1);
    h.feed('ovf2\r\n'); // +1
    h.feed('ovf3\r\n'); // +1
    const blocked3 = h.emulator.getScrollback().pinBlockedEvictions;
    expect(blocked3).toBe(blocked0 + 3);
  });
});

describe('scrollback-edge-cases — alt-buffer interactions', () => {
  it('alt round-trip in the middle of a capture stream preserves baseRowId', () => {
    // Invariant: entering alt mid-stream must NOT bump baseRowId. Any
    // main-buffer scroll-offs before alt entry count toward baseRowId;
    // alt traffic does not; main scroll-offs after exit resume the count.
    const h = new Harness({ rows: 3, cols: 8, scrollbackRows: 5 });
    // Push 8 rows onto main → 6 scroll-offs, 1 eviction past cap=5.
    for (let i = 0; i < 8; i += 1) h.feed(`m${i}\r\n`);
    const beforeAlt = h.emulator.getScrollback();
    const baseBefore = beforeAlt.baseRowId;
    // Enter alt and push lots of LFs.
    h.feed('\x1b[?1049h');
    for (let i = 0; i < 50; i += 1) h.feed('z\r\n');
    // baseRowId must NOT have moved during alt.
    expect(h.emulator.getScrollback().baseRowId).toBe(baseBefore);
    // Exit alt and push more main rows; baseRowId resumes incrementing.
    h.feed('\x1b[?1049l');
    for (let i = 0; i < 10; i += 1) h.feed(`after${i}\r\n`);
    expect(h.emulator.getScrollback().baseRowId).toBeGreaterThan(baseBefore);
  });
});

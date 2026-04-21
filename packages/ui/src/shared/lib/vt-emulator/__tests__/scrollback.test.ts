/**
 * Bounded scrollback ring tests for `VtEmulator` (plan 0005 Epic α work
 * item α3).
 *
 * Contract locked here:
 *
 *   - Rows falling off the **top of the main scroll region** are cloned
 *     into a bounded ring.
 *   - `scrollbackRows` caps the ring; `0` disables capture entirely.
 *   - Alt-buffer scroll-offs NEVER enter scrollback (xterm contract).
 *   - Pinned rows pause eviction, preserving block-start-row identity for
 *     the future P1 block overlay.
 *   - `reset()` (RIS) wipes the ring; `resize()` preserves it (no reflow in P0).
 *   - `baseRowId` is a monotonic counter over evicted rows — useful for
 *     the P1 row-range-ref scheme.
 *
 * These tests intentionally use small dimensions / short feeds where
 * possible — except the default-cap test, which must actually exercise
 * the 10 000-row ceiling to lock the published default.
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
    // Build VtEmulatorOptions conditionally so `scrollbackRows` is ONLY
    // present when the caller passed a value — required under
    // `exactOptionalPropertyTypes`.
    const base = {
      sessionId: 'scrollback-test',
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

  /**
   * Reconstruct the printable text of a scrollback row — treats `width === 0`
   * as wide-tail continuation (skipped) and blanks as spaces.
   */
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

describe('VtEmulator — scrollback ring (plan 0005 α3)', () => {
  it('default cap is 10 000 rows; overflow evicts oldest; evictedCount tracks drops', () => {
    // No explicit scrollbackRows → engine must use DEFAULT_SCROLLBACK_ROWS.
    const h = new Harness({ rows: 4, cols: 10 });
    // We want 10 050 rows in the scrollback ring. With rows=4, every LF
    // past the bottom row scrolls one real row off the top, so feeding
    // (10 050 + rows - 1) LFs produces ≥10 050 scrollback entries. Use
    // one bulk feed so we're not in the per-feed fast path repeatedly.
    //
    // After construction the cursor is at row 0. We need to first get to
    // the last row by feeding `rows - 1` LFs (no scrollback produced), then
    // every subsequent LF produces one scrollback row.
    const neededScrolls = 10_050;
    const pre = 3; // rows - 1
    const total = pre + neededScrolls;
    const buf = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) buf[i] = 0x0a; // LF
    h.emulator.feed(buf);
    const ring = h.emulator.getScrollback();
    expect(ring.maxRows).toBe(10_000);
    expect(ring.rows.length).toBe(10_000);
    expect(ring.evictedCount).toBe(50);
    expect(ring.baseRowId).toBe(50);
    expect(ring.pinBlockedEvictions).toBe(0);
  });

  it('scrollbackRows option caps the ring; overflow past cap evicts head', () => {
    const h = new Harness({ rows: 4, cols: 10, scrollbackRows: 100 });
    // 100 + 20 overflowing rows → ring sits at cap 100, evicted == 20.
    const neededScrolls = 120;
    const pre = 3;
    const total = pre + neededScrolls;
    const buf = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) buf[i] = 0x0a;
    h.emulator.feed(buf);
    const ring = h.emulator.getScrollback();
    expect(ring.maxRows).toBe(100);
    expect(ring.rows.length).toBe(100);
    expect(ring.evictedCount).toBe(20);
    expect(ring.baseRowId).toBe(20);
  });

  it('scrollbackRows: 0 disables the ring entirely', () => {
    const h = new Harness({ rows: 4, cols: 10, scrollbackRows: 0 });
    const neededScrolls = 50;
    const pre = 3;
    const total = pre + neededScrolls;
    const buf = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) buf[i] = 0x0a;
    h.emulator.feed(buf);
    const ring = h.emulator.getScrollback();
    expect(ring.maxRows).toBe(0);
    expect(ring.rows.length).toBe(0);
    // When disabled, rows are still discarded — but evictedCount stays 0
    // because nothing entered the ring to be evicted.
    expect(ring.evictedCount).toBe(0);
    expect(ring.baseRowId).toBe(0);
  });

  it('main-buffer scroll-off captures row content into the ring', () => {
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 50 });
    // Write 5 distinguishable lines on a 3-row buffer. Using `\r\n`
    // explicitly — the emulator does not auto-insert CR on LF (LNM mode
    // is not modeled), so raw `\n` would keep the cursor at the same
    // column and autowrap against `cols` would yield extra scroll-offs
    // that aren't part of what we're validating here.
    //
    //   "line1\r\n": row 0 = "line1"; cursor → (1, 0).
    //   "line2\r\n": row 1 = "line2"; cursor → (2, 0).
    //   "line3\r\n": row 2 = "line3"; LF at bottom → scrollUp →
    //                row 0 ("line1") captured; cursor stays row 2 col 0.
    //   "line4\r\n": row 2 = "line4"; scroll → "line2" captured.
    //   "line5\r\n": row 2 = "line5"; scroll → "line3" captured.
    h.feed('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n');
    const ring = h.emulator.getScrollback();
    expect(ring.rows.length).toBe(3);
    expect(h.scrollbackRowText(0).trimEnd()).toBe('line1');
    expect(h.scrollbackRowText(1).trimEnd()).toBe('line2');
    expect(h.scrollbackRowText(2).trimEnd()).toBe('line3');
  });

  it('alt buffer does NOT capture to scrollback', () => {
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 200 });
    // Enter alt screen via 1049.
    h.feed('\x1b[?1049h');
    // Feed 100 LFs on alt — all scroll-offs here must be discarded.
    const pre = 2;
    const neededScrolls = 100;
    const total = pre + neededScrolls;
    const buf = new Uint8Array(total);
    for (let i = 0; i < total; i += 1) buf[i] = 0x0a;
    h.emulator.feed(buf);
    // Exit alt.
    h.feed('\x1b[?1049l');
    const ring = h.emulator.getScrollback();
    expect(ring.rows.length).toBe(0);
    expect(ring.evictedCount).toBe(0);
  });

  it('pinned rows pause eviction past the cap; unpinned rows ahead still evict', () => {
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 10 });
    // Build 12 distinct lines "AAA0".."AAA11" (always 4-wide, no wrap) and
    // scroll them off one-by-one. With cap=10, after 12 scroll-offs the
    // ring holds indices 2..11 (baseRowId=2, evictedCount=2).
    let feed = '';
    for (let i = 0; i < 12; i += 1) feed += `AAA${String(i).padStart(2, '0')}\r\n`;
    h.feed(feed);
    const ring0 = h.emulator.getScrollback();
    expect(ring0.rows.length).toBe(10);
    // Pin the row at index 5 (test hook).
    h.emulator._debugPinScrollbackRow(5);
    const pinnedText = h.scrollbackRowText(5).trimEnd();
    expect(pinnedText.length).toBeGreaterThan(0);

    // Drive additional scroll-offs to push eviction past index 5. Each
    // unpinned head eviction shifts the array, so after 5 successful
    // evictions the pinned row is at index 0 and further evictions MUST
    // pause. We feed 20 more rows so the pin is exercised heavily.
    let extra = '';
    for (let i = 0; i < 20; i += 1) extra += `Y${String(i).padStart(2, '0')}\r\n`;
    h.feed(extra);

    const ring = h.emulator.getScrollback();
    // The pinned row must still be in the ring.
    const stillThere = ring.rows.some(
      (r) =>
        r.pinned === true &&
        r.cells
          .map((c) => (c.width === 0 ? '' : c.grapheme === '' ? ' ' : c.grapheme))
          .join('')
          .trimEnd() === pinnedText,
    );
    expect(stillThere).toBe(true);
    // Eviction must have been blocked at least once by the pin.
    expect(ring.pinBlockedEvictions).toBeGreaterThan(0);
    // While the pin blocks, the ring grows past cap.
    expect(ring.rows.length).toBeGreaterThanOrEqual(ring.maxRows);
  });

  it('reset() clears the ring, baseRowId, and evictedCount', () => {
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 20 });
    let feed = '';
    for (let i = 0; i < 30; i += 1) feed += `r${i}\r\n`;
    h.feed(feed);
    const pre = h.emulator.getScrollback();
    expect(pre.rows.length).toBe(20);
    expect(pre.evictedCount).toBeGreaterThan(0);
    // RIS (ESC c) triggers reset().
    h.feed('\x1bc');
    const post = h.emulator.getScrollback();
    expect(post.rows.length).toBe(0);
    expect(post.evictedCount).toBe(0);
    expect(post.baseRowId).toBe(0);
    expect(post.pinBlockedEvictions).toBe(0);
    // Cap is preserved across reset.
    expect(post.maxRows).toBe(20);
  });

  it('resize preserves scrollback rows; original row widths untouched (P0: no reflow)', () => {
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 50 });
    h.feed('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\n');
    const before = h.emulator.getScrollback();
    expect(before.rows.length).toBe(3);
    const firstRowWidthBefore = before.rows[0]!.cells.length;
    const firstRowTextBefore = h.scrollbackRowText(0).trimEnd();
    // Resize to a different cols value — ring must NOT be touched.
    h.emulator.resize(5, 20);
    const after = h.emulator.getScrollback();
    expect(after.rows.length).toBe(3);
    expect(after.rows[0]!.cells.length).toBe(firstRowWidthBefore);
    expect(h.scrollbackRowText(0).trimEnd()).toBe(firstRowTextBefore);
    // baseRowId / evictedCount untouched by resize.
    expect(after.baseRowId).toBe(before.baseRowId);
    expect(after.evictedCount).toBe(before.evictedCount);
  });

  it('baseRowId is monotonic — equals number of evicted rows', () => {
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 40 });
    // Feed 50 lines with explicit CRLF so each line occupies exactly one
    // row (no autowrap side-effects). On a 3-row buffer, the first two
    // lines land on rows 0 and 1, the 3rd reaches the bottom, and every
    // subsequent LF-at-bottom scrolls one row off — 48 scroll-offs total,
    // so 40 are retained and 8 are evicted. `baseRowId` tracks evictions.
    let feed = '';
    for (let i = 0; i < 50; i += 1) feed += `line${i}\r\n`;
    h.feed(feed);
    const ring = h.emulator.getScrollback();
    // 50 lines on a 3-row buffer → 48 rows scroll off. With cap=40, the
    // ring holds the most-recent 40 captures; evictedCount = 48 − 40 = 8.
    expect(ring.rows.length).toBe(40);
    expect(ring.evictedCount).toBe(8);
    expect(ring.baseRowId).toBe(8);
  });

  it('cell projection preserves SGR attrs (bold + colored bg) through scrollback', () => {
    const h = new Harness({ rows: 3, cols: 10, scrollbackRows: 20 });
    // Emit a bold + red-background "A" on the first row, then scroll three
    // times so that row is the head of the ring.
    h.feed('\x1b[1;41mA\x1b[0m');
    h.feed('\r\nline2\r\nline3\r\nline4\r\n');
    const ring = h.emulator.getScrollback();
    expect(ring.rows.length).toBeGreaterThan(0);
    const head = ring.rows[0]!;
    const cell0 = head.cells[0]!;
    expect(cell0.grapheme).toBe('A');
    expect(cell0.bold).toBe(true);
    // `\x1b[41m` is "set bg = named index 1" (red).
    expect(cell0.bg).toEqual({ kind: 'named', index: 1 });
  });
});

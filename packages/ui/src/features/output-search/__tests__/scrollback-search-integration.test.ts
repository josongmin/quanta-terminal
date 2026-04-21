/**
 * Integration: `searchGrid` against a real `VtEmulator` instance.
 *
 * Exercises the intended shape of the feature end-to-end: feed bytes →
 * scrollback + viewport populate → `searchGrid` walks the real
 * `getScrollback()` / `getViewportRows()` surface and produces grid-space
 * hits. Kept minimal; deeper semantic coverage lives in
 * `scrollback-search.test.ts` with the stub emulator.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../../../shared/lib/vt-emulator/index.js';
import { searchGrid } from '../scrollback-search.js';

/** Build a small emulator; we don't care about the envelope stream here. */
function makeEmulator(rows: number, cols: number): VtEmulator {
  return new VtEmulator({
    sessionId: 'test',
    rows,
    cols,
    onEnvelope: () => {},
    scrollbackRows: 10_000,
  });
}

function feed(em: VtEmulator, s: string): void {
  em.feed(new TextEncoder().encode(s));
}

describe('searchGrid × VtEmulator', () => {
  it('finds a literal hit in the live viewport', () => {
    const em = makeEmulator(6, 40);
    feed(em, 'hello world\r\nfoo bar\r\n');
    const hits = searchGrid(em, 'bar');
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toBe('bar');
    // Row 1, starting at column 4 (after "foo ").
    expect(hits[0]!.startCol).toBe(4);
  });

  it('finds hits that have scrolled into scrollback', () => {
    // Rows=3; push more than 3 lines so the earliest lines fall into the
    // scrollback ring.
    const em = makeEmulator(3, 40);
    feed(em, 'alpha target\n');
    feed(em, 'beta\n');
    feed(em, 'gamma\n');
    feed(em, 'delta\n');
    feed(em, 'epsilon target\n');
    // "alpha target" should now live in scrollback; "epsilon target" in the
    // viewport. Both should be findable.
    const hits = searchGrid(em, 'target');
    expect(hits.length).toBe(2);
    // Scrollback hits come first (lower rowId).
    expect(hits[0]!.rowId).toBeLessThan(hits[1]!.rowId);
  });

  it('handles case-insensitive search across both regions', () => {
    const em = makeEmulator(2, 40);
    feed(em, 'ERROR: disk full\n');
    feed(em, 'warning: retry\n');
    feed(em, 'info: ok\n');
    const hits = searchGrid(em, 'error', { caseSensitive: false });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text.toLowerCase()).toBe('error');
  });
});

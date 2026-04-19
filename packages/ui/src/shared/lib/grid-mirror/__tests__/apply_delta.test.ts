/**
 * `applyDelta` span-pattern coverage: blanks, inline ASCII, repeated
 * grapheme, Korean 2-col, family emoji, hyperlink-id resolution.
 */

import { describe, expect, it } from 'vitest';
import { GridMirror } from '../GridMirror.js';
import type { RowDelta } from '../types.js';
import { blankSnapshot, blankSpan, deltaEnv, repeatSpan, textSpan } from './fixtures.js';

describe('GridMirror apply_delta span patterns', () => {
  it('full-row blank span clears the row', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 8, 0, 1));
    const r: RowDelta = {
      row: 0,
      revision_before: 1,
      revision_after: 2,
      spans: [blankSpan(8)],
      continuation: false,
      hyperlink_refs: [],
    };
    expect(m.applyDelta(deltaEnv([r], { seq: 1 })).outcome).toBe('applied');
    const row = m.getRow(0);
    expect(row?.cells.length).toBe(8);
    expect(row?.cells.every((c) => c.grapheme === '')).toBe(true);
  });

  it('inline ASCII text span fills cells with graphemes', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 8, 0, 1));
    const r: RowDelta = {
      row: 0,
      revision_before: 1,
      revision_after: 2,
      spans: [textSpan('abc', 3), blankSpan(5)],
      continuation: false,
      hyperlink_refs: [],
    };
    m.applyDelta(deltaEnv([r], { seq: 1 }));
    const row = m.getRow(0);
    expect(row?.cells[0]?.grapheme).toBe('abc');
    expect(row?.cells[3]?.grapheme).toBe('');
  });

  it('repeat-grapheme span produces `count` cells', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 40, 0, 1));
    const r: RowDelta = {
      row: 1,
      revision_before: 1,
      revision_after: 2,
      spans: [repeatSpan('\u2500', 40)],
      continuation: false,
      hyperlink_refs: [],
    };
    m.applyDelta(deltaEnv([r], { seq: 1 }));
    const row = m.getRow(1);
    expect(row?.cells.length).toBe(40);
    expect(row?.cells[0]?.grapheme).toBe('\u2500');
  });

  it('Korean 2-col span carries the grapheme on the first cell', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 8, 0, 1));
    // "한" = [237, 149, 156] UTF-8, wide-char takes cols=2.
    const r: RowDelta = {
      row: 0,
      revision_before: 1,
      revision_after: 2,
      spans: [
        {
          cols: 2,
          sgr: '0x0000000000000000',
          graphemes: { utf8: [237, 149, 156] },
          hyperlink_id: 0,
          ext: null,
        },
        blankSpan(6),
      ],
      continuation: false,
      hyperlink_refs: [],
    };
    m.applyDelta(deltaEnv([r], { seq: 1 }));
    const row = m.getRow(0);
    expect(row?.cells[0]?.grapheme).toBe('한');
    expect(row?.cells[1]?.grapheme).toBe(''); // continuation half
  });

  it('hyperlink_id is preserved and resolves via HyperlinkAdded', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 8, 0, 1));
    // Add hyperlink first.
    m.apply({
      session_id: 's',
      grid_epoch: 1,
      sequence_no: 1,
      resize_generation: 0,
      buffer_kind: 'main',
      payload: {
        kind: 'hyperlink_added',
        id: 42,
        uri: 'https://example.com',
        params: null,
      },
    });
    const r: RowDelta = {
      row: 0,
      revision_before: 1,
      revision_after: 2,
      spans: [
        {
          cols: 3,
          sgr: '0x0',
          graphemes: { utf8: 'abc' },
          hyperlink_id: 42,
          ext: null,
        },
        blankSpan(5),
      ],
      continuation: false,
      hyperlink_refs: [42],
    };
    m.applyDelta(deltaEnv([r], { seq: 2 }));
    const cell = m.getRow(0)?.cells[0];
    expect(cell?.hyperlink_id).toBe(42);
    expect(m.resolveHyperlink(42)).toEqual({
      id: 42,
      uri: 'https://example.com',
      params: null,
    });
  });

  it('passes the `continuation` flag through to the mirrored row', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const r: RowDelta = {
      row: 0,
      revision_before: 1,
      revision_after: 2,
      spans: [textSpan('abcd', 4)],
      continuation: true,
      hyperlink_refs: [],
    };
    m.applyDelta(deltaEnv([r], { seq: 1 }));
    expect(m.getRow(0)?.continuation).toBe(true);
  });

  it('apply-rest-on-mismatch: non-matching row requests resync, others apply', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(4, 4, 0, 1));
    const rows: RowDelta[] = [
      {
        row: 0,
        revision_before: 1,
        revision_after: 2,
        spans: [textSpan('AAAA', 4)],
        continuation: false,
        hyperlink_refs: [],
      },
      {
        // Bad revision_before — should trigger row-resync, row 2 still applies.
        row: 1,
        revision_before: 99,
        revision_after: 100,
        spans: [textSpan('BBBB', 4)],
        continuation: false,
        hyperlink_refs: [],
      },
      {
        row: 2,
        revision_before: 1,
        revision_after: 2,
        spans: [textSpan('CCCC', 4)],
        continuation: false,
        hyperlink_refs: [],
      },
    ];
    const r = m.applyDelta(deltaEnv(rows, { seq: 1 }));
    expect(r.outcome).toBe('applied');
    expect(m.getRow(0)?.cells[0]?.grapheme).toBe('AAAA');
    expect(m.getRow(2)?.cells[0]?.grapheme).toBe('CCCC');
    // Row 1 retained its pre-delta content.
    expect(m.getRow(1)?.cells[0]?.grapheme).toBe('');
  });
});

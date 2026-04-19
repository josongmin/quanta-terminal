/**
 * E2E-C8 — OSC 8 hyperlink lifecycle: open → reference → close →
 * orphan-safe fallback + id reuse.
 */

import { describe, expect, it } from 'vitest';
import { GridMirror } from '../GridMirror.js';
import type { GridEventEnvelope, GridPayload, RowDelta } from '../types.js';
import { blankSnapshot, deltaEnv } from './fixtures.js';

function linkAdd(
  id: number,
  uri: string,
  seq: number,
): GridEventEnvelope<GridPayload> {
  return {
    session_id: 's',
    grid_epoch: 1,
    sequence_no: seq,
    resize_generation: 0,
    buffer_kind: 'main',
    payload: { kind: 'hyperlink_added', id, uri, params: null },
  };
}

function linkRemove(id: number, seq: number): GridEventEnvelope<GridPayload> {
  return {
    session_id: 's',
    grid_epoch: 1,
    sequence_no: seq,
    resize_generation: 0,
    buffer_kind: 'main',
    payload: { kind: 'hyperlink_removed', id },
  };
}

describe('OSC 8 hyperlink lifecycle (E2E-C8)', () => {
  it('open → reference → close → orphan-safe fallback', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 8, 0, 1));
    m.apply(linkAdd(1, 'https://example.com', 1));
    const r: RowDelta = {
      row: 0,
      revision_before: 1,
      revision_after: 2,
      spans: [
        {
          cols: 5,
          sgr: '0x0',
          graphemes: { utf8: 'hello' },
          hyperlink_id: 1,
          ext: null,
        },
        {
          cols: 3,
          sgr: '0x0',
          graphemes: 'blank',
          hyperlink_id: 0,
          ext: null,
        },
      ],
      continuation: false,
      hyperlink_refs: [1],
    };
    m.applyDelta(deltaEnv([r], { seq: 2 }));
    expect(m.resolveHyperlink(1).uri).toBe('https://example.com');
    expect(m.getRow(0)?.cells[0]?.hyperlink_id).toBe(1);

    // Close (refcount to 0).
    m.apply(linkRemove(1, 3));
    // Cell still references id=1 but resolver returns safe fallback.
    expect(m.resolveHyperlink(1)).toEqual({ id: 1, uri: null, params: null });
    expect(() => m.resolveHyperlink(1)).not.toThrow();
    expect(m.getRow(0)?.cells[0]?.hyperlink_id).toBe(1);
  });

  it('id reuse after remove works — new add, new row applied, fresh URI', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 8, 0, 1));
    m.apply(linkAdd(1, 'https://old.com', 1));
    m.apply(linkRemove(1, 2));
    m.apply(linkAdd(1, 'https://new.com', 3));
    expect(m.resolveHyperlink(1).uri).toBe('https://new.com');
    const r: RowDelta = {
      row: 1,
      revision_before: 1,
      revision_after: 2,
      spans: [
        {
          cols: 4,
          sgr: '0x0',
          graphemes: { utf8: 'abcd' },
          hyperlink_id: 1,
          ext: null,
        },
        {
          cols: 4,
          sgr: '0x0',
          graphemes: 'blank',
          hyperlink_id: 0,
          ext: null,
        },
      ],
      continuation: false,
      hyperlink_refs: [1],
    };
    m.applyDelta(deltaEnv([r], { seq: 4 }));
    expect(m.getRow(1)?.cells[0]?.hyperlink_id).toBe(1);
    expect(m.resolveHyperlink(1).uri).toBe('https://new.com');
  });
});

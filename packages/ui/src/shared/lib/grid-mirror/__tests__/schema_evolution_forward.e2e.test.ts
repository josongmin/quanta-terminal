/**
 * E2E-C9 — forward-compat: TS mirror gracefully handles a new Rust-side field.
 * An envelope whose payload has an unknown-to-TS key must NOT throw; the
 * unknown key is dropped and the known shape survives.
 */

import { describe, expect, it } from 'vitest';
import { GridMirror } from '../GridMirror.js';
import type { GridSnapshotPayload } from '../types.js';

describe('Schema evolution forward-compat (E2E-C9)', () => {
  it('dropping an unknown payload field succeeds; known fields survive', () => {
    const m = new GridMirror();
    // Construct a payload with an additional "future_field" — mimicking a
    // Rust-side addition the TS hasn't learned yet.
    const payload = {
      kind: 'grid_snapshot',
      rows: 2,
      cols: 4,
      buffer_kind: 'main',
      row_deltas: [
        {
          row: 0,
          revision_before: 0,
          revision_after: 1,
          spans: [
            {
              cols: 4,
              sgr: '0x0',
              graphemes: 'blank',
              hyperlink_id: 0,
              ext: null,
            },
          ],
          continuation: false,
          hyperlink_refs: [],
        },
        {
          row: 1,
          revision_before: 0,
          revision_after: 1,
          spans: [
            {
              cols: 4,
              sgr: '0x0',
              graphemes: 'blank',
              hyperlink_id: 0,
              ext: null,
            },
          ],
          continuation: false,
          hyperlink_refs: [],
        },
      ],
      cursor: {
        row: 0,
        col: 0,
        visible: true,
        shape: 'block',
        blinking: true,
        pending_wrap: false,
      },
      mode_state: {},
      meta: { title: null, cwd: null, hyperlink_digest: null, future_field: 'ignore me' },
      unknown_root_field: 7,
    } as unknown as GridSnapshotPayload;
    const env = {
      session_id: 's',
      grid_epoch: 1,
      sequence_no: 0,
      resize_generation: 0,
      buffer_kind: 'main' as const,
      payload,
    };
    expect(() => m.applySnapshot(env)).not.toThrow();
    expect(m.getDimensions()).toEqual({ rows: 2, cols: 4 });
  });

  it('unknown graphemes shape is handled gracefully (empty grapheme)', () => {
    const m = new GridMirror();
    const payload = {
      kind: 'grid_snapshot',
      rows: 1,
      cols: 2,
      buffer_kind: 'main',
      row_deltas: [
        {
          row: 0,
          revision_before: 0,
          revision_after: 1,
          spans: [
            {
              cols: 2,
              sgr: '0x0',
              graphemes: { future_shape: true }, // unknown-shape grapheme run
              hyperlink_id: 0,
              ext: null,
            },
          ],
          continuation: false,
          hyperlink_refs: [],
        },
      ],
      cursor: null,
      mode_state: {},
      meta: {},
    } as unknown as GridSnapshotPayload;
    m.applySnapshot({
      session_id: 's',
      grid_epoch: 1,
      sequence_no: 0,
      resize_generation: 0,
      buffer_kind: 'main',
      payload,
    });
    // Mirror rendered the row with blank graphemes — does NOT throw.
    expect(m.getRow(0)?.cells.length).toBe(2);
  });
});

/**
 * Row-resync recovery: single-row mismatch → ResyncRowRequest, response
 * application, ReplayFailed escalation.
 */

import { describe, expect, it, vi } from 'vitest';
import { CountingTelemetry, GridMirror } from '../GridMirror.js';
import type { RowDelta } from '../types.js';
import { blankSnapshot, deltaEnv, textSpan } from './fixtures.js';

describe('GridMirror resync recovery', () => {
  it('emits ResyncRowRequest on a RowDelta revision mismatch', () => {
    const telemetry = new CountingTelemetry();
    const onRow = vi.fn();
    const m = new GridMirror({ telemetry, onRowResyncRequested: onRow });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const bad: RowDelta = {
      row: 1,
      revision_before: 99, // mismatch — actual is 1
      revision_after: 100,
      spans: [textSpan('abcd', 4)],
      continuation: false,
      hyperlink_refs: [],
    };
    m.applyDelta(deltaEnv([bad], { seq: 1 }));
    expect(onRow).toHaveBeenCalledTimes(1);
    expect(onRow.mock.calls[0]?.[0]).toMatchObject({
      grid_epoch: 1,
      resize_generation: 0,
      row: 1,
    });
    expect(telemetry.get('revision_mismatch')).toBe(1);
  });

  it('applies ResyncRowResponse::Ok with authoritative row content', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    m.applyResyncRowResponse({
      status: 'ok',
      grid_epoch: 1,
      resize_generation: 0,
      sequence_no: 2,
      row_delta: {
        row: 0,
        revision_before: 0,
        revision_after: 5,
        spans: [textSpan('xyz!', 4)],
        continuation: false,
        hyperlink_refs: [],
      },
    });
    expect(m.getRow(0)?.cells[0]?.grapheme).toBe('xyz!');
    expect(m.getRow(0)?.revision).toBe(5);
  });

  it('escalates to snapshot on ReplayFailed', () => {
    const onSnapshot = vi.fn();
    const m = new GridMirror({ onSnapshotResyncRequested: onSnapshot });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const r = m.applyResyncRowResponse({
      status: 'replay_failed',
      reason: 'epoch_changed',
      current_epoch: 99,
      current_resize_generation: 0,
    });
    expect(r.outcome).toBe('snapshot_requested');
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it('K-1 mismatches do NOT escalate to snapshot', () => {
    const telemetry = new CountingTelemetry();
    const onSnapshot = vi.fn();
    const m = new GridMirror({
      telemetry,
      onSnapshotResyncRequested: onSnapshot,
      stormThreshold: { k: 3, windowMs: 10_000 },
    });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    for (let i = 0; i < 2; i += 1) {
      const bad: RowDelta = {
        row: 0,
        revision_before: 999,
        revision_after: 1000,
        spans: [textSpan('XXXX', 4)],
        continuation: false,
        hyperlink_refs: [],
      };
      m.applyDelta(deltaEnv([bad], { seq: i + 1 }));
    }
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(telemetry.get('snapshot_fallback_storm_triggered')).toBe(0);
  });
});

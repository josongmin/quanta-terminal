/**
 * E2E-C7 — storm threshold escalation. 5 mismatches in a 10s window must
 * trigger exactly one SnapshotRequest and lock out subsequent deltas until a
 * snapshot reseeds.
 */

import { describe, expect, it, vi } from 'vitest';
import { CountingTelemetry, GridMirror } from '../GridMirror.js';
import type { RowDelta } from '../types.js';
import { blankSnapshot, deltaEnv, textSpan } from './fixtures.js';

describe('GridMirror storm threshold (E2E-C7)', () => {
  it('5 mismatches in 10s escalate to a single SnapshotRequest', () => {
    const telemetry = new CountingTelemetry();
    const onSnapshot = vi.fn();
    let now = 0;
    const m = new GridMirror({
      telemetry,
      onSnapshotResyncRequested: onSnapshot,
      stormThreshold: { k: 5, windowMs: 10_000 },
      now: () => now,
    });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const badRow = (seq: number): RowDelta => ({
      row: 0,
      revision_before: 999,
      revision_after: 1000 + seq,
      spans: [textSpan('XXXX', 4)],
      continuation: false,
      hyperlink_refs: [],
    });
    // 4 mismatches spaced 2s apart — under threshold.
    for (let i = 0; i < 4; i += 1) {
      now = i * 2000;
      m.applyDelta(deltaEnv([badRow(i)], { seq: i + 1 }));
    }
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(telemetry.get('snapshot_fallback_storm_triggered')).toBe(0);

    // 5th mismatch at t=8s — in-window with all 4 prior → trigger.
    now = 8000;
    const r = m.applyDelta(deltaEnv([badRow(4)], { seq: 5 }));
    expect(r.outcome).toBe('snapshot_requested');
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0]?.[0]).toMatchObject({
      epoch: 1,
      reason: 'row_mismatch_storm',
    });
    expect(telemetry.get('snapshot_fallback_storm_triggered')).toBe(1);

    // Post-escalation: subsequent delta discarded until a snapshot reseeds.
    const next = m.applyDelta(deltaEnv([], { seq: 6 }));
    expect(next.outcome).toBe('discarded');
  });

  it('mismatches outside the window age out and do not count', () => {
    const onSnapshot = vi.fn();
    let now = 0;
    const m = new GridMirror({
      onSnapshotResyncRequested: onSnapshot,
      stormThreshold: { k: 5, windowMs: 10_000 },
      now: () => now,
    });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    const badRow = (seq: number): RowDelta => ({
      row: 0,
      revision_before: 999,
      revision_after: 1000 + seq,
      spans: [textSpan('XXXX', 4)],
      continuation: false,
      hyperlink_refs: [],
    });
    // 4 mismatches at t=0, 3000, 6000, 9000ms.
    for (let i = 0; i < 4; i += 1) {
      now = i * 3000;
      m.applyDelta(deltaEnv([badRow(i)], { seq: i + 1 }));
    }
    // 5th at t=15 000 — the t=0 entry aged out (>10s old), so only 4 in window.
    now = 15_000;
    m.applyDelta(deltaEnv([badRow(4)], { seq: 5 }));
    expect(onSnapshot).not.toHaveBeenCalled();
  });
});

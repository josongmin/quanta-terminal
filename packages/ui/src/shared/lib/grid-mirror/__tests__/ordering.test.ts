/**
 * Envelope-gate ordering tests (DoD-C-08 … DoD-C-13).
 *
 * Verifies the `(grid_epoch, sequence_no, resize_generation)` ordering rules
 * defined in ADR 0017 §2 and plan §4.3.
 */

import { describe, expect, it, vi } from 'vitest';
import { CountingTelemetry, GridMirror } from '../GridMirror.js';
import { blankSnapshot, deltaEnv, textSpan } from './fixtures.js';

describe('GridMirror envelope gate — ordering', () => {
  it('accepts a snapshot at any sequence, then subsequent deltas', () => {
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ telemetry });
    expect(m.applySnapshot(blankSnapshot(2, 4, 0, 1)).outcome).toBe('applied');
    expect(m.getAppliedSequence()).toBe(0n);
    expect(m.getAppliedEpoch()).toBe(1n);
    const r = m.applyDelta(
      deltaEnv(
        [
          {
            row: 0,
            revision_before: 1,
            revision_after: 2,
            spans: [textSpan('abcd', 4)],
            continuation: false,
            hyperlink_refs: [],
          },
        ],
        { seq: 1 },
      ),
    );
    expect(r.outcome).toBe('applied');
  });

  it('discards a delta whose epoch is strictly older than the mirror state', () => {
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ telemetry });
    m.applySnapshot(blankSnapshot(2, 4, 0, 5));
    const r = m.applyDelta(
      deltaEnv([], { seq: 100, epoch: 4 }),
    );
    expect(r).toEqual({ outcome: 'discarded', reason: 'stale_epoch' });
    expect(telemetry.get('stale_epoch_drop')).toBe(1);
  });

  it('discards a non-snapshot envelope whose sequence <= applied', () => {
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ telemetry });
    m.applySnapshot(blankSnapshot(2, 4, 10, 1));
    // Applied seq = 10; send seq = 10 again → discarded as stale.
    const r = m.applyDelta(deltaEnv([], { seq: 10 }));
    expect(r).toEqual({ outcome: 'discarded', reason: 'stale_sequence' });
    expect(telemetry.get('stale_sequence_drop')).toBe(1);
  });

  it('discards a grid_delta whose resize_generation is older', () => {
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ telemetry });
    // Snapshot at resize_generation=5 to seed mirror.
    m.applySnapshot({
      ...blankSnapshot(2, 4, 0, 1),
      resize_generation: 5,
    });
    const r = m.applyDelta(deltaEnv([], { seq: 1, resize_generation: 4 }));
    expect(r).toEqual({ outcome: 'discarded', reason: 'stale_resize_generation' });
    expect(telemetry.get('stale_resize_generation_drop')).toBe(1);
  });

  it('on epoch-advance without snapshot, emits SnapshotRequest and locks out deltas', () => {
    const telemetry = new CountingTelemetry();
    const onSnapshot = vi.fn();
    const m = new GridMirror({ telemetry, onSnapshotResyncRequested: onSnapshot });
    m.applySnapshot(blankSnapshot(2, 4, 0, 1));
    // Deliver a delta carrying a NEWER epoch than what we have.
    const r = m.applyDelta(deltaEnv([], { seq: 50, epoch: 2 }));
    expect(r.outcome).toBe('snapshot_requested');
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0]?.[0]).toMatchObject({
      epoch: 2,
      reason: 'epoch_advanced_without_snapshot',
    });
    // Subsequent deltas at the old epoch get discarded while awaiting snapshot.
    const next = m.applyDelta(deltaEnv([], { seq: 51 }));
    expect(next.outcome).toBe('discarded');
  });

  it('snapshot at any sequence reseeds applied_sequence', () => {
    const m = new GridMirror();
    m.applySnapshot(blankSnapshot(2, 4, 100, 1));
    expect(m.getAppliedSequence()).toBe(100n);
    m.applySnapshot(blankSnapshot(2, 4, 50, 1));
    expect(m.getAppliedSequence()).toBe(50n);
  });
});

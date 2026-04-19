/**
 * Synchronized-update window behavior (DoD-C-30 … C-33).
 * Suppression inside Begin…End; timeout-force-end; abort on snapshot reseed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CountingTelemetry, GridMirror } from '../GridMirror.js';
import type { GridEventEnvelope, GridPayload, SyncPhase } from '../types.js';
import { blankSnapshot, deltaEnv, textSpan } from './fixtures.js';

function syncEnv(phase: SyncPhase, seq: number): GridEventEnvelope<GridPayload> {
  return {
    session_id: 's',
    grid_epoch: 1,
    sequence_no: seq,
    resize_generation: 0,
    buffer_kind: 'main',
    payload: { kind: 'synchronized_update', phase },
  };
}

describe('Synchronized-update window', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Begin suppresses onChange; End flushes accumulated dirty set exactly once', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(4, 4, 0, 1));
    // Snapshot reseed fires once.
    expect(onChange).toHaveBeenCalledTimes(1);
    onChange.mockClear();

    m.apply(syncEnv('begin', 1));
    // Accumulate 3 row deltas.
    for (let i = 0; i < 3; i += 1) {
      m.applyDelta(
        deltaEnv(
          [
            {
              row: i,
              revision_before: 1,
              revision_after: 2,
              spans: [textSpan('abcd', 4)],
              continuation: false,
              hyperlink_refs: [],
            },
          ],
          { seq: 2 + i },
        ),
      );
    }
    expect(onChange).not.toHaveBeenCalled();

    m.apply(syncEnv('end', 5));
    expect(onChange).toHaveBeenCalledTimes(1);
    const dirty = onChange.mock.calls[0]?.[0] as ReadonlySet<number>;
    expect(new Set(dirty)).toEqual(new Set([0, 1, 2]));
  });

  it('150ms timeout force-ends the window; counter increments', () => {
    const onChange = vi.fn();
    const telemetry = new CountingTelemetry();
    const m = new GridMirror({ onChange, telemetry });
    m.applySnapshot(blankSnapshot(4, 4, 0, 1));
    onChange.mockClear();

    m.apply(syncEnv('begin', 1));
    m.applyDelta(
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
        { seq: 2 },
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(160);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(telemetry.get('synchronized_update_timeouts')).toBe(1);
  });

  it('late End after timeout is a no-op', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(4, 4, 0, 1));
    onChange.mockClear();

    m.apply(syncEnv('begin', 1));
    m.applyDelta(
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
        { seq: 2 },
      ),
    );
    vi.advanceTimersByTime(160);
    onChange.mockClear();
    m.apply(syncEnv('end', 3));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('snapshot during synced window aborts the window and fires its own onChange', () => {
    const onChange = vi.fn();
    const m = new GridMirror({ onChange });
    m.applySnapshot(blankSnapshot(4, 4, 0, 1));
    onChange.mockClear();
    m.apply(syncEnv('begin', 1));
    m.applyDelta(
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
        { seq: 2 },
      ),
    );
    expect(onChange).not.toHaveBeenCalled();
    // Snapshot reseed at same epoch.
    m.applySnapshot(blankSnapshot(4, 4, 3, 1));
    // Observer fires once for the full-row dirty set from snapshot.
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

/**
 * Plan 0005 P1-C polish — useRowRangeTracker spec.
 *
 * Drives the hook through a deterministic scheduler so each `act(() => tick())`
 * flushes exactly one rAF. Tests the four invariants that matter:
 *
 *   1. Sync initial snapshot: the very first render produces correct metrics
 *      without waiting for a frame.
 *   2. Batching: N prop bursts between frames produce exactly ONE recompute.
 *   3. Reference stability: a metric whose rect doesn't change keeps its
 *      prior reference across frames (enables downstream memoization).
 *   4. Cleanup: pending frames are cancelled on unmount.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  useRowRangeTracker,
  computeCardMetrics,
  metricEqual,
  metricsArrayEqual,
  type CardMetric,
  type TrackableBlock,
} from '../useRowRangeTracker.js';

/**
 * Build a step-tickable rAF fake. `schedule(cb)` pushes cb into a queue and
 * returns an integer handle; `tick()` fires the HEAD callback (FIFO). Each
 * tick models one browser frame.
 */
function makeFakeRaf(): {
  schedule: (cb: () => void) => number;
  cancel: (id: number) => void;
  tick: () => void;
  tickAll: () => void;
  pendingCount: () => number;
  cancelledCount: () => number;
} {
  const queue: Array<{ id: number; cb: () => void; cancelled: boolean }> = [];
  let nextId = 1;
  let cancelled = 0;
  return {
    schedule: (cb) => {
      const id = nextId++;
      queue.push({ id, cb, cancelled: false });
      return id;
    },
    cancel: (id) => {
      const entry = queue.find((q) => q.id === id);
      if (entry && !entry.cancelled) {
        entry.cancelled = true;
        cancelled += 1;
      }
    },
    tick: () => {
      // Fire the first non-cancelled entry.
      while (queue.length > 0) {
        const head = queue.shift();
        if (!head) return;
        if (head.cancelled) continue;
        head.cb();
        return;
      }
    },
    tickAll: () => {
      let safety = 100;
      while (queue.length > 0 && safety-- > 0) {
        const head = queue.shift();
        if (!head) return;
        if (head.cancelled) continue;
        head.cb();
      }
    },
    pendingCount: () =>
      queue.filter((q) => !q.cancelled).length,
    cancelledCount: () => cancelled,
  };
}

function mkBlock(
  id: string,
  startRow: number,
  endRowExclusive: number | null,
): TrackableBlock {
  return { id, rowRange: { startRow, endRowExclusive } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useRowRangeTracker — hook', () => {
  it('produces a synchronous initial snapshot on first render', () => {
    const raf = makeFakeRaf();
    const { result } = renderHook(() =>
      useRowRangeTracker({
        blocks: [mkBlock('a', 5, 10)],
        baseRowId: 0,
        rowCount: 50,
        cellHeightPx: 16,
        scheduler: raf.schedule,
        cancelScheduler: raf.cancel,
      }),
    );
    expect(result.current.cardMetrics).toHaveLength(1);
    const m = result.current.cardMetrics[0]!;
    expect(m.id).toBe('a');
    expect(m.topPx).toBe(80); // 5 * 16
    expect(m.heightPx).toBe(80);
    expect(m.visible).toBe(true);
    expect(result.current.frameCount).toBe(0);
  });

  it('batches multiple prop changes into a single rAF', () => {
    const raf = makeFakeRaf();
    const { result, rerender } = renderHook(
      ({ baseRowId }: { baseRowId: number }) =>
        useRowRangeTracker({
          blocks: [mkBlock('a', 5, 10)],
          baseRowId,
          rowCount: 50,
          cellHeightPx: 16,
          scheduler: raf.schedule,
          cancelScheduler: raf.cancel,
        }),
      { initialProps: { baseRowId: 0 } },
    );
    // Effect on mount schedules one rAF. Burst of 3 more prop changes
    // should NOT enqueue new rAFs while the first is pending.
    const afterMount = raf.pendingCount();
    expect(afterMount).toBe(1);

    rerender({ baseRowId: 1 });
    rerender({ baseRowId: 2 });
    rerender({ baseRowId: 3 });
    expect(raf.pendingCount()).toBe(1);

    // Flush: the single rAF reads the latest inputs (baseRowId=3) via ref.
    act(() => raf.tick());
    // startRow=5, baseRowId=3 → (5-3)*16 = 32
    expect(result.current.cardMetrics[0]!.topPx).toBe(32);
  });

  it('bumps frameCount exactly once per flushed recompute that produced a change', () => {
    const raf = makeFakeRaf();
    const { result, rerender } = renderHook(
      ({ baseRowId }: { baseRowId: number }) =>
        useRowRangeTracker({
          blocks: [mkBlock('a', 5, 10)],
          baseRowId,
          rowCount: 50,
          cellHeightPx: 16,
          scheduler: raf.schedule,
          cancelScheduler: raf.cancel,
        }),
      { initialProps: { baseRowId: 0 } },
    );
    // First mount effect flush (no-op: inputs unchanged from initial state).
    act(() => raf.tickAll());
    expect(result.current.frameCount).toBe(0);

    rerender({ baseRowId: 2 });
    act(() => raf.tickAll());
    expect(result.current.frameCount).toBe(1);

    rerender({ baseRowId: 3 });
    act(() => raf.tickAll());
    expect(result.current.frameCount).toBe(2);
  });

  it('does NOT bump frameCount on an idle tick (no change)', () => {
    const raf = makeFakeRaf();
    const { result, rerender } = renderHook(
      ({ baseRowId }: { baseRowId: number }) =>
        useRowRangeTracker({
          blocks: [mkBlock('a', 5, 10)],
          baseRowId,
          rowCount: 50,
          cellHeightPx: 16,
          scheduler: raf.schedule,
          cancelScheduler: raf.cancel,
        }),
      { initialProps: { baseRowId: 0 } },
    );
    // Force an effect flush with identical props.
    rerender({ baseRowId: 0 });
    act(() => raf.tickAll());
    expect(result.current.frameCount).toBe(0);
  });

  it('reuses prior CardMetric reference when its rect is unchanged', () => {
    const raf = makeFakeRaf();
    const { result, rerender } = renderHook(
      ({ blocks }: { blocks: TrackableBlock[] }) =>
        useRowRangeTracker({
          blocks,
          baseRowId: 0,
          rowCount: 50,
          cellHeightPx: 16,
          scheduler: raf.schedule,
          cancelScheduler: raf.cancel,
        }),
      {
        initialProps: {
          blocks: [mkBlock('a', 5, 10), mkBlock('b', 20, 25)],
        },
      },
    );
    const before = result.current.cardMetrics;
    const aRef = before.find((m) => m.id === 'a');
    const bRef = before.find((m) => m.id === 'b');
    expect(aRef).toBeDefined();
    expect(bRef).toBeDefined();

    // Change only block 'a''s row range; 'b' should keep the same reference.
    rerender({
      blocks: [mkBlock('a', 6, 11), mkBlock('b', 20, 25)],
    });
    act(() => raf.tickAll());
    const after = result.current.cardMetrics;
    expect(after.find((m) => m.id === 'b')).toBe(bRef);
    expect(after.find((m) => m.id === 'a')).not.toBe(aRef);
  });

  it('marks blocks with startRow < baseRowId as visible: false (evicted)', () => {
    const raf = makeFakeRaf();
    const { result } = renderHook(() =>
      useRowRangeTracker({
        blocks: [mkBlock('gone', 5, 10), mkBlock('here', 150, 160)],
        baseRowId: 100,
        rowCount: 100,
        cellHeightPx: 16,
        scheduler: raf.schedule,
        cancelScheduler: raf.cancel,
      }),
    );
    const gone = result.current.cardMetrics.find((m) => m.id === 'gone');
    const here = result.current.cardMetrics.find((m) => m.id === 'here');
    expect(gone?.visible).toBe(false);
    expect(here?.visible).toBe(true);
    expect(here?.topPx).toBe((150 - 100) * 16);
  });

  it('honours topOffsetPx in the projected topPx', () => {
    const raf = makeFakeRaf();
    const { result } = renderHook(() =>
      useRowRangeTracker({
        blocks: [mkBlock('a', 3, 8)],
        baseRowId: 0,
        rowCount: 50,
        cellHeightPx: 16,
        topOffsetPx: 24,
        scheduler: raf.schedule,
        cancelScheduler: raf.cancel,
      }),
    );
    expect(result.current.cardMetrics[0]!.topPx).toBe(3 * 16 + 24);
  });

  it('cancels pending rAF on unmount', () => {
    const raf = makeFakeRaf();
    const { rerender, unmount } = renderHook(
      ({ baseRowId }: { baseRowId: number }) =>
        useRowRangeTracker({
          blocks: [mkBlock('a', 5, 10)],
          baseRowId,
          rowCount: 50,
          cellHeightPx: 16,
          scheduler: raf.schedule,
          cancelScheduler: raf.cancel,
        }),
      { initialProps: { baseRowId: 0 } },
    );
    // Arm a frame.
    rerender({ baseRowId: 1 });
    expect(raf.pendingCount()).toBe(1);
    // Unmount should cancel it.
    unmount();
    expect(raf.cancelledCount()).toBeGreaterThanOrEqual(1);
    // Residual tick is a no-op (the cancelled entry is skipped).
    expect(() => raf.tickAll()).not.toThrow();
  });

  it('reacts to tickVersion bumps even when nothing else changed', () => {
    const raf = makeFakeRaf();
    const { result, rerender } = renderHook(
      ({ tickVersion }: { tickVersion: number }) =>
        useRowRangeTracker({
          blocks: [mkBlock('a', 5, 10)],
          baseRowId: 0,
          rowCount: 50,
          cellHeightPx: 16,
          tickVersion,
          scheduler: raf.schedule,
          cancelScheduler: raf.cancel,
        }),
      { initialProps: { tickVersion: 0 } },
    );
    act(() => raf.tickAll());
    const before = result.current.frameCount;
    // Change tickVersion only — inputs otherwise identical. The recompute
    // runs but the result is identical, so frameCount stays flat.
    rerender({ tickVersion: 1 });
    // Effect should schedule a fresh rAF since deps changed.
    expect(raf.pendingCount()).toBeGreaterThanOrEqual(1);
    act(() => raf.tickAll());
    expect(result.current.frameCount).toBe(before);
  });

  it('falls back to setTimeout when requestAnimationFrame is absent', () => {
    const origRaf = globalThis.requestAnimationFrame;
    const origCaf = globalThis.cancelAnimationFrame;
    // @ts-expect-error — simulate a jsdom without rAF.
    delete globalThis.requestAnimationFrame;
    // @ts-expect-error — simulate a jsdom without cAF.
    delete globalThis.cancelAnimationFrame;
    try {
      // Should not throw on mount / unmount even without rAF globals.
      const { result, unmount } = renderHook(() =>
        useRowRangeTracker({
          blocks: [mkBlock('a', 5, 10)],
          baseRowId: 0,
          rowCount: 50,
          cellHeightPx: 16,
        }),
      );
      expect(result.current.cardMetrics).toHaveLength(1);
      expect(() => unmount()).not.toThrow();
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCaf;
    }
  });

  it('returns an empty array when blocks is empty', () => {
    const raf = makeFakeRaf();
    const { result } = renderHook(() =>
      useRowRangeTracker({
        blocks: [],
        baseRowId: 0,
        rowCount: 0,
        cellHeightPx: 16,
        scheduler: raf.schedule,
        cancelScheduler: raf.cancel,
      }),
    );
    expect(result.current.cardMetrics).toHaveLength(0);
  });
});

describe('computeCardMetrics — pure', () => {
  it('maps a visible block to a rect', () => {
    const out = computeCardMetrics(
      [mkBlock('a', 5, 10)],
      0,
      50,
      16,
      0,
      null,
    );
    expect(out[0]).toEqual({
      id: 'a',
      topPx: 80,
      heightPx: 80,
      visible: true,
    });
  });

  it('returns visible: false for evicted blocks', () => {
    const out = computeCardMetrics(
      [mkBlock('a', 5, 10)],
      100,
      50,
      16,
      0,
      null,
    );
    expect(out[0]!.visible).toBe(false);
    expect(out[0]!.topPx).toBe(0);
    expect(out[0]!.heightPx).toBe(0);
  });

  it('reuses prior reference when the rect is unchanged', () => {
    const prior: CardMetric[] = [
      { id: 'a', topPx: 80, heightPx: 80, visible: true },
    ];
    const next = computeCardMetrics(
      [mkBlock('a', 5, 10)],
      0,
      50,
      16,
      0,
      prior,
    );
    expect(next[0]).toBe(prior[0]);
  });

  it('produces a new reference when the rect changes', () => {
    const prior: CardMetric[] = [
      { id: 'a', topPx: 80, heightPx: 80, visible: true },
    ];
    const next = computeCardMetrics(
      [mkBlock('a', 5, 11)],
      0,
      50,
      16,
      0,
      prior,
    );
    expect(next[0]).not.toBe(prior[0]);
    expect(next[0]!.heightPx).toBe(96); // 6 * 16
  });
});

describe('metricEqual / metricsArrayEqual', () => {
  it('is true for identical metrics', () => {
    const a: CardMetric = { id: 'x', topPx: 10, heightPx: 20, visible: true };
    const b: CardMetric = { id: 'x', topPx: 10, heightPx: 20, visible: true };
    expect(metricEqual(a, b)).toBe(true);
  });

  it('is false when any field differs', () => {
    const base: CardMetric = {
      id: 'x',
      topPx: 10,
      heightPx: 20,
      visible: true,
    };
    expect(metricEqual(base, { ...base, topPx: 11 })).toBe(false);
    expect(metricEqual(base, { ...base, heightPx: 21 })).toBe(false);
    expect(metricEqual(base, { ...base, visible: false })).toBe(false);
    expect(metricEqual(base, { ...base, id: 'y' })).toBe(false);
  });

  it('array equal short-circuits on identical reference', () => {
    const arr: CardMetric[] = [
      { id: 'x', topPx: 0, heightPx: 0, visible: false },
    ];
    expect(metricsArrayEqual(arr, arr)).toBe(true);
  });

  it('array equal is false when lengths differ', () => {
    const a: CardMetric[] = [
      { id: 'x', topPx: 0, heightPx: 0, visible: false },
    ];
    const b: CardMetric[] = [
      ...a,
      { id: 'y', topPx: 0, heightPx: 0, visible: false },
    ];
    expect(metricsArrayEqual(a, b)).toBe(false);
  });

  it('array equal diffs position-by-position', () => {
    const a: CardMetric[] = [
      { id: 'x', topPx: 0, heightPx: 0, visible: false },
      { id: 'y', topPx: 0, heightPx: 0, visible: false },
    ];
    const b: CardMetric[] = [
      { id: 'y', topPx: 0, heightPx: 0, visible: false },
      { id: 'x', topPx: 0, heightPx: 0, visible: false },
    ];
    // Order matters: same contents but swapped ids → not equal.
    expect(metricsArrayEqual(a, b)).toBe(false);
  });
});

/**
 * Plan 0005 P1-C polish — rAF-synced row-range tracker.
 *
 * React hook that owns the overlay's projection cadence: it watches the
 * scrollback window (`baseRowId` / `rowCount`), the cell metrics
 * (`cellHeightPx` / `topOffsetPx`), and the set of blocks, then produces a
 * stable `cardMetrics` array whose entries re-identify only when a block's
 * projected rect actually changes.
 *
 * Why a hook and not inline `useMemo`?
 * ------------------------------------
 * 1. rAF batching. Scroll / resize events can fire faster than 60 Hz
 *    (touchpad fling, smooth scroll, DevTools layout churn). We coalesce
 *    every observed change into at-most one recompute per frame so the
 *    overlay never pays for more paint work than the grid itself.
 * 2. Stable identity per card. When only the ring's `baseRowId` shifts by
 *    one row but a block's metrics (top, height, visible) stay the same —
 *    e.g. the block is still evicted, or the cursor hasn't advanced into a
 *    new row — the hook returns the PRIOR entry by reference. That lets a
 *    memoized `BlockOverlayCard` skip its render path entirely.
 * 3. Testable seam. The hook accepts an injected `scheduler` / `cancel`
 *    pair and an optional `now()` clock so unit tests can tick it
 *    deterministically without jsdom's unreliable rAF.
 *
 * The hook does NOT subscribe to the store directly — it takes the current
 * blocks as a prop. Composition: `BlockOverlayHost` reads the store, passes
 * the read-only view into the hook, forwards the resulting cardMetrics to
 * `BlockOverlay`. This split keeps the store-coupling in a single layer.
 *
 * Not the overlay's private projection function:
 * ---------------------------------------------
 * The pure `projectRowRange()` in BlockOverlay.tsx computes a single rect
 * from a range. This hook wraps that, adds rAF batching, and emits an
 * array of `{ id, topPx, heightPx, visible }` — including evicted blocks
 * (as `visible: false`) so the consumer can decide whether to animate
 * them out or skip entirely. The overlay currently drops invisible cards
 * from the DOM; the eviction banner consumes the visibility transitions
 * via a different selector.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BlockRowRange } from '../../entities/block/index.js';
import { projectRowRange } from './BlockOverlay.js';

/**
 * A single block's projected rect. Reference-stable across ticks when none
 * of the four fields change: consumers can use `Object.is` / `===` to skip
 * downstream work.
 */
export interface CardMetric {
  readonly id: string;
  readonly topPx: number;
  readonly heightPx: number;
  readonly visible: boolean;
}

/**
 * The minimum shape the tracker needs from a block. Intentionally narrower
 * than `BlockOverlayItem` so tests can drive the hook with tiny fixtures.
 */
export interface TrackableBlock {
  readonly id: string;
  readonly rowRange: BlockRowRange;
}

export interface UseRowRangeTrackerOptions {
  readonly blocks: readonly TrackableBlock[];
  readonly baseRowId: number;
  readonly rowCount: number;
  readonly cellHeightPx: number;
  readonly topOffsetPx?: number;
  /**
   * Optional external trigger bumped on every scroll / resize / engine
   * tick. When the value changes between renders, the tracker schedules a
   * rAF recompute. The concrete integer value is opaque — hosts pass a
   * monotonically increasing counter or a version number; the tracker only
   * cares about inequality.
   */
  readonly tickVersion?: number;
  /** Test-only scheduler (defaults to `requestAnimationFrame`). */
  readonly scheduler?: (cb: () => void) => number;
  /** Test-only canceller (defaults to `cancelAnimationFrame`). */
  readonly cancelScheduler?: (id: number) => void;
}

export interface UseRowRangeTrackerResult {
  readonly cardMetrics: readonly CardMetric[];
  /**
   * Monotonic frame counter — each time the tracker actually produced a
   * new `cardMetrics` array, this increments. Useful for perf benchmarks
   * that measure "did we recompute?" without diffing the array by hand.
   */
  readonly frameCount: number;
}

function defaultScheduler(cb: () => void): number {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(cb);
  }
  return setTimeout(cb, 16) as unknown as number;
}

function defaultCancel(id: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(id);
    return;
  }
  clearTimeout(id as unknown as ReturnType<typeof setTimeout>);
}

/**
 * Shallow-equal two card metrics; `Object.is` on every field.
 */
function metricEqual(a: CardMetric, b: CardMetric): boolean {
  return (
    a.id === b.id &&
    a.topPx === b.topPx &&
    a.heightPx === b.heightPx &&
    a.visible === b.visible
  );
}

/**
 * Shallow-equal two CardMetric arrays by position AND reference of each
 * entry. Fast-path: same array reference → equal. When lengths differ or
 * any entry disagrees, returns false.
 */
function metricsArrayEqual(
  a: readonly CardMetric[],
  b: readonly CardMetric[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ai = a[i];
    const bi = b[i];
    if (ai === undefined || bi === undefined) return false;
    if (!metricEqual(ai, bi)) return false;
  }
  return true;
}

/**
 * Compute a fresh CardMetric array from inputs. Pure — does not touch React
 * state; the hook wraps this so it can diff and conditionally `setState`.
 *
 * Previously-computed entries are re-used by reference when the new rect
 * equals the old one; this keeps memoized children (e.g.
 * `BlockOverlayCard`) from re-rendering on ticks that didn't change their
 * visual output.
 */
function computeCardMetrics(
  blocks: readonly TrackableBlock[],
  baseRowId: number,
  rowCount: number,
  cellHeightPx: number,
  topOffsetPx: number,
  prev: readonly CardMetric[] | null,
): CardMetric[] {
  const prevById = new Map<string, CardMetric>();
  if (prev !== null) {
    for (const m of prev) prevById.set(m.id, m);
  }
  const out: CardMetric[] = [];
  for (const b of blocks) {
    const rect = projectRowRange(
      b.rowRange,
      baseRowId,
      rowCount,
      cellHeightPx,
      topOffsetPx,
    );
    const next: CardMetric =
      rect === null
        ? { id: b.id, topPx: 0, heightPx: 0, visible: false }
        : {
            id: b.id,
            topPx: rect.top,
            heightPx: rect.height,
            visible: true,
          };
    const prior = prevById.get(b.id);
    if (prior !== undefined && metricEqual(prior, next)) {
      // Reuse the prior reference so children memoized on `===` skip
      // re-render.
      out.push(prior);
    } else {
      out.push(next);
    }
  }
  return out;
}

/**
 * rAF-synced tracker for overlay card rects.
 *
 * Contract
 * --------
 *   - Inputs are consumed synchronously during render; the hook schedules
 *     AT MOST one rAF per "burst" of prop changes. If the consumer re-
 *     renders three times in the same frame with different inputs, only
 *     the final computation runs. Callers relying on intermediate states
 *     (none do today) would have to force synchronous work elsewhere.
 *   - On mount, the first cardMetrics snapshot is produced synchronously
 *     so SSR / the initial paint see correct positions — the rAF-batching
 *     kicks in only for SUBSEQUENT updates.
 *   - On unmount the tracker cancels any pending rAF handle; there are no
 *     dangling callbacks.
 */
export function useRowRangeTracker(
  options: UseRowRangeTrackerOptions,
): UseRowRangeTrackerResult {
  const {
    blocks,
    baseRowId,
    rowCount,
    cellHeightPx,
    topOffsetPx = 0,
    tickVersion = 0,
    scheduler = defaultScheduler,
    cancelScheduler = defaultCancel,
  } = options;

  // Synchronous initial snapshot — SSR / initial paint correctness.
  const [state, setState] = useState<{
    metrics: readonly CardMetric[];
    frame: number;
  }>(() => ({
    metrics: computeCardMetrics(
      blocks,
      baseRowId,
      rowCount,
      cellHeightPx,
      topOffsetPx,
      null,
    ),
    frame: 0,
  }));

  // Latest inputs — captured into refs so the scheduled rAF callback uses
  // the freshest data even if the component re-rendered with new props
  // between the schedule and the flush.
  const inputsRef = useRef({
    blocks,
    baseRowId,
    rowCount,
    cellHeightPx,
    topOffsetPx,
  });
  inputsRef.current = {
    blocks,
    baseRowId,
    rowCount,
    cellHeightPx,
    topOffsetPx,
  };

  // rAF handle for the batched recompute. `null` means no frame scheduled.
  const rafRef = useRef<number | null>(null);
  const disposedRef = useRef(false);

  // Previous snapshot — used to reuse per-card references inside the next
  // compute, AND to decide whether setState is worth paying for.
  const prevRef = useRef(state.metrics);
  prevRef.current = state.metrics;

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      if (rafRef.current !== null) {
        cancelScheduler(rafRef.current);
        rafRef.current = null;
      }
    };
    // `cancelScheduler` is stable by contract; changing it between mounts
    // is a test concern and covered by explicit test fixtures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Schedule exactly one rAF. If a prior rAF is still pending we reuse
    // it — the callback reads the freshest inputs via `inputsRef`. This is
    // the batching guarantee: N prop changes between frames produce 1
    // recompute.
    if (rafRef.current !== null) return;
    rafRef.current = scheduler(() => {
      rafRef.current = null;
      if (disposedRef.current) return;
      const inp = inputsRef.current;
      const next = computeCardMetrics(
        inp.blocks,
        inp.baseRowId,
        inp.rowCount,
        inp.cellHeightPx,
        inp.topOffsetPx,
        prevRef.current,
      );
      if (metricsArrayEqual(prevRef.current, next)) {
        // No visual change — skip setState to avoid forcing React to
        // reconcile a no-op. `frameCount` deliberately does NOT bump on a
        // no-op tick; consumers asking "did the overlay actually repaint?"
        // use this to filter idle frames out of their perf math.
        return;
      }
      setState((s) => ({ metrics: next, frame: s.frame + 1 }));
    });
    // We intentionally rerun this effect on EVERY prop change: that is
    // how "bump the tracker" is expressed. The scheduler's dedupe prevents
    // more than one rAF from being live at a time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks, baseRowId, rowCount, cellHeightPx, topOffsetPx, tickVersion]);

  return useMemo<UseRowRangeTrackerResult>(
    () => ({ cardMetrics: state.metrics, frameCount: state.frame }),
    [state.metrics, state.frame],
  );
}

// Exposed for tests — pure helpers useful as isolated verification seams.
export { computeCardMetrics, metricEqual, metricsArrayEqual };

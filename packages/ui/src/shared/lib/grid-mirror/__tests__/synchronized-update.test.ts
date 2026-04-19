/**
 * White-box unit tests for `SyncUpdateWindow` — the DECSET 2026 sync-window
 * primitive exported from `synchronized-update.ts`.
 *
 * These assertions isolate the helper from `GridMirror` so that behavior such
 * as the empty-accumulator end policy, idempotent `begin()`, timer lifecycle,
 * and `reset()`/`dispose()` hygiene are pinned independently of the reducer
 * that consumes them. GridMirror-level flow (Begin suppresses `onChange`;
 * End flushes accumulated rows; 150 ms force-end; snapshot aborts the window)
 * lives in `synchronized_update.test.ts` — intentionally left untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncUpdateWindow } from '../synchronized-update.js';

type Flush = (dirty: ReadonlySet<number>) => void;

function makeWindow(overrides: {
  timeoutMs?: number;
  flush?: Flush;
  onTimeout?: () => void;
} = {}): {
  win: SyncUpdateWindow;
  flush: ReturnType<typeof vi.fn>;
  onTimeout: ReturnType<typeof vi.fn>;
} {
  const flush = vi.fn<Flush>();
  const onTimeout = vi.fn<() => void>();
  const win = new SyncUpdateWindow({
    timeoutMs: overrides.timeoutMs ?? 150,
    flush: overrides.flush ?? flush,
    onTimeout: overrides.onTimeout ?? onTimeout,
  });
  return { win, flush, onTimeout };
}

describe('SyncUpdateWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is closed on construction and accumulator is empty', () => {
    const { win, flush } = makeWindow();
    expect(win.isOpen()).toBe(false);
    // No latent timer; advancing the clock must not trigger any callback.
    vi.advanceTimersByTime(500);
    expect(flush).not.toHaveBeenCalled();
  });

  it('begin() flips isOpen() to true', () => {
    const { win } = makeWindow();
    win.begin();
    expect(win.isOpen()).toBe(true);
  });

  it('begin() while already open is a no-op (does not reset accumulator or timer)', () => {
    const { win, flush, onTimeout } = makeWindow({ timeoutMs: 150 });
    win.begin();
    win.accumulateOrEmit(new Set([1, 2]));

    // Advance to just before the first window would time out.
    vi.advanceTimersByTime(100);
    // A second `begin()` here must NOT extend the deadline, reset the
    // accumulator, nor start a second timer — it is documented idempotent.
    win.begin();
    expect(win.isOpen()).toBe(true);

    // 50 more ms (total 150) → the original timer fires, not a re-armed one.
    vi.advanceTimersByTime(50);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(new Set(flush.mock.calls[0]![0])).toEqual(new Set([1, 2]));
  });

  it('accumulateOrEmit while closed dispatches immediately via flush', () => {
    const { win, flush } = makeWindow();
    const dirty = new Set([5, 9]);
    win.accumulateOrEmit(dirty);
    expect(flush).toHaveBeenCalledTimes(1);
    // Outside-window path is expected to forward the caller's set verbatim.
    expect(flush.mock.calls[0]![0]).toBe(dirty);
  });

  it('accumulateOrEmit while open unions into the internal accumulator (suppressed)', () => {
    const { win, flush } = makeWindow();
    win.begin();
    win.accumulateOrEmit(new Set([0, 1]));
    win.accumulateOrEmit(new Set([1, 2, 3]));
    win.accumulateOrEmit(new Set([4]));
    // Nothing dispatched yet — window is still open.
    expect(flush).not.toHaveBeenCalled();

    win.end();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(new Set(flush.mock.calls[0]![0])).toEqual(new Set([0, 1, 2, 3, 4]));
  });

  it('end() before begin() is a silent no-op', () => {
    const { win, flush, onTimeout } = makeWindow();
    win.end();
    expect(flush).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(win.isOpen()).toBe(false);
  });

  it('end() with an empty accumulator does NOT call flush (policy: skip empty)', () => {
    const { win, flush, onTimeout } = makeWindow();
    win.begin();
    win.end();
    expect(flush).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(win.isOpen()).toBe(false);
  });

  it('end() closes the window and clears the timer (no late timeout fire)', () => {
    const { win, flush, onTimeout } = makeWindow({ timeoutMs: 150 });
    win.begin();
    win.accumulateOrEmit(new Set([7]));
    win.end();
    expect(flush).toHaveBeenCalledTimes(1);
    // Pump the clock well past the original deadline; no timeout path runs.
    vi.advanceTimersByTime(1_000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('150 ms timeout force-ends the window and invokes onTimeout before flush', () => {
    const order: string[] = [];
    const { win, flush, onTimeout } = makeWindow({
      timeoutMs: 150,
      flush: (dirty) => {
        order.push(`flush:${[...dirty].sort((a, b) => a - b).join(',')}`);
      },
      onTimeout: () => {
        order.push('onTimeout');
      },
    });
    void flush;
    void onTimeout;

    win.begin();
    win.accumulateOrEmit(new Set([2, 4]));
    expect(order).toEqual([]);

    // Just under the budget — no fire yet.
    vi.advanceTimersByTime(149);
    expect(order).toEqual([]);

    vi.advanceTimersByTime(1);
    // Telemetry hook precedes the flush callback per implementation contract.
    expect(order).toEqual(['onTimeout', 'flush:2,4']);
    expect(win.isOpen()).toBe(false);
  });

  it('forced timeout with empty accumulator fires onTimeout but skips flush', () => {
    const { win, flush, onTimeout } = makeWindow({ timeoutMs: 150 });
    win.begin();
    vi.advanceTimersByTime(150);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(flush).not.toHaveBeenCalled();
    expect(win.isOpen()).toBe(false);
  });

  it('late end() after timeout is a no-op (no double flush)', () => {
    const { win, flush } = makeWindow({ timeoutMs: 150 });
    win.begin();
    win.accumulateOrEmit(new Set([1]));
    vi.advanceTimersByTime(150);
    expect(flush).toHaveBeenCalledTimes(1);

    // Host delivers the trailing `End` after the force-end has already run.
    win.end();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('post-end accumulateOrEmit routes directly to flush (outside-window path)', () => {
    const { win, flush } = makeWindow();
    win.begin();
    win.accumulateOrEmit(new Set([1]));
    win.end();
    expect(flush).toHaveBeenCalledTimes(1);
    flush.mockClear();

    win.accumulateOrEmit(new Set([9]));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(new Set(flush.mock.calls[0]![0])).toEqual(new Set([9]));
  });

  it('re-begin after timeout starts a fresh window with an empty accumulator', () => {
    const { win, flush } = makeWindow({ timeoutMs: 150 });
    win.begin();
    win.accumulateOrEmit(new Set([1, 2]));
    vi.advanceTimersByTime(150);
    expect(flush).toHaveBeenCalledTimes(1);
    flush.mockClear();

    // Fresh cycle: the old accumulator must not leak across windows.
    win.begin();
    win.accumulateOrEmit(new Set([42]));
    win.end();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(new Set(flush.mock.calls[0]![0])).toEqual(new Set([42]));
  });

  it('respects a custom timeoutMs', () => {
    const { win, flush, onTimeout } = makeWindow({ timeoutMs: 25 });
    win.begin();
    win.accumulateOrEmit(new Set([3]));
    vi.advanceTimersByTime(24);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('onTimeout is optional — absent callback is tolerated', () => {
    const flush = vi.fn();
    const win = new SyncUpdateWindow({ timeoutMs: 150, flush });
    win.begin();
    win.accumulateOrEmit(new Set([1]));
    expect(() => vi.advanceTimersByTime(150)).not.toThrow();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('reset() discards the accumulator and cancels the pending timer', () => {
    const { win, flush, onTimeout } = makeWindow({ timeoutMs: 150 });
    win.begin();
    win.accumulateOrEmit(new Set([10, 11]));
    win.reset();
    expect(win.isOpen()).toBe(false);

    // Neither accumulated rows nor the force-end should ever surface.
    vi.advanceTimersByTime(1_000);
    expect(flush).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();

    // And the instance is reusable.
    win.begin();
    win.accumulateOrEmit(new Set([99]));
    win.end();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(new Set(flush.mock.calls[0]![0])).toEqual(new Set([99]));
  });

  it('dispose() is idempotent and prevents any further timer callback', () => {
    const { win, flush, onTimeout } = makeWindow({ timeoutMs: 150 });
    win.begin();
    win.accumulateOrEmit(new Set([1, 2, 3]));
    win.dispose();
    win.dispose(); // second call must not throw
    expect(win.isOpen()).toBe(false);

    vi.advanceTimersByTime(10_000);
    expect(flush).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

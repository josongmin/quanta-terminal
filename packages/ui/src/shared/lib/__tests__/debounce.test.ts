import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncer } from '../debounce.js';

describe('createDebouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires once after the wait window when called multiple times', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, { wait: 60 });
    d.schedule();
    d.schedule();
    d.schedule();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(59);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('caps deferral at maxWait even if calls keep coming', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, { wait: 60, maxWait: 200 });
    // Simulate a continuous drag: schedule every 20ms for 300ms.
    for (let t = 0; t < 300; t += 20) {
      d.schedule();
      vi.advanceTimersByTime(20);
    }
    // maxWait caps at 200ms; fn must have fired at least once.
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('cancel() drops the pending call and prevents the callback', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, { wait: 60 });
    d.schedule();
    expect(d.isPending).toBe(true);
    d.cancel();
    expect(d.isPending).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('flush() invokes the callback immediately when pending', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, { wait: 60 });
    d.schedule();
    d.flush();
    expect(fn).toHaveBeenCalledTimes(1);
    // And clears pending so timer firing doesn't double-invoke.
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('flush() is a no-op when nothing is pending', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, { wait: 60 });
    d.flush();
    expect(fn).not.toHaveBeenCalled();
  });

  it('leading:true fires once immediately and once at the trailing edge', () => {
    const fn = vi.fn();
    const d = createDebouncer(fn, { wait: 60, leading: true });
    d.schedule();
    expect(fn).toHaveBeenCalledTimes(1);
    d.schedule();
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

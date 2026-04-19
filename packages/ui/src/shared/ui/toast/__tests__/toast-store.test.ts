/**
 * Toast store tests — audit P1 (fix 5) infrastructure.
 *
 * The store itself is small; this suite locks in:
 *   - pushToast returns a monotonic id; items accumulate in order.
 *   - dismissToast removes by id and is a no-op for unknowns.
 *   - showToast auto-schedules dismissal with a default 4s timeout.
 *   - showToast with durationMs <= 0 does not schedule dismissal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOAST_DURATION_MS,
  showToast,
  useToastStore,
} from '../toast-store.js';

beforeEach(() => {
  useToastStore.getState().clearAll();
});

afterEach(() => {
  vi.useRealTimers();
  useToastStore.getState().clearAll();
});

describe('useToastStore', () => {
  it('pushToast appends items and returns monotonic ids', () => {
    const a = useToastStore.getState().pushToast({
      kind: 'info',
      message: 'first',
      durationMs: 1000,
    });
    const b = useToastStore.getState().pushToast({
      kind: 'warning',
      message: 'second',
      durationMs: 1000,
    });
    expect(b).toBeGreaterThan(a);
    const items = useToastStore.getState().items;
    expect(items).toHaveLength(2);
    expect(items[0]?.message).toBe('first');
    expect(items[1]?.message).toBe('second');
  });

  it('dismissToast removes by id and is a no-op for unknowns', () => {
    const id = useToastStore.getState().pushToast({
      kind: 'info',
      message: 'x',
      durationMs: 1000,
    });
    useToastStore.getState().dismissToast(999_999);
    expect(useToastStore.getState().items).toHaveLength(1);
    useToastStore.getState().dismissToast(id);
    expect(useToastStore.getState().items).toHaveLength(0);
  });
});

describe('showToast (auto-dismiss)', () => {
  it('schedules auto-dismiss at the default duration', () => {
    vi.useFakeTimers();
    showToast({ kind: 'warning', message: 'fades away' });
    expect(useToastStore.getState().items).toHaveLength(1);
    vi.advanceTimersByTime(DEFAULT_TOAST_DURATION_MS - 1);
    expect(useToastStore.getState().items).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(useToastStore.getState().items).toHaveLength(0);
  });

  it('honors an explicit durationMs', () => {
    vi.useFakeTimers();
    showToast({ kind: 'info', message: 'short', durationMs: 100 });
    vi.advanceTimersByTime(99);
    expect(useToastStore.getState().items).toHaveLength(1);
    vi.advanceTimersByTime(2);
    expect(useToastStore.getState().items).toHaveLength(0);
  });

  it('does NOT schedule when durationMs <= 0 (manual-dismiss mode)', () => {
    vi.useFakeTimers();
    showToast({ kind: 'danger', message: 'sticky', durationMs: 0 });
    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().items).toHaveLength(1);
  });
});

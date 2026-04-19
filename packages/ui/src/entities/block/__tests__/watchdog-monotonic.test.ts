/**
 * Audit P0 (fix 5) — watchdog uses monotonic time (`performance.now`) for
 * interval scheduling, not wall-clock `Date.now`. A system-clock jump
 * backward (NTP sync, DST, suspend/resume) must not dodge or delay the
 * watchdog.
 *
 * The block's `startedAt` / `completedAt` fields remain wall-clock (user-
 * visible timestamps), but the armed-at checkpoint in the watchdog handle
 * is monotonic, and the fired callback validates elapsed time against the
 * monotonic clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_BLOCK_WATCHDOG_MS, useBlockStore } from '../model.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('watchdog — monotonic clock (fix 5)', () => {
  it('fires after the configured interval under fake timers', () => {
    vi.useFakeTimers();
    const id = useBlockStore.getState().startBlock('sleep 9', '/', { watchdogMs: 5_000 });
    expect(useBlockStore.getState().entities[id]?.status).toBe('running');

    vi.advanceTimersByTime(5_000);

    const b = useBlockStore.getState().entities[id];
    expect(b?.status).toBe('error');
    expect(b?.errorMessage).toMatch(/timed out/iu);
  });

  it('does NOT fire before the interval elapses', () => {
    vi.useFakeTimers();
    const id = useBlockStore.getState().startBlock('sleep 9', '/', { watchdogMs: 5_000 });
    vi.advanceTimersByTime(4_999);
    expect(useBlockStore.getState().entities[id]?.status).toBe('running');
  });

  it('remains correct across a simulated system-clock backward jump', () => {
    // Fake timers control `setTimeout` AND `Date` — but the monotonic
    // clock (`performance.now`) is independent. We simulate a wall-clock
    // jump by setting the system time back by an hour mid-run; the timer
    // and the monotonic elapsed check should both be unaffected because
    // fake timers advance monotonically via `advanceTimersByTime`.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
    const id = useBlockStore.getState().startBlock('sleep 9', '/', { watchdogMs: 5_000 });
    vi.advanceTimersByTime(2_500);
    // Mid-run clock jump backward one hour.
    vi.setSystemTime(new Date('2024-12-31T23:02:30Z'));
    vi.advanceTimersByTime(2_500);
    // After 5s of simulated time the watchdog should have fired regardless
    // of the wall-clock reversal.
    expect(useBlockStore.getState().entities[id]?.status).toBe('error');
  });

  it('late-firing timer on a block that already completed is a no-op (combined with fix 1)', () => {
    vi.useFakeTimers();
    const id = useBlockStore.getState().startBlock('true', '/', { watchdogMs: 5_000 });
    useBlockStore.getState().completeBlock(id, 0);
    // Even if we naively advance past the watchdog deadline, the stored
    // timer was cleared by completeBlock. Advancing therefore has no
    // effect — the block stays `completed` with exit 0. (This combines
    // fix 1's guard with fix 5's timing: even if we tried to short-circuit
    // clearWatchdog, the errorBlock guard would still refuse to mutate.)
    vi.advanceTimersByTime(10_000);
    const b = useBlockStore.getState().entities[id];
    expect(b?.status).toBe('completed');
    expect(b?.exitCode).toBe(0);
  });

  it('default watchdog timeout is DEFAULT_BLOCK_WATCHDOG_MS', () => {
    vi.useFakeTimers();
    const id = useBlockStore.getState().startBlock('sleep 9', '/');
    vi.advanceTimersByTime(DEFAULT_BLOCK_WATCHDOG_MS - 1);
    expect(useBlockStore.getState().entities[id]?.status).toBe('running');
    vi.advanceTimersByTime(2);
    expect(useBlockStore.getState().entities[id]?.status).toBe('error');
  });
});

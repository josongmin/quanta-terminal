/**
 * TUI store — state transition tests.
 *
 * Covers the store contract the TUI feature relies on:
 *   - enter/exit flip `active` and timestamp `enteredAt`.
 *   - enter is idempotent — a second enter without an intervening exit
 *     keeps the original `enteredAt`, so nested alt-screen apps don't
 *     restart the session clock.
 *   - exit clears `enteredAt`.
 *   - reset returns to the initial state.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTuiStore } from '../model.js';

beforeEach(() => {
  useTuiStore.getState().reset();
  vi.useRealTimers();
});

describe('tui store', () => {
  it('starts inactive with no enteredAt', () => {
    const s = useTuiStore.getState();
    expect(s.active).toBe(false);
    expect(s.enteredAt).toBeNull();
  });

  it('enter flips active and records the entry timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T10:00:00Z'));
    useTuiStore.getState().enter();
    const s = useTuiStore.getState();
    expect(s.active).toBe(true);
    expect(s.enteredAt).toBe(new Date('2026-04-19T10:00:00Z').getTime());
  });

  it('enter is idempotent — repeated enter does not bump enteredAt', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T10:00:00Z'));
    useTuiStore.getState().enter();
    const first = useTuiStore.getState().enteredAt;
    vi.setSystemTime(new Date('2026-04-19T10:00:05Z'));
    useTuiStore.getState().enter();
    expect(useTuiStore.getState().enteredAt).toBe(first);
  });

  it('exit clears the active flag and the timestamp', () => {
    useTuiStore.getState().enter();
    useTuiStore.getState().exit();
    const s = useTuiStore.getState();
    expect(s.active).toBe(false);
    expect(s.enteredAt).toBeNull();
  });

  it('exit when already inactive is a no-op', () => {
    // Before any enter, exit must be safe to call.
    useTuiStore.getState().exit();
    expect(useTuiStore.getState().active).toBe(false);
  });

  it('reset returns to the initial state', () => {
    useTuiStore.getState().enter();
    useTuiStore.getState().reset();
    const s = useTuiStore.getState();
    expect(s.active).toBe(false);
    expect(s.enteredAt).toBeNull();
  });
});

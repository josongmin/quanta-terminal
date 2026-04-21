/**
 * Unit tests for the bell store.
 *
 * Three things need to hold:
 *   1. `trigger()` advances `bellCount` and sets `lastBellAt`.
 *   2. Bells within `BELL_THROTTLE_MS` of the previous accepted bell are
 *      swallowed (bellCount does not advance).
 *   3. `reset()` returns the store to its initial shape.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useBellStore, BELL_THROTTLE_MS } from '../model.js';

describe('bell store', () => {
  beforeEach(() => {
    useBellStore.getState().reset();
  });

  it('starts at bellCount=0 with lastBellAt=null', () => {
    const s = useBellStore.getState();
    expect(s.bellCount).toBe(0);
    expect(s.lastBellAt).toBeNull();
  });

  it('trigger advances bellCount and records timestamp', () => {
    const accepted = useBellStore.getState().trigger(1000);
    expect(accepted).toBe(true);
    const s = useBellStore.getState();
    expect(s.bellCount).toBe(1);
    expect(s.lastBellAt).toBe(1000);
  });

  it('collapses bells within throttle window', () => {
    const store = useBellStore.getState();
    store.trigger(1000);
    // Inside the throttle window — must be swallowed.
    const a2 = useBellStore.getState().trigger(1000 + BELL_THROTTLE_MS - 1);
    expect(a2).toBe(false);
    expect(useBellStore.getState().bellCount).toBe(1);
    expect(useBellStore.getState().lastBellAt).toBe(1000);
  });

  it('accepts bells outside the throttle window', () => {
    useBellStore.getState().trigger(1000);
    const a2 = useBellStore.getState().trigger(1000 + BELL_THROTTLE_MS);
    expect(a2).toBe(true);
    expect(useBellStore.getState().bellCount).toBe(2);
    expect(useBellStore.getState().lastBellAt).toBe(1000 + BELL_THROTTLE_MS);
  });

  it('reset clears count and timestamp', () => {
    useBellStore.getState().trigger(1000);
    useBellStore.getState().trigger(1100);
    expect(useBellStore.getState().bellCount).toBe(2);
    useBellStore.getState().reset();
    const s = useBellStore.getState();
    expect(s.bellCount).toBe(0);
    expect(s.lastBellAt).toBeNull();
  });
});

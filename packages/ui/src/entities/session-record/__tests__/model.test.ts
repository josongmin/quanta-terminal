/**
 * session-record/model — zustand store transitions.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useSessionRecordStore } from '../model.js';

beforeEach(() => {
  useSessionRecordStore.getState().reset();
});

describe('useSessionRecordStore', () => {
  it('starts idle', () => {
    const s = useSessionRecordStore.getState();
    expect(s.recording).toBe(false);
    expect(s.sessionId).toBeNull();
    expect(s.startedAtMs).toBe(0);
    expect(s.elapsedSec).toBe(0);
    expect(s.byteCount).toBe(0);
  });

  it('begin() flips recording and stamps startedAtMs', () => {
    const before = Date.now();
    useSessionRecordStore.getState().begin('session-1');
    const s = useSessionRecordStore.getState();
    expect(s.recording).toBe(true);
    expect(s.sessionId).toBe('session-1');
    expect(s.startedAtMs).toBeGreaterThanOrEqual(before);
  });

  it('tick() updates counters while recording', () => {
    useSessionRecordStore.getState().begin('session-1');
    useSessionRecordStore.getState().tick(3.5, 1024);
    const s = useSessionRecordStore.getState();
    expect(s.elapsedSec).toBe(3.5);
    expect(s.byteCount).toBe(1024);
  });

  it('tick() is a no-op when idle', () => {
    useSessionRecordStore.getState().tick(10, 9999);
    const s = useSessionRecordStore.getState();
    expect(s.elapsedSec).toBe(0);
    expect(s.byteCount).toBe(0);
  });

  it('end() returns to the initial idle snapshot', () => {
    useSessionRecordStore.getState().begin('session-1');
    useSessionRecordStore.getState().tick(1, 10);
    useSessionRecordStore.getState().end();
    const s = useSessionRecordStore.getState();
    expect(s.recording).toBe(false);
    expect(s.sessionId).toBeNull();
    expect(s.elapsedSec).toBe(0);
    expect(s.byteCount).toBe(0);
  });

  it('tick() with unchanged values is identity (no extra subscriber notifications)', () => {
    useSessionRecordStore.getState().begin('session-1');
    useSessionRecordStore.getState().tick(2, 50);
    const first = useSessionRecordStore.getState();
    useSessionRecordStore.getState().tick(2, 50);
    const second = useSessionRecordStore.getState();
    expect(second).toBe(first);
  });
});

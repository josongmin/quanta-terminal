/**
 * Detector tests — ensures a long-running block completion fires exactly
 * one notification when the window is hidden, and doesn't fire when any of
 * the three gates (enabled / duration / hidden) fail.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { installNotificationDetector } from '../detector.js';
import {
  DEFAULT_LONG_RUN_THRESHOLD_MS,
  NOTIFY_STORAGE_KEY,
  useNotifySettings,
} from '../settings.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
  try {
    localStorage.removeItem(NOTIFY_STORAGE_KEY);
  } catch {
    // ignore
  }
  useNotifySettings.getState().setEnabled(true);
  useNotifySettings.getState().setThresholdMs(DEFAULT_LONG_RUN_THRESHOLD_MS);
});

afterEach(() => {
  useBlockStore.getState().resetAll();
});

function completedLongRunning(id: string): void {
  // Force the startedAt back in time so the duration exceeds threshold.
  const state = useBlockStore.getState();
  const b = state.entities[id];
  if (!b) throw new Error('missing block');
  // Direct state mutation via zustand's set: simplest way to age a block.
  useBlockStore.setState({
    entities: {
      ...state.entities,
      [id]: { ...b, startedAt: Date.now() - (DEFAULT_LONG_RUN_THRESHOLD_MS + 1000) },
    },
  });
}

describe('notification detector', () => {
  it('fires a notification when a long-running block finishes while hidden', async () => {
    const post = vi.fn(async (_msg: string) => {});
    const handle = installNotificationDetector({
      isHidden: () => true,
      postNotification: post,
    });
    const id = useBlockStore.getState().createBlock('big-build', '/');
    completedLongRunning(id);
    useBlockStore.getState().completeBlock(id, 0);
    // Await a microtask so the Promise.resolve wrapper runs.
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
    const msg = post.mock.calls[0]?.[0] ?? '';
    expect(msg).toMatch(/exit 0/iu);
    handle.unsubscribe();
  });

  it('does NOT fire when the window is visible', async () => {
    const post = vi.fn(async (_msg: string) => {});
    const handle = installNotificationDetector({
      isHidden: () => false,
      postNotification: post,
    });
    const id = useBlockStore.getState().createBlock('big-build', '/');
    completedLongRunning(id);
    useBlockStore.getState().completeBlock(id, 0);
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    handle.unsubscribe();
  });

  it('does NOT fire for short-duration blocks', async () => {
    const post = vi.fn(async (_msg: string) => {});
    const handle = installNotificationDetector({
      isHidden: () => true,
      postNotification: post,
    });
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().completeBlock(id, 0);
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    handle.unsubscribe();
  });

  it('does NOT fire when notifications are disabled', async () => {
    useNotifySettings.getState().setEnabled(false);
    const post = vi.fn(async (_msg: string) => {});
    const handle = installNotificationDetector({
      isHidden: () => true,
      postNotification: post,
    });
    const id = useBlockStore.getState().createBlock('big-build', '/');
    completedLongRunning(id);
    useBlockStore.getState().completeBlock(id, 0);
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    handle.unsubscribe();
  });

  it('fires exactly once per block (no double-fire on follow-up store updates)', async () => {
    const post = vi.fn(async (_msg: string) => {});
    const handle = installNotificationDetector({
      isHidden: () => true,
      postNotification: post,
    });
    const id = useBlockStore.getState().createBlock('big-build', '/');
    completedLongRunning(id);
    useBlockStore.getState().completeBlock(id, 0);
    // Trigger another store update — pinning doesn't change status.
    useBlockStore.getState().togglePin(id);
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
    handle.unsubscribe();
  });

  it('fires for error-status blocks as well as completed', async () => {
    const post = vi.fn(async (_msg: string) => {});
    const handle = installNotificationDetector({
      isHidden: () => true,
      postNotification: post,
    });
    const id = useBlockStore.getState().createBlock('bad', '/');
    completedLongRunning(id);
    useBlockStore.getState().errorBlock(id, 'spawn failed');
    await Promise.resolve();
    expect(post).toHaveBeenCalledTimes(1);
    handle.unsubscribe();
  });

  it('unsubscribe() stops further notifications', async () => {
    const post = vi.fn(async (_msg: string) => {});
    const handle = installNotificationDetector({
      isHidden: () => true,
      postNotification: post,
    });
    handle.unsubscribe();
    const id = useBlockStore.getState().createBlock('big-build', '/');
    completedLongRunning(id);
    useBlockStore.getState().completeBlock(id, 0);
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
  });
});

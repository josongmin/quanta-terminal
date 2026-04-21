/**
 * rerunChildByParent index + useBlockSuccessor tests.
 *
 * Replaces the former O(n) `hasSuccessor` scan inside BlockCard with a
 * store-maintained parent→latest-rerun-child map. The invariants asserted
 * here:
 *
 *   - `startBlock({ rerunOf: parent })` registers `child` as
 *     `rerunChildByParent[parent]`.
 *   - A later rerun of the same parent overwrites the entry so the
 *     Compare gate always sees the newest descendant.
 *   - `createBlock({ rerunOf: parent })` behaves identically.
 *   - `clearHistory` drops entries whose parent was evicted, but keeps
 *     entries whose PARENT and CHILD both survived (pinned reruns).
 *   - `hydrateBlocks` rebuilds the index from scratch.
 *   - `resetAll` wipes the index.
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useBlockStore } from '../model.js';
import { useBlockSuccessor } from '../selectors.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('rerunChildByParent + useBlockSuccessor', () => {
  it('startBlock with rerunOf registers the child in the index', () => {
    const parent = useBlockStore.getState().startBlock('ls', '/');
    const child = useBlockStore
      .getState()
      .startBlock('ls', '/', { rerunOf: parent });
    expect(useBlockStore.getState().rerunChildByParent[parent]).toBe(child);
  });

  it('useBlockSuccessor returns the registered child id', () => {
    const parent = useBlockStore.getState().startBlock('ls', '/');
    const { result, rerender } = renderHook(() => useBlockSuccessor(parent));
    expect(result.current).toBeUndefined();
    let child = '';
    act(() => {
      child = useBlockStore
        .getState()
        .startBlock('ls', '/', { rerunOf: parent });
    });
    rerender();
    expect(result.current).toBe(child);
  });

  it('most recent rerun overwrites an earlier rerun for the same parent', () => {
    const parent = useBlockStore.getState().startBlock('ls', '/');
    const firstRerun = useBlockStore
      .getState()
      .startBlock('ls', '/', { rerunOf: parent });
    const secondRerun = useBlockStore
      .getState()
      .startBlock('ls', '/', { rerunOf: parent });
    expect(useBlockStore.getState().rerunChildByParent[parent]).toBe(
      secondRerun,
    );
    expect(firstRerun).not.toBe(secondRerun);
  });

  it('createBlock with rerunOf also populates the index', () => {
    const parent = useBlockStore.getState().createBlock('ls', '/');
    const child = useBlockStore
      .getState()
      .createBlock('ls', '/', { rerunOf: parent });
    expect(useBlockStore.getState().rerunChildByParent[parent]).toBe(child);
  });

  it('clearHistory drops entries whose parent was evicted', () => {
    const parent = useBlockStore.getState().startBlock('ls', '/');
    useBlockStore.getState().completeBlock(parent, 0);
    const child = useBlockStore
      .getState()
      .startBlock('ls', '/', { rerunOf: parent });
    useBlockStore.getState().completeBlock(child, 0);
    expect(useBlockStore.getState().rerunChildByParent[parent]).toBe(child);
    // Neither is pinned → both evicted → entry dropped.
    useBlockStore.getState().clearHistory();
    expect(useBlockStore.getState().rerunChildByParent[parent]).toBeUndefined();
  });

  it('clearHistory keeps entries whose parent AND child both survived as pinned', () => {
    const parent = useBlockStore.getState().startBlock('ls', '/');
    useBlockStore.getState().completeBlock(parent, 0);
    const child = useBlockStore
      .getState()
      .startBlock('ls', '/', { rerunOf: parent });
    useBlockStore.getState().completeBlock(child, 0);
    useBlockStore.getState().togglePin(parent);
    useBlockStore.getState().togglePin(child);
    useBlockStore.getState().clearHistory();
    expect(useBlockStore.getState().rerunChildByParent[parent]).toBe(child);
  });

  it('hydrateBlocks rebuilds the index from the merged entity set', () => {
    // Seed with direct hydration — two blocks, one is a rerun of the other.
    const now = Date.now();
    useBlockStore.getState().hydrateBlocks([
      {
        id: 'parent-1',
        sessionId: '__default__' as never,
        command: 'ls',
        status: 'completed',
        cwd: '/',
        startedAt: now - 100,
        completedAt: now - 50,
        exitCode: 0,
        outputChunks: [],
        collapsed: false,
        pinned: false,
        errorMessage: null,
        rerunOfId: null,
        tags: [],
      },
      {
        id: 'child-1',
        sessionId: '__default__' as never,
        command: 'ls',
        status: 'completed',
        cwd: '/',
        startedAt: now - 40,
        completedAt: now - 20,
        exitCode: 0,
        outputChunks: [],
        collapsed: false,
        pinned: false,
        errorMessage: null,
        rerunOfId: 'parent-1',
        tags: [],
      },
    ]);
    expect(useBlockStore.getState().rerunChildByParent['parent-1']).toBe(
      'child-1',
    );
  });

  it('resetAll wipes the index', () => {
    const parent = useBlockStore.getState().startBlock('ls', '/');
    useBlockStore.getState().startBlock('ls', '/', { rerunOf: parent });
    expect(useBlockStore.getState().rerunChildByParent[parent]).toBeDefined();
    useBlockStore.getState().resetAll();
    expect(useBlockStore.getState().rerunChildByParent).toEqual({});
  });
});

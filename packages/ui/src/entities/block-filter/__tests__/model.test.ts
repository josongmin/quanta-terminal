/**
 * BlockFilter — store actions + filter predicate semantics.
 *
 * Verifies the OR / AND composition rules and the "empty filter passes
 * everything" fast path that BlockList relies on for its no-filter
 * identity-stable memoization.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../../block/index.js';
import {
  blockPassesFilter,
  filterBlockIds,
  useBlockFilterStore,
} from '../index.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useBlockFilterStore.getState().clear();
});

describe('blockPassesFilter', () => {
  it('empty active set: every block passes', () => {
    expect(blockPassesFilter(['bug'], new Set(), 'any')).toBe(true);
    expect(blockPassesFilter([], new Set(), 'all')).toBe(true);
  });

  it('any-mode: passes when at least one block tag intersects the active set', () => {
    const active = new Set(['bug', 'deploy']);
    expect(blockPassesFilter(['bug'], active, 'any')).toBe(true);
    expect(blockPassesFilter(['deploy', 'other'], active, 'any')).toBe(true);
    expect(blockPassesFilter(['other'], active, 'any')).toBe(false);
    expect(blockPassesFilter([], active, 'any')).toBe(false);
  });

  it('all-mode: every active tag must be present on the block', () => {
    const active = new Set(['bug', 'deploy']);
    expect(blockPassesFilter(['bug', 'deploy'], active, 'all')).toBe(true);
    expect(blockPassesFilter(['bug', 'deploy', 'extra'], active, 'all')).toBe(true);
    expect(blockPassesFilter(['bug'], active, 'all')).toBe(false);
    expect(blockPassesFilter([], active, 'all')).toBe(false);
  });
});

describe('filterBlockIds', () => {
  it('returns the identical reference when the filter is empty (fast path)', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('pwd', '/');
    const ids = [a, b];
    const out = filterBlockIds(ids, useBlockStore.getState(), {
      activeTags: new Set(),
      mode: 'any',
    });
    expect(out).toBe(ids);
  });

  it('filters with any-mode OR semantics', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('pwd', '/');
    const c = useBlockStore.getState().createBlock('true', '/');
    useBlockStore.getState().addTag(a, 'bug');
    useBlockStore.getState().addTag(b, 'deploy');
    // c: untagged

    const out = filterBlockIds([a, b, c], useBlockStore.getState(), {
      activeTags: new Set(['bug', 'deploy']),
      mode: 'any',
    });
    expect(out).toEqual([a, b]);
  });

  it('filters with all-mode AND semantics', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    const b = useBlockStore.getState().createBlock('b', '/');
    useBlockStore.getState().addTag(a, 'bug');
    useBlockStore.getState().addTag(a, 'deploy');
    useBlockStore.getState().addTag(b, 'bug');

    const out = filterBlockIds([a, b], useBlockStore.getState(), {
      activeTags: new Set(['bug', 'deploy']),
      mode: 'all',
    });
    expect(out).toEqual([a]);
  });
});

describe('useBlockFilterStore — actions', () => {
  it('toggleTag adds then removes', () => {
    const { toggleTag } = useBlockFilterStore.getState();
    toggleTag('Bug'); // normalized to `bug`
    expect([...useBlockFilterStore.getState().activeTags]).toEqual(['bug']);
    toggleTag('bug');
    expect([...useBlockFilterStore.getState().activeTags]).toEqual([]);
  });

  it('addTag is idempotent', () => {
    const store = useBlockFilterStore.getState();
    store.addTag('bug');
    store.addTag('bug');
    expect([...useBlockFilterStore.getState().activeTags]).toEqual(['bug']);
  });

  it('removeTag is a no-op on absent tag', () => {
    const store = useBlockFilterStore.getState();
    store.addTag('bug');
    store.removeTag('deploy'); // not present
    expect([...useBlockFilterStore.getState().activeTags]).toEqual(['bug']);
  });

  it('clear resets tags AND mode', () => {
    const store = useBlockFilterStore.getState();
    store.addTag('bug');
    store.setMode('all');
    store.clear();
    expect(useBlockFilterStore.getState().activeTags.size).toBe(0);
    expect(useBlockFilterStore.getState().mode).toBe('any');
  });
});

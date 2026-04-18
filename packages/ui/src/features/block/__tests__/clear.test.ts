import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { clearBlocks } from '../clear.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('clearBlocks', () => {
  it('removes non-pinned blocks and reports counts', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    useBlockStore.getState().createBlock('b', '/');
    useBlockStore.getState().togglePin(a);
    const result = clearBlocks();
    expect(result).toEqual({ removed: 1, preserved: 1 });
    expect(useBlockStore.getState().order).toEqual([a]);
  });

  it('reports zero removed when store is empty', () => {
    expect(clearBlocks()).toEqual({ removed: 0, preserved: 0 });
  });

  it('preserves nothing when no block is pinned', () => {
    useBlockStore.getState().createBlock('a', '/');
    useBlockStore.getState().createBlock('b', '/');
    const result = clearBlocks();
    expect(result).toEqual({ removed: 2, preserved: 0 });
    expect(useBlockStore.getState().order).toEqual([]);
  });
});

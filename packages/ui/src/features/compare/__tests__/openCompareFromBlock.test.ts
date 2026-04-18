import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { useCompareStore } from '../../../entities/compare/index.js';
import { openCompareFromBlock, resolveComparePair } from '../openCompareFromBlock.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useCompareStore.getState().resetAll();
});

describe('openCompareFromBlock', () => {
  it('opens the panel with (predecessor, target) when rerunOfId is set', () => {
    const first = useBlockStore.getState().createBlock('ls', '/');
    const second = useBlockStore.getState().createBlock('ls', '/', { rerunOf: first });
    const result = openCompareFromBlock(second);
    expect(result).toEqual({ ok: true, leftId: first, rightId: second });
    const s = useCompareStore.getState();
    expect(s.open).toBe(true);
    expect(s.leftId).toBe(first);
    expect(s.rightId).toBe(second);
  });

  it('opens the panel symmetrically when called from the older block', () => {
    // User hits Compare on the original run — we should find its successor.
    const first = useBlockStore.getState().createBlock('ls', '/');
    const second = useBlockStore.getState().createBlock('ls', '/', { rerunOf: first });
    const result = openCompareFromBlock(first);
    expect(result).toEqual({ ok: true, leftId: first, rightId: second });
  });

  it('returns not-found for an unknown id and does not touch the store', () => {
    const result = openCompareFromBlock('nope');
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(useCompareStore.getState().open).toBe(false);
  });

  it('returns no-predecessor when the block has no lineage in either direction', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const result = openCompareFromBlock(id);
    expect(result).toEqual({ ok: false, reason: 'no-predecessor' });
    expect(useCompareStore.getState().open).toBe(false);
  });

  it('ignores a dangling rerunOfId and falls through to the forward scan', () => {
    const first = useBlockStore.getState().createBlock('ls', '/');
    const second = useBlockStore.getState().createBlock('ls', '/', { rerunOf: first });
    const third = useBlockStore.getState().createBlock('ls', '/', { rerunOf: second });
    // The store doesn't support deletion of a single block, so we simulate
    // a dangling pointer by building a snapshot that omits `second`.
    const state = useBlockStore.getState();
    const target = state.entities[third];
    expect(target).toBeDefined();
    const filteredEntities = { ...state.entities };
    delete filteredEntities[second];
    const pair = resolveComparePair(target!, {
      entities: filteredEntities,
      order: state.order.filter((x) => x !== second),
    });
    // No predecessor (dangling) AND nothing points at `third` as rerunOfId
    // in the filtered view → null.
    expect(pair).toBeNull();
  });
});

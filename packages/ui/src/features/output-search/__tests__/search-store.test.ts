import { beforeEach, describe, expect, it } from 'vitest';
import { useOutputSearchStore } from '../search-store.js';

beforeEach(() => {
  useOutputSearchStore.getState()._reset();
});

describe('output-search store', () => {
  it('starts closed with empty query and matches', () => {
    const s = useOutputSearchStore.getState();
    expect(s.open).toBe(false);
    expect(s.query).toBe('');
    expect(s.matches).toEqual([]);
    expect(s.currentIndex).toBe(0);
  });

  it('toggle / setOpen flip the open flag', () => {
    useOutputSearchStore.getState().setOpen(true);
    expect(useOutputSearchStore.getState().open).toBe(true);
    useOutputSearchStore.getState().toggle();
    expect(useOutputSearchStore.getState().open).toBe(false);
  });

  it('closing clears query + matches', () => {
    const s = useOutputSearchStore.getState();
    s.setOpen(true);
    s.setQuery('foo');
    s.setMatches([{ blockId: 'b1', charOffset: 0, length: 3 }]);
    s.close();
    const after = useOutputSearchStore.getState();
    expect(after.open).toBe(false);
    expect(after.query).toBe('');
    expect(after.matches).toEqual([]);
    expect(after.currentIndex).toBe(0);
  });

  it('emptying the query clears matches', () => {
    const s = useOutputSearchStore.getState();
    s.setOpen(true);
    s.setQuery('foo');
    s.setMatches([{ blockId: 'b1', charOffset: 0, length: 3 }]);
    s.setQuery('');
    expect(useOutputSearchStore.getState().matches).toEqual([]);
  });

  it('moveMatch wraps at boundaries', () => {
    const s = useOutputSearchStore.getState();
    s.setOpen(true);
    s.setMatches([
      { blockId: 'a', charOffset: 0, length: 1 },
      { blockId: 'b', charOffset: 0, length: 1 },
      { blockId: 'c', charOffset: 0, length: 1 },
    ]);
    expect(useOutputSearchStore.getState().currentIndex).toBe(0);
    s.moveMatch(1);
    expect(useOutputSearchStore.getState().currentIndex).toBe(1);
    s.moveMatch(1);
    expect(useOutputSearchStore.getState().currentIndex).toBe(2);
    s.moveMatch(1);
    expect(useOutputSearchStore.getState().currentIndex).toBe(0);
    s.moveMatch(-1);
    expect(useOutputSearchStore.getState().currentIndex).toBe(2);
  });

  it('setMatches clamps the currentIndex', () => {
    const s = useOutputSearchStore.getState();
    s.setOpen(true);
    s.setMatches([
      { blockId: 'a', charOffset: 0, length: 1 },
      { blockId: 'b', charOffset: 0, length: 1 },
      { blockId: 'c', charOffset: 0, length: 1 },
    ]);
    s.moveMatch(2); // idx=2
    s.setMatches([{ blockId: 'a', charOffset: 0, length: 1 }]);
    expect(useOutputSearchStore.getState().currentIndex).toBe(0);
  });
});

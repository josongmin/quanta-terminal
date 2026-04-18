import { beforeEach, describe, expect, it } from 'vitest';
import { useCompareStore } from '../model.js';

beforeEach(() => {
  useCompareStore.getState().resetAll();
});

describe('compare store', () => {
  it('starts closed with null ids', () => {
    const s = useCompareStore.getState();
    expect(s.open).toBe(false);
    expect(s.leftId).toBeNull();
    expect(s.rightId).toBeNull();
  });

  it('openCompare flips open and stashes the pair', () => {
    useCompareStore.getState().openCompare({ leftId: 'a', rightId: 'b' });
    const s = useCompareStore.getState();
    expect(s.open).toBe(true);
    expect(s.leftId).toBe('a');
    expect(s.rightId).toBe('b');
  });

  it('closeCompare clears open but keeps the last pair', () => {
    useCompareStore.getState().openCompare({ leftId: 'a', rightId: 'b' });
    useCompareStore.getState().closeCompare();
    const s = useCompareStore.getState();
    expect(s.open).toBe(false);
    expect(s.leftId).toBe('a');
    expect(s.rightId).toBe('b');
  });

  it('openCompare overwrites the previous pair', () => {
    useCompareStore.getState().openCompare({ leftId: 'a', rightId: 'b' });
    useCompareStore.getState().openCompare({ leftId: 'c', rightId: 'd' });
    const s = useCompareStore.getState();
    expect(s.leftId).toBe('c');
    expect(s.rightId).toBe('d');
  });
});

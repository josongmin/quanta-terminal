/**
 * Match-stability: when new output streams in, the store's re-locate logic
 * should keep `currentIndex` pointing at the same underlying hit identified
 * by `(blockId, lineIndex, start)`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useOutputSearchStore } from '../search-store.js';

beforeEach(() => {
  useOutputSearchStore.getState()._reset();
});

describe('setMatches stability', () => {
  it('re-locates the current match when new hits are appended', () => {
    const s = useOutputSearchStore.getState();
    s.setOpen(true);

    s.setMatches({
      matches: [
        { blockId: 'a', charOffset: 0, length: 3 },
        { blockId: 'a', charOffset: 10, length: 3 },
      ],
      detailed: [
        { blockId: 'a', lineIndex: 0, start: 0, end: 3 },
        { blockId: 'a', lineIndex: 1, start: 10, end: 13 },
      ],
      error: null,
    });

    // User navigates to the second hit.
    s.moveMatch(1);
    expect(useOutputSearchStore.getState().currentIndex).toBe(1);

    // A new chunk arrives; the indexer re-runs and returns MORE hits
    // interleaved — the second original hit is now at index 2.
    s.setMatches({
      matches: [
        { blockId: 'a', charOffset: 0, length: 3 },
        { blockId: 'a', charOffset: 5, length: 3 },
        { blockId: 'a', charOffset: 10, length: 3 },
        { blockId: 'a', charOffset: 20, length: 3 },
      ],
      detailed: [
        { blockId: 'a', lineIndex: 0, start: 0, end: 3 },
        { blockId: 'a', lineIndex: 0, start: 5, end: 8 },
        { blockId: 'a', lineIndex: 1, start: 10, end: 13 },
        { blockId: 'a', lineIndex: 2, start: 20, end: 23 },
      ],
      error: null,
    });

    // The stable-tuple match is still highlighted.
    expect(useOutputSearchStore.getState().currentIndex).toBe(2);
  });

  it('falls back to clamp when the previous hit disappeared', () => {
    const s = useOutputSearchStore.getState();
    s.setOpen(true);

    s.setMatches({
      matches: [
        { blockId: 'a', charOffset: 0, length: 3 },
        { blockId: 'a', charOffset: 10, length: 3 },
        { blockId: 'a', charOffset: 20, length: 3 },
      ],
      detailed: [
        { blockId: 'a', lineIndex: 0, start: 0, end: 3 },
        { blockId: 'a', lineIndex: 1, start: 10, end: 13 },
        { blockId: 'a', lineIndex: 2, start: 20, end: 23 },
      ],
      error: null,
    });
    s.setCurrentIndex(2);

    // A chunk arrives that trimmed the total hit count to 1 (output
    // shortened; index 2 no longer exists).
    s.setMatches({
      matches: [{ blockId: 'a', charOffset: 0, length: 3 }],
      detailed: [{ blockId: 'a', lineIndex: 0, start: 0, end: 3 }],
      error: null,
    });

    expect(useOutputSearchStore.getState().currentIndex).toBe(0);
  });

  it('clears errors alongside the matches', () => {
    const s = useOutputSearchStore.getState();
    s.setOpen(true);
    s.setMatches({
      matches: [],
      detailed: [],
      error: 'invalid regex',
    });
    expect(useOutputSearchStore.getState().error).toBe('invalid regex');

    s.setMatches({
      matches: [{ blockId: 'a', charOffset: 0, length: 3 }],
      detailed: [{ blockId: 'a', lineIndex: 0, start: 0, end: 3 }],
      error: null,
    });
    expect(useOutputSearchStore.getState().error).toBeNull();
  });
});

describe('toggles', () => {
  it('survive close/reopen during the session', () => {
    const s = useOutputSearchStore.getState();
    s.setOpen(true);
    s.setRegex(true);
    s.setCaseSensitive(true);
    s.setWholeWord(true);
    s.close();

    const after = useOutputSearchStore.getState();
    expect(after.open).toBe(false);
    expect(after.regex).toBe(true);
    expect(after.caseSensitive).toBe(true);
    expect(after.wholeWord).toBe(true);
  });
});

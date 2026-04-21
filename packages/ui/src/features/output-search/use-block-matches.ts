/**
 * Per-block selectors into the output-search store.
 *
 * BlockCard calls `useBlockOutputMatches(id)` to get the (stable-reference)
 * subset of matches that belong to this block, plus the local index of the
 * globally "current" match if it falls inside this block. Both are bundled
 * so the card issues ONE subscription and one memoized derivation; a naive
 * two-hook split would re-run the memo every time a sibling's match count
 * changes.
 *
 * Reference stability is important: the BlockCard body re-renders on every
 * streamed chunk. Returning a fresh `[]` each call would thrash `AnsiOutput`'s
 * memo even when the query is empty. We therefore cache the last returned
 * `Array.from(...)` by shallow-equality against the previous value.
 */

import { useMemo } from 'react';
import { useOutputSearchStore, type OutputMatch } from './search-store.js';

export interface BlockMatchView {
  /** Ranges (in block-local char offsets) for THIS block only. */
  readonly ranges: ReadonlyArray<{ readonly start: number; readonly length: number }>;
  /**
   * Zero-based index of the globally "current" match within `ranges`, or
   * `null` when the current match lives in a different block (or there are
   * none).
   */
  readonly activeLocalIndex: number | null;
}

const EMPTY_VIEW: BlockMatchView = { ranges: [], activeLocalIndex: null };

export function useBlockOutputMatches(blockId: string): BlockMatchView {
  // Subscribe broadly — the store is the source of truth; the memo below
  // keeps the return value referentially stable for downstream memos.
  const matches = useOutputSearchStore((s) => s.matches);
  const currentIndex = useOutputSearchStore((s) => s.currentIndex);
  const open = useOutputSearchStore((s) => s.open);

  return useMemo<BlockMatchView>(() => {
    if (!open || matches.length === 0) return EMPTY_VIEW;
    const ranges: Array<{ start: number; length: number }> = [];
    let activeLocalIndex: number | null = null;
    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i] as OutputMatch;
      if (m.blockId !== blockId) continue;
      const localIdx = ranges.length;
      ranges.push({ start: m.charOffset, length: m.length });
      if (i === currentIndex) activeLocalIndex = localIdx;
    }
    if (ranges.length === 0) return EMPTY_VIEW;
    return { ranges, activeLocalIndex };
  }, [matches, currentIndex, open, blockId]);
}

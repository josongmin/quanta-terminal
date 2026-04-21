/**
 * Cross-block match indexer.
 *
 * The SOTA++ search UX treats the block list as a single rope: pressing
 * Enter / F3 walks through every occurrence of the current query across
 * ALL blocks in the session, not just the currently-open one. This module
 * produces the ordered `Match[]` list that the UI navigates with.
 *
 * Scale: sessions can accumulate thousands of blocks, but the search
 * affordance only cares about "recent work" — we cap the scan window at
 * `MAX_BLOCKS` (defaults to 200, newest-first). Older blocks are skipped
 * rather than silently dropped from the count, because the user wouldn't
 * be scrolling to a block that's 3,000 entries above the viewport anyway.
 *
 * Each `Match` carries `(blockId, lineIndex, start, end)`:
 *   - `blockId` lets the renderer highlight per block (see
 *     `use-block-matches.ts`);
 *   - `lineIndex` is the zero-based line within the block's rendered plain
 *     text; the widget uses this to scroll the exact line into view;
 *   - `start`, `end` are the block-LOCAL character offsets; the legacy
 *     `OutputMatch` shape (charOffset + length) is produced alongside for
 *     the existing BlockCard highlighter so nothing downstream needs to
 *     change schema.
 */

import type { Block } from '../../entities/block/index.js';
import { blockOutputText } from './recompute.js';
import { compileQuery, findMatchesWithPattern, type SearchQuery } from './query.js';
import type { OutputMatch } from './search-store.js';

export interface Match {
  readonly blockId: string;
  readonly lineIndex: number;
  readonly start: number;
  readonly end: number;
}

export interface CrossBlockResult {
  /** Legacy shape — consumed by BlockCard via `useBlockOutputMatches`. */
  readonly matches: OutputMatch[];
  /** Extended shape — carries per-line coordinates for scroll + future UI. */
  readonly detailed: Match[];
  /**
   * null when the query is empty or compiled cleanly. When the user typed an
   * invalid regex in regex-mode, this holds the error message so the widget
   * can render "/invalid regex/" inline.
   */
  readonly error: string | null;
}

export interface CrossBlockOptions {
  readonly blocks: readonly Block[];
  readonly query: SearchQuery;
  /** Newest-first cap on how many blocks to scan. Defaults to 200. */
  readonly maxBlocks?: number;
}

export const DEFAULT_MAX_BLOCKS = 200;

const EMPTY: CrossBlockResult = { matches: [], detailed: [], error: null };

/**
 * Build the full cross-block match list for `query` over `blocks`. The block
 * order matches the caller's — typically the block-list render order, which
 * already runs oldest → newest, so the produced match list walks top-to-
 * bottom through the page.
 *
 * When `maxBlocks` is smaller than `blocks.length`, we scan the TAIL (most
 * recent) — that's the user's working set. Historical matches off-screen stay
 * out of the count to keep the nav predictable.
 */
export function buildCrossBlockIndex(opts: CrossBlockOptions): CrossBlockResult {
  const { blocks, query, maxBlocks = DEFAULT_MAX_BLOCKS } = opts;
  const compiled = compileQuery(query);
  if (!compiled.ok) {
    return { matches: [], detailed: [], error: compiled.error };
  }
  if (compiled.empty) return EMPTY;

  const start = Math.max(0, blocks.length - maxBlocks);
  const matches: OutputMatch[] = [];
  const detailed: Match[] = [];

  for (let bi = start; bi < blocks.length; bi += 1) {
    const block = blocks[bi]!;
    const text = blockOutputText(block.outputChunks);
    if (text.length === 0) continue;
    // Recompile per block would be wasteful — reuse the single RegExp.
    // `findMatchesWithPattern` resets `lastIndex` on entry.
    const ranges = findMatchesWithPattern(text, compiled.pattern);
    if (ranges.length === 0) continue;

    // Build a line-offset table ONCE per block so we can map every range's
    // start offset to its containing line with an O(log N) binary search.
    const lineStarts = computeLineStarts(text);

    for (const r of ranges) {
      const lineIndex = lineForOffset(lineStarts, r.start);
      matches.push({ blockId: block.id, charOffset: r.start, length: r.length });
      detailed.push({
        blockId: block.id,
        lineIndex,
        start: r.start,
        end: r.start + r.length,
      });
    }
  }

  return { matches, detailed, error: null };
}

/** Line-start offsets (starts of every line, plus an implicit 0). */
function computeLineStarts(text: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

/** Binary-search `starts` for the largest entry `<= offset`. */
function lineForOffset(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

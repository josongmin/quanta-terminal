/**
 * Recompute the global match list for the current query across every block
 * the widget cares about.
 *
 * Input text per block = `stripAnsi(TextDecoder(concatChunks(chunks)))` with a
 * small carriage-return rewrite pass. This matches what the BlockCard body
 * ultimately renders through `AnsiOutput`, so the char offsets we hand back
 * line up with the rendered text the user sees.
 *
 * Performance: the walk is O(blocks * bytes). We cap the per-block scan at
 * `MAX_BYTES_PER_BLOCK` so a 10 MB output can't freeze the UI; the widget
 * also debounces queries by 250 ms before calling us. Both are belt-and-
 * braces: for typical sessions (a few dozen blocks, KBs each) the walk is
 * sub-millisecond.
 */

import { concatChunks, type Block } from '../../entities/block/index.js';
import { stripAnsi } from '../../shared/lib/ansi-parser/index.js';
import { findMatches } from './highlight.js';
import type { OutputMatch } from './search-store.js';

/**
 * Soft cap on bytes scanned per block. At 2 MB a single block is already
 * about 30,000+ lines of tightly-packed output — well past what a human
 * benefits from searching through. Outputs that exceed this cap are matched
 * against their first N bytes only; the cap is large enough not to affect
 * practical sessions.
 */
export const MAX_BYTES_PER_BLOCK = 2 * 1024 * 1024;

// Shared decoder — allocating one per block in a hot loop is wasteful.
const DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

/**
 * Derive the rendered plain-text projection for a block. Mirrors the
 * collapsed-peek transform in `BlockCard`:
 *   1. concat chunks (bounded by `MAX_BYTES_PER_BLOCK`);
 *   2. TextDecoder utf-8;
 *   3. `stripAnsi`;
 *   4. cheap CR rewrite (`\r` truncates back to line start) so progress bars
 *      don't match the same substring 50 times.
 */
export function blockOutputText(chunks: readonly Uint8Array[]): string {
  if (chunks.length === 0) return '';
  const concat = concatChunks(chunks);
  const bounded =
    concat.byteLength > MAX_BYTES_PER_BLOCK
      ? concat.subarray(0, MAX_BYTES_PER_BLOCK)
      : concat;
  const raw = stripAnsi(DECODER.decode(bounded));
  if (raw.length === 0) return '';
  let out = '';
  let lineStart = 0;
  for (const ch of raw) {
    if (ch === '\n') {
      out += ch;
      lineStart = out.length;
    } else if (ch === '\r') {
      out = out.slice(0, lineStart);
    } else {
      out += ch;
    }
  }
  return out;
}

export interface RecomputeOptions {
  readonly blocks: readonly Block[];
  readonly query: string;
}

/**
 * Produce the full ordered list of matches across `blocks`. Order mirrors
 * the input `blocks` order (= rendered block order) so Enter / Shift+Enter
 * walks top-to-bottom through the page. Empty query → empty array.
 */
export function computeMatches(opts: RecomputeOptions): OutputMatch[] {
  const { blocks, query } = opts;
  if (query.length === 0) return [];
  const out: OutputMatch[] = [];
  for (const b of blocks) {
    const text = blockOutputText(b.outputChunks);
    if (text.length === 0) continue;
    const ranges = findMatches(text, query);
    for (const r of ranges) {
      out.push({ blockId: b.id, charOffset: r.start, length: r.length });
    }
  }
  return out;
}

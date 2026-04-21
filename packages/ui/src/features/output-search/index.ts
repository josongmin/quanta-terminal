/**
 * Public entry for the output-search feature.
 *
 * Consumed by:
 *   - widgets/output-search/OutputSearch.tsx  (the panel)
 *   - widgets/block-card/BlockCard.tsx        (the hit highlighter)
 *   - pages/terminal-page/TerminalPage.tsx    (Cmd+F keymap)
 */

export {
  useOutputSearchStore,
  getOutputSearchState,
  type OutputMatch,
  type DetailedMatch,
  type OutputSearchState,
} from './search-store.js';
export { findMatches, distributeRangesToSpans, type Range } from './highlight.js';
export {
  computeMatches,
  blockOutputText,
  MAX_BYTES_PER_BLOCK,
  type RecomputeOptions,
} from './recompute.js';
export { useBlockOutputMatches, type BlockMatchView } from './use-block-matches.js';
export {
  compileQuery,
  escapeRegex,
  findMatchesForQuery,
  findMatchesWithPattern,
  EMPTY_QUERY,
  type SearchQuery,
  type CompiledQuery,
} from './query.js';
export {
  buildCrossBlockIndex,
  DEFAULT_MAX_BLOCKS,
  type CrossBlockResult,
  type CrossBlockOptions,
  type Match as CrossBlockMatch,
} from './cross-block.js';
export {
  searchGrid,
  searchGridWithQuery,
  escapeRegex as escapeRegexForGrid,
  type GridSearchMatch,
  type GridSearchEmulator,
  type SearchGridOptions,
} from './scrollback-search.js';

/**
 * Command-palette adapter for history search.
 *
 * The palette ships with a fixed catalogue (`commands.ts`). When the user
 * types a query, we additionally surface the top-K history results under the
 * "history" section so `Cmd-K`-then-type behaves like a unified launcher.
 *
 * This module is the thin bridge between the feature (`searchHistory`) and
 * the widget's catalogue shape (`Command`). It is pure — callers pass the
 * query, the current workspace id, and a `select` callback; we return a
 * `readonly Command[]` that can be concatenated onto the base catalogue.
 */

// FIXME(fsd-layer-skip): history feature ingests into the command-palette widget's Command shape
import type { Command } from '../../widgets/command-palette/commands.js';
import type { Block } from '../../entities/block/index.js';
import {
  searchHistory,
  type SearchHit,
  type SearchOptions,
} from './search.js';

export interface HistoryCommandIngestOptions extends SearchOptions {
  /** Callback fired when the user runs a history command. */
  readonly onSelect: (block: Block, hit: SearchHit) => void;
}

/**
 * Build the history-section command rows for a query. Returns an empty array
 * when the query is empty OR when no blocks match — the palette drops empty
 * sections automatically.
 */
export function ingestHistoryCommands(
  query: string,
  options: HistoryCommandIngestOptions,
): readonly Command[] {
  const { onSelect, ...searchOpts } = options;
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const hits = searchHistory(trimmed, { limit: 8, ...searchOpts });
  return hits.map((hit): Command => {
    const status = hit.block.status;
    const dupSuffix = hit.duplicateCount > 1 ? ` (${hit.duplicateCount}×)` : '';
    const exitSuffix =
      hit.block.exitCode !== null && hit.block.exitCode !== 0
        ? ` · exit ${hit.block.exitCode}`
        : '';
    return {
      id: `history.${hit.block.id}`,
      label: hit.block.command,
      section: 'history',
      description: `${hit.block.cwd} · ${status}${exitSuffix}${dupSuffix}`,
      run: () => onSelect(hit.block, hit),
    };
  });
}

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
import { useImportedHistoryStore } from '../shell-history-import/import-store.js';

/** Max rows surfaced from real block history. Kept at 8 because the
 *  palette is a single-column pop-up and rows beyond the fold get
 *  ignored by keyboard users anyway. */
const HISTORY_SECTION_MAX_ROWS = 8;

export interface HistoryCommandIngestOptions extends SearchOptions {
  /** Callback fired when the user runs a history command. */
  readonly onSelect: (block: Block, hit: SearchHit) => void;
  /** Callback fired when the user runs an imported command (no block
   *  backing it). The string is the bare command text as stored in the
   *  imported corpus — the palette consumer should copy it into the
   *  composer / submit it just like a real block rerun. Optional for
   *  backwards compatibility with existing call sites. */
  readonly onSelectImported?: (command: string) => void;
}

/**
 * Build the history-section command rows for a query. Returns an empty array
 * when the query is empty OR when no blocks match — the palette drops empty
 * sections automatically.
 *
 * Imported shell-history entries (from `features/shell-history-import`) are
 * appended only if real-block hits leave room under
 * {@link HISTORY_SECTION_MAX_ROWS}. This keeps the palette's ranking
 * dominated by actual-run blocks while still letting the user surface
 * their pre-Quanta history when their block store is sparse.
 */
export function ingestHistoryCommands(
  query: string,
  options: HistoryCommandIngestOptions,
): readonly Command[] {
  const { onSelect, onSelectImported, ...searchOpts } = options;
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const hits = searchHistory(trimmed, {
    limit: HISTORY_SECTION_MAX_ROWS,
    ...searchOpts,
  });
  const realRows = hits.map((hit): Command => {
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

  // Early-out when the real-block hits already saturate the section or
  // the palette consumer didn't supply a "run imported" callback.
  if (realRows.length >= HISTORY_SECTION_MAX_ROWS) return realRows;
  if (!onSelectImported) return realRows;

  const importedEntries = useImportedHistoryStore.getState().entries;
  if (importedEntries.length === 0) return realRows;

  const remainingSlots = HISTORY_SECTION_MAX_ROWS - realRows.length;
  const lowered = trimmed.toLowerCase();
  // Commands already in the real-hits list are excluded so we don't
  // double-list the same text with different backing types.
  const realCommandSet = new Set<string>();
  for (const h of hits) realCommandSet.add(h.block.command.trim());

  const importedRows: Command[] = [];
  // Walk newest-first for lookup so recently-typed pre-Quanta commands
  // beat ancient ones. The parser returns chronological order, so the
  // tail is the newest.
  const seenImportedCmd = new Set<string>();
  for (let i = importedEntries.length - 1; i >= 0 && importedRows.length < remainingSlots; i -= 1) {
    const cmd = importedEntries[i];
    if (cmd === undefined) continue;
    const cmdTrim = cmd.trim();
    if (cmdTrim.length === 0) continue;
    if (!cmdTrim.toLowerCase().includes(lowered)) continue;
    if (realCommandSet.has(cmdTrim)) continue;
    if (seenImportedCmd.has(cmdTrim)) continue;
    seenImportedCmd.add(cmdTrim);
    importedRows.push({
      id: `history.imported.${importedRows.length}.${hashString(cmdTrim)}`,
      label: cmdTrim,
      section: 'history',
      description: 'imported history',
      run: () => onSelectImported(cmdTrim),
    });
  }

  return [...realRows, ...importedRows];
}

/** Stable short hash for command id suffixes — not cryptographic, just
 *  distinct enough that two similar imported commands don't collide. */
function hashString(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36);
}

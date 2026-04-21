/**
 * Block-store → `HistoryEntry` adapter for the inline autosuggest.
 *
 * We read terminal-state (non-running) blocks from the block store and
 * aggregate them by (command, cwd) into one HistoryEntry per unique
 * invocation key. `runCount` is the number of times that command ran from
 * that cwd, `lastRunAt` is the most recent completion timestamp.
 *
 * Why aggregate here, not in suggest.ts: keeps `suggest.ts` a pure function
 * over a HistoryEntry list so the unit tests stay fixture-based, and lets
 * the composer pull the data via a thin hook that subscribes only to the
 * block-id list (not to `entities`, which mutates on every output chunk).
 */

import {
  useBlockIds,
  useBlockStore,
  type Block,
} from '../../entities/block/index.js';
import { useMemo } from 'react';
import type { HistoryEntry } from './suggest.js';
import {
  buildImportedHistoryEntries,
  mergeHistoryEntries,
  useImportedHistoryStore,
} from '../shell-history-import/index.js';

/** Build `HistoryEntry` list from a frozen snapshot of blocks. */
export function buildHistoryEntries(blocks: readonly Block[]): HistoryEntry[] {
  const byKey = new Map<string, { entry: HistoryEntry; lastAt: number }>();
  for (const b of blocks) {
    if (b.status === 'running') continue;
    const command = b.command.trim();
    if (command.length === 0) continue;
    const key = `${command}\u0000${b.cwd}`;
    const ts = b.completedAt ?? b.startedAt;
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, {
        entry: {
          command,
          cwd: b.cwd,
          runCount: existing.entry.runCount + 1,
          lastRunAt: Math.max(existing.entry.lastRunAt, ts),
        },
        lastAt: Math.max(existing.lastAt, ts),
      });
    } else {
      byKey.set(key, {
        entry: { command, cwd: b.cwd, runCount: 1, lastRunAt: ts },
        lastAt: ts,
      });
    }
  }
  return [...byKey.values()].map((v) => v.entry);
}

/**
 * Hook exposing aggregated history suitable for the inline autosuggest.
 * Subscribes to the id list only — the memo rebuilds when a block is added
 * or removed, NOT when a running block's output chunks grow. A completing
 * block bumps `entities` but does not change `order`; we therefore fetch
 * the latest `entities` via `getState()` at memo time rather than
 * subscribing to them, which keeps keystrokes in the composer from
 * re-rendering on every PTY chunk.
 *
 * Imported shell-history entries (zsh_history / bash_history / fish_history
 * scraped on first launch — see `features/shell-history-import`) are
 * merged onto the tail of the list so the inline suggester can surface
 * completions from the user's existing history from second one. They
 * carry a backdated `lastRunAt` so the recency-decay term keeps real
 * blocks ahead on ranker ties; see `query.ts` for the policy.
 *
 * The `currentCwd` argument lets the imported entries share the caller's
 * cwd so the cwd-boost still applies in the unified list. Defaults to
 * empty string (no cwd match) when unknown.
 */
export function useHistoryEntries(currentCwd: string = ''): readonly HistoryEntry[] {
  const ids = useBlockIds();
  const imported = useImportedHistoryStore((s) => s.entries);
  return useMemo(() => {
    const state = useBlockStore.getState();
    const blocks: Block[] = [];
    for (const id of ids) {
      const b = state.entities[id];
      if (b) blocks.push(b);
    }
    const realEntries = buildHistoryEntries(blocks);
    if (imported.length === 0) return realEntries;
    const importedEntries = buildImportedHistoryEntries({
      entries: imported,
      currentCwd,
    });
    return mergeHistoryEntries(realEntries, importedEntries);
  }, [ids, imported, currentCwd]);
}

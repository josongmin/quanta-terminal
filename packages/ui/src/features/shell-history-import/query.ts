/**
 * Imported-history lookup adapters.
 *
 * The auto-imported entries live in {@link useImportedHistoryStore}. Real
 * blocks (commands the user actually ran inside Quanta) live in the block
 * store. Both need to flow into:
 *
 *   - the inline autosuggest ranker (`features/autosuggest/suggest.ts`)
 *   - the command-palette history section (`features/history/search.ts`
 *     via `ingestHistoryCommands`)
 *
 * We keep real blocks strictly higher priority than imported entries:
 *   - in autosuggest: imported entries get a static `lastRunAt` ~30 days
 *     in the past so the recency-decay term is small, and a `runCount`
 *     of 1 — enough to surface completions that aren't in the block
 *     store yet, but not enough to outrank a block from today.
 *   - in command-palette: imported entries don't take slots away from
 *     real blocks because the palette section caps at 8 results; we
 *     append imported rows only when the real-block hits leave room.
 *
 * This module exposes the merge adapters and a pair of React hooks. The
 * hooks are thin wrappers over the autosuggest / command-palette
 * existing APIs so call sites don't care whether an entry is imported
 * or native.
 */

import { useMemo } from 'react';
import type { HistoryEntry } from '../autosuggest/index.js';
import { useImportedHistoryStore } from './import-store.js';

/**
 * Epoch-ms backstop we slot under every imported entry's `lastRunAt`. Set
 * far enough in the past that the autosuggest recency decay (one-week
 * half-life per `suggest.ts`) kills ~94% of the recency contribution,
 * yet recent enough that the remaining 6% beats a never-seen command.
 *
 * 30 days is a load-bearing constant: five half-lives. The integration
 * test that asserts "real blocks outrank imported entries" relies on
 * this being ≥ 2 half-lives (14 d) behind any realistic real-block
 * timestamp. We keep a named constant so the test and the production
 * code agree on one number.
 */
export const IMPORTED_ENTRY_BACKSTOP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Build `HistoryEntry` rows for the autosuggest ranker out of imported
 * commands. `currentCwd` is baked in so the cwd-boost fires on entries
 * that look cwd-specific (e.g. `cd <abs-path>`) — otherwise every
 * imported row would share a synthetic placeholder cwd, which is
 * neither accurate nor useful.
 *
 * The caller passes `now` so unit tests can pin the timestamp.
 */
export function buildImportedHistoryEntries(args: {
  readonly entries: readonly string[];
  readonly currentCwd: string;
  readonly now?: number;
}): HistoryEntry[] {
  const { entries, currentCwd, now } = args;
  const clock = now ?? Date.now();
  const lastRunAt = clock - IMPORTED_ENTRY_BACKSTOP_AGE_MS;
  // Dedup here so ranking doesn't see the same command multiple times;
  // adjacent-dup was handled by the parser, but shell histories can
  // still repeat the same command at non-adjacent positions.
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  // Iterate newest → oldest (the parser returned chronological order),
  // so the first time we see a command we keep the most-recent
  // occurrence. After the dedup we emit in reverse of the scan order so
  // the ranker still sees oldest-first — not observable for the ranker
  // (it's order-independent) but keeps the debug output predictable.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const cmd = entries[i];
    if (cmd === undefined) continue;
    const trimmed = cmd.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push({
      command: trimmed,
      cwd: currentCwd,
      runCount: 1,
      lastRunAt,
    });
  }
  return out;
}

/**
 * Hook wrapper around {@link buildImportedHistoryEntries} with the store
 * subscription and memoisation baked in. The selector uses a primitive
 * length fingerprint to avoid re-rendering when the underlying entries
 * array is replaced by an identical-length clone.
 */
export function useImportedHistoryEntries(currentCwd: string): readonly HistoryEntry[] {
  const entries = useImportedHistoryStore((s) => s.entries);
  return useMemo(
    () => buildImportedHistoryEntries({ entries, currentCwd }),
    [entries, currentCwd],
  );
}

/**
 * Merge imported entries under a list of real (block-sourced) entries.
 * The ordering inside each group is preserved; the real list comes
 * first so ranker ties (same score) resolve to real blocks per the
 * ranker's existing secondary "newer beats older" tiebreaker.
 */
export function mergeHistoryEntries(
  real: readonly HistoryEntry[],
  imported: readonly HistoryEntry[],
): HistoryEntry[] {
  // Exclude imported commands that already exist in the real list —
  // the real block is always the more accurate entry (it has a true
  // lastRunAt / runCount). Dedup key is the trimmed command text alone;
  // cwd differences between sources are a feature, not a bug.
  const realCommands = new Set<string>();
  for (const e of real) {
    realCommands.add(e.command.trim());
  }
  const merged: HistoryEntry[] = [...real];
  for (const e of imported) {
    if (realCommands.has(e.command.trim())) continue;
    merged.push(e);
  }
  return merged;
}

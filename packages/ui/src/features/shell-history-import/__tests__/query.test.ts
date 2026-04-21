/**
 * Tests for the imported-history → autosuggest merge layer.
 *
 * We want to guarantee:
 *   1. Imported entries participate in `suggestFromHistory`.
 *   2. When a real block and an imported entry share the same command,
 *      the ranker picks the real block (via the recency tiebreaker —
 *      the backstop keeps imported entries a month in the past).
 *   3. `mergeHistoryEntries` dedups by command text so we never show
 *      both a real and imported version.
 */

import { describe, expect, it } from 'vitest';

import { suggestFromHistory } from '../../autosuggest/suggest.js';
import {
  IMPORTED_ENTRY_BACKSTOP_AGE_MS,
  buildImportedHistoryEntries,
  mergeHistoryEntries,
} from '../query.js';

const NOW = 1_700_000_000_000;

describe('buildImportedHistoryEntries', () => {
  it('returns entries with a backstop lastRunAt', () => {
    const entries = buildImportedHistoryEntries({
      entries: ['ls', 'pwd'],
      currentCwd: '/',
      now: NOW,
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.lastRunAt).toBe(NOW - IMPORTED_ENTRY_BACKSTOP_AGE_MS);
    expect(entries[1]!.lastRunAt).toBe(NOW - IMPORTED_ENTRY_BACKSTOP_AGE_MS);
    expect(entries[0]!.runCount).toBe(1);
  });

  it('dedupes non-adjacent duplicates in the corpus', () => {
    const entries = buildImportedHistoryEntries({
      entries: ['ls', 'pwd', 'ls', 'cd'],
      currentCwd: '/',
      now: NOW,
    });
    const commands = entries.map((e) => e.command);
    expect(new Set(commands).size).toBe(commands.length);
    expect(commands).toContain('ls');
    expect(commands).toContain('pwd');
    expect(commands).toContain('cd');
  });

  it('filters empty / whitespace entries', () => {
    const entries = buildImportedHistoryEntries({
      entries: ['', '   ', 'ls'],
      currentCwd: '/',
      now: NOW,
    });
    expect(entries.map((e) => e.command)).toEqual(['ls']);
  });
});

describe('mergeHistoryEntries + suggestFromHistory integration', () => {
  it('imported entries contribute suggestions when no real block matches', () => {
    const imported = buildImportedHistoryEntries({
      entries: ['pnpm vitest run'],
      currentCwd: '/',
      now: NOW,
    });
    const merged = mergeHistoryEntries([], imported);
    const suggestion = suggestFromHistory('pnpm', merged, { now: NOW });
    expect(suggestion).toBe('pnpm vitest run');
  });

  it('real blocks outrank imported entries on ranker ties', () => {
    // Same command appears in both sources. The real block is "yesterday",
    // the imported entry is 30 days back. Ranker must prefer the real
    // block on the recency term.
    const realEntries = [
      {
        command: 'pnpm vitest run --watch',
        cwd: '/',
        runCount: 1,
        lastRunAt: NOW - 24 * 60 * 60 * 1000,
      },
    ];
    const imported = buildImportedHistoryEntries({
      entries: ['pnpm vitest run --watch'],
      currentCwd: '/',
      now: NOW,
    });
    const merged = mergeHistoryEntries(realEntries, imported);
    // merge() dedupes by command text, so imported variant drops out
    // entirely in this case — the real block is the only thing the
    // ranker sees. Verify that.
    expect(merged).toHaveLength(1);
    expect(merged[0]!.lastRunAt).toBe(NOW - 24 * 60 * 60 * 1000);
  });

  it('keeps imported entries that do not overlap with real blocks', () => {
    const realEntries = [
      {
        command: 'git status',
        cwd: '/',
        runCount: 1,
        lastRunAt: NOW,
      },
    ];
    const imported = buildImportedHistoryEntries({
      entries: ['git log', 'git diff'],
      currentCwd: '/',
      now: NOW,
    });
    const merged = mergeHistoryEntries(realEntries, imported);
    expect(merged.map((e) => e.command).sort()).toEqual([
      'git diff',
      'git log',
      'git status',
    ]);
  });
});

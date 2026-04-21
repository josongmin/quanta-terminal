/**
 * suggestFromHistory — unit table covering the contract surface.
 *
 * Fixture style mirrors `features/history/__tests__/search.test.ts`: a local
 * helper builds a `HistoryEntry[]` and each case asserts the single best
 * completion. The ranker is pure, so no store / renderer is needed.
 */

import { describe, expect, it } from 'vitest';
import {
  suggestFromHistory,
  type HistoryEntry,
} from '../suggest.js';

function entry(
  command: string,
  opts: Partial<Omit<HistoryEntry, 'command'>> = {},
): HistoryEntry {
  return {
    command,
    lastRunAt: opts.lastRunAt ?? 1_000_000,
    runCount: opts.runCount ?? 1,
    cwd: opts.cwd ?? '/repo',
  };
}

describe('suggestFromHistory — empty inputs', () => {
  it('returns null for an empty prefix', () => {
    expect(suggestFromHistory('', [entry('cd packages/ui')])).toBeNull();
  });

  it('returns null for an empty history', () => {
    expect(suggestFromHistory('cd', [])).toBeNull();
  });

  it('returns null when no entry starts with the prefix', () => {
    const history = [entry('pnpm test'), entry('ls -la')];
    expect(suggestFromHistory('cd ', history)).toBeNull();
  });
});

describe('suggestFromHistory — exact-match guard', () => {
  it('returns null when the prefix already equals an entry exactly', () => {
    const history = [entry('cd packages/ui')];
    expect(suggestFromHistory('cd packages/ui', history)).toBeNull();
  });

  it('still suggests when the prefix is a strict prefix of the entry', () => {
    const history = [entry('cd packages/ui')];
    expect(suggestFromHistory('cd pack', history)).toBe('cd packages/ui');
  });
});

describe('suggestFromHistory — ranking', () => {
  it('picks the higher-frequency entry when recency matches', () => {
    const now = 2_000_000;
    const history = [
      entry('pnpm test', { runCount: 1, lastRunAt: now }),
      entry('pnpm typecheck', { runCount: 50, lastRunAt: now }),
    ];
    expect(suggestFromHistory('pnpm ', history, { now })).toBe('pnpm typecheck');
  });

  it('picks the more-recent entry when frequency matches', () => {
    const now = 10_000_000;
    const history = [
      entry('git status', {
        runCount: 3,
        lastRunAt: now - 30 * 24 * 60 * 60 * 1000, // 30 days ago
        cwd: '/a',
      }),
      entry('git stash', {
        runCount: 3,
        lastRunAt: now - 60_000, // a minute ago
        cwd: '/b',
      }),
    ];
    // Both start with "git s" — the recent one wins.
    expect(suggestFromHistory('git s', history, { now })).toBe('git stash');
  });

  it('prefers the cwd-matching entry over an older sibling from elsewhere', () => {
    const now = 1_000_000;
    const history = [
      entry('make test', { runCount: 5, lastRunAt: now, cwd: '/other' }),
      entry('make build', { runCount: 1, lastRunAt: now, cwd: '/here' }),
    ];
    // Both equally recent. /here's block has lower run-count but the cwd boost
    // pushes it above — user expects "the last thing I did HERE" to win.
    expect(
      suggestFromHistory('make ', history, { now, currentCwd: '/here' }),
    ).toBe('make build');
  });

  it('does NOT apply the cwd boost when currentCwd is undefined', () => {
    const now = 1_000_000;
    const history = [
      entry('make test', { runCount: 5, lastRunAt: now, cwd: '/other' }),
      entry('make build', { runCount: 1, lastRunAt: now, cwd: '/here' }),
    ];
    // Without currentCwd, raw frequency wins.
    expect(suggestFromHistory('make ', history, { now })).toBe('make test');
  });
});

describe('suggestFromHistory — casing and partial', () => {
  it('is case-sensitive on the prefix (Cd does not match cd ...)', () => {
    expect(
      suggestFromHistory('Cd ', [entry('cd packages/ui')]),
    ).toBeNull();
  });

  it('returns the full command, not just the tail', () => {
    const result = suggestFromHistory('ec', [entry('echo hello world')]);
    expect(result).toBe('echo hello world');
  });
});

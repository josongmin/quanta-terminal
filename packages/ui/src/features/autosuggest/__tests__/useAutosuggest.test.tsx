/**
 * useAutosuggest — hook-level gates.
 *
 * We exercise the password-mode kill-switch and the caret-at-end gate against
 * a fixture history. `renderHook` keeps the hook isolated from the composer.
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAutosuggest, MAX_HISTORY_SCAN } from '../useAutosuggest.js';
import type { HistoryEntry } from '../suggest.js';
import * as suggestModule from '../suggest.js';

const HISTORY: HistoryEntry[] = [
  { command: 'cd packages/ui', lastRunAt: 1_000_000, runCount: 3, cwd: '/repo' },
  { command: 'pnpm test', lastRunAt: 1_000_000, runCount: 10, cwd: '/repo' },
];

describe('useAutosuggest', () => {
  it('returns a suggestion when gates pass', () => {
    const { result } = renderHook(() =>
      useAutosuggest({
        value: 'cd ',
        caret: 3,
        history: HISTORY,
        passwordMode: false,
        dismissed: false,
        now: 1_000_000,
      }),
    );
    expect(result.current.suggestion).toBe('cd packages/ui');
    expect(result.current.tail).toBe('packages/ui');
  });

  it('flips off in password mode (SECURITY)', () => {
    const { result } = renderHook(() =>
      useAutosuggest({
        value: 'cd ',
        caret: 3,
        history: HISTORY,
        passwordMode: true,
        dismissed: false,
      }),
    );
    expect(result.current.suggestion).toBeNull();
    expect(result.current.tail).toBeNull();
  });

  it('flips off when the caret is NOT at the end', () => {
    const { result } = renderHook(() =>
      useAutosuggest({
        value: 'cd ',
        caret: 1, // caret mid-buffer
        history: HISTORY,
        passwordMode: false,
        dismissed: false,
      }),
    );
    expect(result.current.suggestion).toBeNull();
  });

  it('flips off when the value contains a newline (multi-line input)', () => {
    const { result } = renderHook(() =>
      useAutosuggest({
        value: 'cd \npnp',
        caret: 7,
        history: HISTORY,
        passwordMode: false,
        dismissed: false,
      }),
    );
    expect(result.current.suggestion).toBeNull();
  });

  it('flips off when dismissed', () => {
    const { result } = renderHook(() =>
      useAutosuggest({
        value: 'cd ',
        caret: 3,
        history: HISTORY,
        passwordMode: false,
        dismissed: true,
      }),
    );
    expect(result.current.suggestion).toBeNull();
  });

  it('flips off for empty value', () => {
    const { result } = renderHook(() =>
      useAutosuggest({
        value: '',
        caret: 0,
        history: HISTORY,
        passwordMode: false,
        dismissed: false,
      }),
    );
    expect(result.current.suggestion).toBeNull();
  });
});

describe('useAutosuggest — MAX_HISTORY_SCAN cap', () => {
  /**
   * Build a history array of `size` entries. The most-recent N entries all
   * have the command "cmd-recent-<i>" (timestamped at `now - i`). Entries
   * beyond MAX_HISTORY_SCAN are timestamped far in the past.
   */
  function buildLargeHistory(size: number, now: number): HistoryEntry[] {
    return Array.from({ length: size }, (_, i) => ({
      command: `cmd-${i} extra`,
      // Most recent entries are at the start of the array (index 0 = newest).
      lastRunAt: now - i,
      runCount: 1,
      cwd: '/repo',
    }));
  }

  it('with 3000 history entries, only the first 2000 (by recency) are passed to suggestFromHistory', () => {
    const spy = vi.spyOn(suggestModule, 'suggestFromHistory');
    const now = Date.now();
    const history = buildLargeHistory(3000, now);

    renderHook(() =>
      useAutosuggest({
        value: 'cmd-',
        caret: 4,
        history,
        passwordMode: false,
        dismissed: false,
        now,
      }),
    );

    expect(spy).toHaveBeenCalled();
    // The second argument is the capped history slice. It must be ≤ MAX_HISTORY_SCAN.
    const passedHistory = spy.mock.calls[0]![1] as readonly HistoryEntry[];
    expect(passedHistory.length).toBeLessThanOrEqual(MAX_HISTORY_SCAN);
    expect(passedHistory.length).toBe(MAX_HISTORY_SCAN);

    spy.mockRestore();
  });

  it('the 1999th-most-recent entry IS suggested; the 2001st is NOT', () => {
    const now = 10_000_000;
    // Build history where:
    //   - entry at rank 1999 (index 1998) has command "unique-1999 end"
    //   - entry at rank 2001 (index 2000) has command "unique-2001 end"
    // We use a unique prefix "unique-" so only these two entries match.
    const history: HistoryEntry[] = Array.from({ length: 3000 }, (_, i) => ({
      command: i === 1998 ? 'unique-1999 end' : i === 2000 ? 'unique-2001 end' : `other-${i}`,
      // Rank by recency: index 0 is most recent, index 2999 is oldest.
      lastRunAt: now - i,
      runCount: 1,
      cwd: '/repo',
    }));

    // Entry at index 1998 is rank 1999 — within the 2000-entry cap.
    const { result: r1 } = renderHook(() =>
      useAutosuggest({
        value: 'unique-1999',
        caret: 11,
        history,
        passwordMode: false,
        dismissed: false,
        now,
      }),
    );
    expect(r1.current.suggestion).toBe('unique-1999 end');

    // Entry at index 2000 is rank 2001 — beyond the cap, not suggested.
    const { result: r2 } = renderHook(() =>
      useAutosuggest({
        value: 'unique-2001',
        caret: 11,
        history,
        passwordMode: false,
        dismissed: false,
        now,
      }),
    );
    expect(r2.current.suggestion).toBeNull();
  });
});

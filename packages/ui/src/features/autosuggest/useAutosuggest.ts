/**
 * useAutosuggest — React hook wrapping `suggestFromHistory` with the UI gates.
 *
 * Gating rules — ALL must hold for a suggestion to be active:
 *   1. `value.length > 0` — empty composer has no suggestion (Fish parity).
 *   2. `caret === value.length` — the caret is at the end of the buffer. A
 *      suggestion that would appear mid-line is visually confusing; Fish
 *      hides its autosuggestion when the cursor isn't at the tail.
 *   3. `!value.includes('\n')` — multi-line input disables the feature.
 *      Inline completion is a single-line affordance (typing `\npwd` should
 *      not cause a ghost tail to appear on the second line).
 *   4. `!passwordMode` — SECURITY: never complete a password. Even if the
 *      user's prior typed password happens to match a history entry (it
 *      won't, because password-mode submits skip history ingestion by
 *      design), we must not risk leaking a previous command as a ghost
 *      suggestion while the user is answering a credential prompt.
 *   5. `!dismissed` — if the user just pressed Escape we stay suppressed
 *      until the value changes. Dismissal is caller-controlled so the
 *      composer can clear it on the next character typed.
 *
 * The hook returns `{ suggestion, tail }` where `suggestion` is the full
 * completion text (for accept-on-Tab/Right) and `tail` is the substring to
 * render greyed-out after the typed value (always `suggestion.slice(value.length)`).
 * When gated off, both are null.
 */

import { useMemo } from 'react';
import {
  suggestFromHistory,
  type HistoryEntry,
  type SuggestOptions,
} from './suggest.js';

/**
 * Maximum number of history entries scanned per keystroke. Entries are
 * sorted by recency (most recent first) before slicing, so the 2000
 * most-recent commands are always considered. Commands older than the
 * 2000th-most-recent entry are skipped — they are unlikely to outrank
 * a recent entry given the recency-weighted scoring formula.
 *
 * When history has fewer than 2000 entries this constant has no effect:
 * all entries are scanned exactly as before.
 */
export const MAX_HISTORY_SCAN = 2000;

export interface UseAutosuggestArgs {
  readonly value: string;
  readonly caret: number;
  readonly history: readonly HistoryEntry[];
  readonly passwordMode: boolean;
  /** When true, the user just pressed Escape — suppress until next value change. */
  readonly dismissed: boolean;
  readonly currentCwd?: string;
  /** Test-only clock override; propagates to `suggestFromHistory`. */
  readonly now?: number;
}

export interface AutosuggestResult {
  /** Full completion string (value + tail), or null when gated off. */
  readonly suggestion: string | null;
  /** The part to render after the typed `value`. Equals `suggestion.slice(value.length)`. */
  readonly tail: string | null;
}

const EMPTY_RESULT: AutosuggestResult = { suggestion: null, tail: null };

export function useAutosuggest(args: UseAutosuggestArgs): AutosuggestResult {
  const { value, caret, history, passwordMode, dismissed, currentCwd, now } = args;

  // Sort by recency once and cap at MAX_HISTORY_SCAN. Sorting is O(n log n)
  // but this memo only re-runs when `history` changes (a new command is
  // submitted), not on every keystroke — so the cost is amortised.
  const recentHistory = useMemo((): readonly HistoryEntry[] => {
    if (history.length <= MAX_HISTORY_SCAN) return history;
    return [...history]
      .sort((a, b) => b.lastRunAt - a.lastRunAt)
      .slice(0, MAX_HISTORY_SCAN);
  }, [history]);

  return useMemo((): AutosuggestResult => {
    if (passwordMode) return EMPTY_RESULT;
    if (dismissed) return EMPTY_RESULT;
    if (value.length === 0) return EMPTY_RESULT;
    if (caret !== value.length) return EMPTY_RESULT;
    if (value.includes('\n')) return EMPTY_RESULT;

    const opts: SuggestOptions = {
      ...(currentCwd !== undefined ? { currentCwd } : {}),
      ...(now !== undefined ? { now } : {}),
    };
    const suggestion = suggestFromHistory(value, recentHistory, opts);
    if (suggestion === null) return EMPTY_RESULT;
    // Defensive guard: suggestFromHistory already returns null on exact match,
    // but a length check here keeps the tail invariant even if the ranker
    // contract ever relaxes.
    if (suggestion.length <= value.length) return EMPTY_RESULT;
    const tail = suggestion.slice(value.length);
    return { suggestion, tail };
  }, [value, caret, recentHistory, passwordMode, dismissed, currentCwd, now]);
}

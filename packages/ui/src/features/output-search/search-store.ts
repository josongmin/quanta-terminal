/**
 * Output-search store — orthogonal to the command-history search.
 *
 * Scope: a Ctrl/Cmd+F quick-find over block OUTPUT text (not command lines,
 * not cwd, not history weights). Think of it as the browser's "find on page"
 * for the block list.
 *
 * Data flow:
 *   1. TerminalPage flips `open = true` when the user hits Cmd+F.
 *   2. OutputSearch widget writes `query` (debounced 100ms by default) and
 *      flips the regex / caseSensitive / wholeWord toggles as the user
 *      chooses them.
 *   3. `buildCrossBlockIndex` walks every in-scope block (capped at 200
 *      newest), strips ANSI, and records every occurrence of the compiled
 *      RegExp. Results land in `matches` (legacy shape consumed by
 *      BlockCard) + `detailed` (line-aware shape used by the widget).
 *   4. BlockCard subscribes via `useBlockOutputMatches(blockId)` and wraps
 *      hit substrings in `<mark>` via AnsiOutput's `searchHighlights` prop;
 *      the current match gets an emphasized class.
 *   5. OutputSearch widget navigates with Enter / F3 (next) and
 *      Shift+Enter / Shift+F3 (prev); the widget scrolls the block holding
 *      the current match into view.
 *
 * Stability: when new output arrives we re-run the indexer, but we try to
 * keep `currentIndex` pointing at the SAME underlying hit. The tuple
 * `(blockId, lineIndex, start)` is the stable anchor — `setMatches` re-locates
 * it in the fresh list so the user doesn't get bounced to position 0 every
 * time a chunk streams in.
 *
 * Toggle persistence: regex / caseSensitive / wholeWord live in the store so
 * they survive close/reopen during a session. They are NOT persisted to
 * localStorage — terminal sessions are short-lived and carrying a stale
 * "regex ON" setting across a page reload tends to confuse rather than help.
 */

import { create } from 'zustand';

/**
 * One occurrence of the query in a block's rendered plain-text output.
 *
 * `charOffset` and `length` are character offsets into the block's
 * rendered-plain-text string (i.e. `renderSpansToPlainText(spans)` — the same
 * string consumers use when passing `searchHighlights` to `AnsiOutput`). We
 * intentionally operate in char units rather than UTF-16 code units; the
 * helpers in `highlight.ts` use `Array.from(text).length` semantics so surrogate
 * pairs and combining marks behave like one visible glyph.
 */
export interface OutputMatch {
  readonly blockId: string;
  readonly charOffset: number;
  readonly length: number;
}

/** Extended match shape with line-index, used by the widget for scroll. */
export interface DetailedMatch {
  readonly blockId: string;
  readonly lineIndex: number;
  readonly start: number;
  readonly end: number;
}

export interface OutputSearchState {
  readonly open: boolean;
  readonly query: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly matches: readonly OutputMatch[];
  readonly detailed: readonly DetailedMatch[];
  readonly currentIndex: number;
  /**
   * Non-null when the user's regex is invalid (regex mode only). The widget
   * renders this inline as `/invalid regex/` in a red tone. Cleared on
   * successful compile.
   */
  readonly error: string | null;

  readonly setOpen: (next: boolean) => void;
  /** Open or close depending on the current value. */
  readonly toggle: () => void;
  /** Close and clear all matches. */
  readonly close: () => void;

  readonly setQuery: (next: string) => void;
  readonly setRegex: (next: boolean) => void;
  readonly setCaseSensitive: (next: boolean) => void;
  readonly setWholeWord: (next: boolean) => void;
  /**
   * Replace the match list. Accepts either the legacy `OutputMatch[]` shape
   * or the new `{ matches, detailed }` bundle. When called with the bundle,
   * the store preserves `currentIndex` by re-locating the previous current
   * match's `(blockId, lineIndex, start)` tuple; falls back to clamping if
   * the hit is gone.
   */
  readonly setMatches: (
    next:
      | readonly OutputMatch[]
      | {
          readonly matches: readonly OutputMatch[];
          readonly detailed: readonly DetailedMatch[];
          readonly error?: string | null;
        },
  ) => void;
  /** Move the active match by `delta` (usually +1 or -1). Wraps. */
  readonly moveMatch: (delta: number) => void;
  /** Jump to an explicit match index. Clamps to bounds. */
  readonly setCurrentIndex: (next: number) => void;
  /** Reset to defaults — tests only. */
  readonly _reset: () => void;
}

const INITIAL: Pick<
  OutputSearchState,
  | 'open'
  | 'query'
  | 'regex'
  | 'caseSensitive'
  | 'wholeWord'
  | 'matches'
  | 'detailed'
  | 'currentIndex'
  | 'error'
> = {
  open: false,
  query: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  matches: [],
  detailed: [],
  currentIndex: 0,
  error: null,
};

export const useOutputSearchStore = create<OutputSearchState>((set, get) => ({
  ...INITIAL,
  setOpen: (next) =>
    set((s) => {
      if (s.open === next) return s;
      // Closing also clears matches so the highlight layer disappears
      // immediately; a subsequent reopen with the same query re-indexes on
      // the next recompute pass. Toggle states are PRESERVED.
      if (!next) {
        return {
          open: false,
          query: '',
          matches: [],
          detailed: [],
          currentIndex: 0,
          error: null,
        };
      }
      return { open: true };
    }),
  toggle: () => get().setOpen(!get().open),
  close: () => get().setOpen(false),
  setQuery: (next) =>
    set((s) => {
      if (s.query === next) return s;
      if (next.length === 0) {
        return {
          query: '',
          matches: [],
          detailed: [],
          currentIndex: 0,
          error: null,
        };
      }
      return { query: next };
    }),
  setRegex: (next) =>
    set((s) => (s.regex === next ? s : { regex: next })),
  setCaseSensitive: (next) =>
    set((s) => (s.caseSensitive === next ? s : { caseSensitive: next })),
  setWholeWord: (next) =>
    set((s) => (s.wholeWord === next ? s : { wholeWord: next })),
  setMatches: (next) =>
    set((s) => {
      // Accept legacy array shape OR new bundle.
      const bundle =
        Array.isArray(next)
          ? {
              matches: next as readonly OutputMatch[],
              detailed: [] as readonly DetailedMatch[],
              error: null as string | null,
            }
          : (next as {
              readonly matches: readonly OutputMatch[];
              readonly detailed: readonly DetailedMatch[];
              readonly error?: string | null;
            });
      const nextMatches = bundle.matches;
      const nextDetailed = bundle.detailed;
      const nextError = bundle.error ?? null;
      if (s.matches === nextMatches && s.detailed === nextDetailed && s.error === nextError) {
        return s;
      }
      if (nextMatches.length === 0) {
        return {
          matches: nextMatches,
          detailed: nextDetailed,
          currentIndex: 0,
          error: nextError,
        };
      }
      // Stability: re-locate the previously-current detailed match.
      let nextIndex = Math.min(s.currentIndex, nextMatches.length - 1);
      const prev = s.detailed[s.currentIndex];
      if (prev && nextDetailed.length > 0) {
        for (let i = 0; i < nextDetailed.length; i += 1) {
          const candidate = nextDetailed[i]!;
          if (
            candidate.blockId === prev.blockId &&
            candidate.lineIndex === prev.lineIndex &&
            candidate.start === prev.start
          ) {
            nextIndex = i;
            break;
          }
        }
      }
      return {
        matches: nextMatches,
        detailed: nextDetailed,
        currentIndex: nextIndex,
        error: nextError,
      };
    }),
  moveMatch: (delta) =>
    set((s) => {
      if (s.matches.length === 0) return s;
      const n = s.matches.length;
      const next = ((s.currentIndex + delta) % n + n) % n;
      return { currentIndex: next };
    }),
  setCurrentIndex: (next) =>
    set((s) => {
      if (s.matches.length === 0) return { currentIndex: 0 };
      const clamped = Math.max(0, Math.min(s.matches.length - 1, next));
      if (clamped === s.currentIndex) return s;
      return { currentIndex: clamped };
    }),
  _reset: () => set({ ...INITIAL }),
}));

/** Non-React helpers for test code. */
export function getOutputSearchState(): OutputSearchState {
  return useOutputSearchStore.getState();
}

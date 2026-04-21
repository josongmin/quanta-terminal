/**
 * FindPanel store — grid-wide find state (Plan 0005 P1-F).
 *
 * Separate from the P0 `features/output-search/search-store.ts` because the
 * two widgets operate in different coordinate spaces:
 *   - `OutputSearch` (P0)    → block-space: `{ blockId, charOffset, length }`.
 *   - `FindPanel`    (P1-F)  → grid-space:  `{ rowId, startCol, endColExclusive }`.
 *
 * Keeping the stores split avoids a "union match type" that forces every
 * renderer to switch on the coordinate space. The two can, and do, run side
 * by side during the P1 migration — the user picks which surface they want
 * via the `output.search` keybinding (still points at `OutputSearch` by
 * default) versus the new `grid.find` action.
 *
 * Toggle persistence: regex / caseSensitive / wholeWord live in the store
 * so they survive close/reopen during a session. Not persisted to
 * localStorage — mirrors the P0 feature's decision for consistency.
 */

import { create } from 'zustand';

import type { GridSearchMatch } from '../../features/output-search/scrollback-search.js';

export interface FindPanelState {
  readonly open: boolean;
  readonly query: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly matches: readonly GridSearchMatch[];
  readonly currentIndex: number;
  /** Non-null when the user's regex is invalid. Rendered inline in red. */
  readonly error: string | null;

  readonly setOpen: (next: boolean) => void;
  readonly toggle: () => void;
  readonly close: () => void;
  readonly setQuery: (next: string) => void;
  readonly setRegex: (next: boolean) => void;
  readonly setCaseSensitive: (next: boolean) => void;
  readonly setWholeWord: (next: boolean) => void;
  readonly setMatches: (matches: readonly GridSearchMatch[], error?: string | null) => void;
  readonly moveMatch: (delta: number) => void;
  readonly setCurrentIndex: (next: number) => void;
  readonly _reset: () => void;
}

const INITIAL = {
  open: false,
  query: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  matches: [] as readonly GridSearchMatch[],
  currentIndex: 0,
  error: null as string | null,
};

export const useFindPanelStore = create<FindPanelState>((set, get) => ({
  ...INITIAL,
  setOpen: (next) =>
    set((s) => {
      if (s.open === next) return s;
      if (!next) {
        // Close → clear hits so the highlight layer disappears immediately.
        // Toggles are PRESERVED across open/close, only cleared on `_reset`.
        return {
          open: false,
          query: '',
          matches: [],
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
        return { query: '', matches: [], currentIndex: 0, error: null };
      }
      return { query: next };
    }),
  setRegex: (next) => set((s) => (s.regex === next ? s : { regex: next })),
  setCaseSensitive: (next) =>
    set((s) => (s.caseSensitive === next ? s : { caseSensitive: next })),
  setWholeWord: (next) =>
    set((s) => (s.wholeWord === next ? s : { wholeWord: next })),
  setMatches: (matches, error = null) =>
    set((s) => {
      if (s.matches === matches && s.error === error) return s;
      if (matches.length === 0) {
        return { matches, currentIndex: 0, error };
      }
      // Preserve the current index by re-locating the previous hit's
      // (rowId, startCol) tuple in the fresh list. Falls back to clamp.
      let nextIndex = Math.min(s.currentIndex, matches.length - 1);
      const prev = s.matches[s.currentIndex];
      if (prev) {
        for (let i = 0; i < matches.length; i += 1) {
          const candidate = matches[i]!;
          if (candidate.rowId === prev.rowId && candidate.startCol === prev.startCol) {
            nextIndex = i;
            break;
          }
        }
      }
      return { matches, currentIndex: nextIndex, error };
    }),
  moveMatch: (delta) =>
    set((s) => {
      if (s.matches.length === 0) return s;
      const n = s.matches.length;
      const next = ((s.currentIndex + delta) % n + n) % n;
      if (next === s.currentIndex) return s;
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

export function getFindPanelState(): FindPanelState {
  return useFindPanelStore.getState();
}

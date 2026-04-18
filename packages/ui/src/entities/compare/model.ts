/**
 * Compare entity — the panel's open/close + pair-of-block-ids state.
 *
 * The Compare panel is a modal overlay that renders a side-by-side (or
 * unified, on narrow viewports) line diff of two blocks' outputs. Multiple
 * feature dispatchers can open the panel (the BlockCard Compare button is
 * the primary today; a future "compare against N-back" palette command will
 * layer on top), so the ids live in a store rather than in page-local
 * component state.
 *
 * Contract — the panel is open iff `open === true` AND `leftId` / `rightId`
 * both reference blocks that still exist. The widget guards the existence
 * check at render time; the store keeps only the pair of ids.
 *
 * NOT persisted — the compare overlay is ephemeral. Reload drops it.
 */

import { create } from 'zustand';

export interface CompareState {
  readonly open: boolean;
  /** Older run (usually the predecessor referenced by rerunOfId). */
  readonly leftId: string | null;
  /** Newer run. */
  readonly rightId: string | null;
}

export interface CompareActions {
  /**
   * Open the compare panel with an explicit pair. `leftId` is expected to be
   * the older run and `rightId` the newer; the feature dispatcher is the one
   * place that enforces this ordering so the widget stays presentational.
   */
  openCompare(pair: { leftId: string; rightId: string }): void;
  /** Close the panel without forgetting the last pair — the UI can re-open. */
  closeCompare(): void;
  /** Test helper — wipe both pointers and the open flag. */
  resetAll(): void;
}

const INITIAL: CompareState = {
  open: false,
  leftId: null,
  rightId: null,
};

export const useCompareStore = create<CompareState & CompareActions>((set) => ({
  ...INITIAL,

  openCompare: ({ leftId, rightId }) => {
    set(() => ({ open: true, leftId, rightId }));
  },

  closeCompare: () => {
    // Keep the ids around — a subsequent `openCompare` always overwrites, but
    // tests (and a future "reopen last compare" affordance) benefit from the
    // pair being readable while the panel is closed.
    set((prev) => ({ ...prev, open: false }));
  },

  resetAll: () => set(() => ({ ...INITIAL })),
}));

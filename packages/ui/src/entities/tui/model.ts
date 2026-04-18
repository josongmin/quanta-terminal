/**
 * TUI entity — tracks whether a full-screen terminal session is currently
 * owning the page surface.
 *
 * The store answers exactly one question for the page: "is an alt-screen
 * (`ESC[?1049h`) application running right now, and if so since when?" The
 * `TerminalPage` reads this to swap the BlockList out for the xterm shell,
 * and a small status-bar chip reads `active` to show a `TUI` badge.
 *
 * We deliberately do NOT track:
 *   - which block triggered the TUI (that belongs to `entities/block` once
 *     the ADR 0008 `tui_mixed` sub-state lands — Phase-3 minimum is just the
 *     page swap);
 *   - nesting depth (real nested alt-screen is a no-op at the page level —
 *     enter inside enter is still active=true);
 *   - the raw byte log (ADR 0008 `tui_raw_blob` goes elsewhere).
 *
 * Wrapped in `subscribeWithSelector` for parity with the session store, so
 * the install detector can subscribe outside React.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export interface TuiState {
  /** True while the active block is inside `ESC[?1049h` alt-screen mode. */
  readonly active: boolean;
  /** Timestamp (ms since epoch) the current TUI session entered. */
  readonly enteredAt: number | null;
}

export interface TuiActions {
  /** Enter alt-screen mode. Idempotent: re-entering keeps the original
   *  `enteredAt` so nested TUIs do not restart the duration clock. */
  enter(): void;
  /** Exit alt-screen mode. Idempotent when already inactive. */
  exit(): void;
  /** Reset to the booting defaults. Primarily for tests + HMR. */
  reset(): void;
}

const INITIAL: TuiState = {
  active: false,
  enteredAt: null,
};

export const useTuiStore = create<TuiState & TuiActions>()(
  subscribeWithSelector((set) => ({
    ...INITIAL,
    enter: () =>
      set((prev) => {
        if (prev.active) return prev;
        return { active: true, enteredAt: Date.now() };
      }),
    exit: () =>
      set((prev) => {
        if (!prev.active) return prev;
        return { active: false, enteredAt: null };
      }),
    reset: () => set(() => ({ ...INITIAL })),
  })),
);

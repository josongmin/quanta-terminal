/**
 * TUI entity — tracks alt-screen state derived from `ModeChanged` events.
 *
 * EPIC-H redesign (§4.5): previously this store held a boolean `active` flag
 * derived from a byte-level byte detector; the same detector still feeds the
 * store in the production path, but the surface now models the full
 * alt-screen payload per RFC §7.7:
 *
 *   - `active`         — outermost alt-screen is open.
 *   - `depth`          — nesting depth. 0 when inactive; 1 = outermost; 2+ =
 *                        nested (e.g., vim inside tmux).
 *   - `crashed`        — `{ reason }` when the underlying program exited
 *                        abruptly while alt-screen was active. Held for the
 *                        "ghost" window (2 s) before the UI re-expands.
 *   - `transitioning`  — true during the 160 ms fade transition. Set when
 *                        `active` flips; cleared by `endTransition()`.
 *   - `enteredAt`      — timestamp of the outermost enter.
 *   - `command`        — label for the alt-screen status bar ("vim", "tmux",
 *                        "vim in tmux", ...). Best-effort; populated by a
 *                        detector or by explicit `setLabel(label)`.
 *   - `sessionId`      — session id of the owning terminal (plumbed from
 *                        the session tabs feature). Null when the detector
 *                        hasn't been told which session it's attached to.
 *
 * The store is the single source of truth for alt-screen UI state. The
 * TerminalPage, BlockCard, AltScreenStatusBar and SideBySideHarness all
 * read from here (or the `useAltScreenMode()` selector hook). No widget
 * consults `needsAltScreen` or a local boolean anymore.
 *
 * Wrapped in `subscribeWithSelector` so the non-React detector + degraded-
 * mode hooks can subscribe outside the render loop.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { SessionId } from '../../shared/types/generated/index.js';

export interface TuiState {
  /** True while an alt-screen application is active (depth >= 1). */
  readonly active: boolean;
  /** Nesting depth. 0 when inactive; 1 outermost; 2+ nested programs. */
  readonly depth: number;
  /** Non-null while holding the ghost frame for a crashed alt program. */
  readonly crashed: { readonly reason: string } | null;
  /** True during a 160 ms enter/exit fade; cleared by endTransition(). */
  readonly transitioning: boolean;
  /** Timestamp (ms) the outermost alt-screen entered. Null when inactive. */
  readonly enteredAt: number | null;
  /** Short label for the status bar. "vim", "tmux", "vim in tmux", ... */
  readonly command: string;
  /** Session id the current alt-screen belongs to. */
  readonly sessionId: SessionId | null;
}

export interface TuiActions {
  /**
   * Enter alt-screen mode. Increments `depth`. The outermost enter flips
   * `active`, stamps `enteredAt`, and raises `transitioning` for the CSS
   * fade. Nested enters only bump `depth` and `command`.
   */
  enter(opts?: { readonly command?: string; readonly sessionId?: SessionId }): void;
  /**
   * Exit one level of alt-screen. Decrements `depth`. The transition to
   * `depth === 0` flips `active` off, raises `transitioning`, and clears
   * `enteredAt`.
   */
  exit(): void;
  /**
   * The alt-screen program exited abruptly. Holds the ghost frame until
   * `clearCrashed()` is called (conventionally after 2 s). The caller is
   * still required to invoke `exit()` to restore the depth counter.
   */
  reportCrash(reason: string): void;
  /** Clear the ghost frame and release the degraded status bar. */
  clearCrashed(): void;
  /**
   * Update the status bar label without changing depth / active flags.
   * Called when a nested alt-screen is entered so the UI shows e.g.
   * "vim in tmux" without re-animating.
   */
  setLabel(command: string): void;
  /**
   * Clear the `transitioning` flag at the end of the CSS fade. The caller
   * schedules this via `setTimeout(endTransition, ALT_SCREEN_TRANSITION_MS)`
   * or an `onTransitionEnd` listener.
   */
  endTransition(): void;
  /** Reset to the booting defaults. Primarily for tests + HMR. */
  reset(): void;
}

const INITIAL: TuiState = {
  active: false,
  depth: 0,
  crashed: null,
  transitioning: false,
  enteredAt: null,
  command: '',
  sessionId: null,
};

export const useTuiStore = create<TuiState & TuiActions>()(
  subscribeWithSelector((set) => ({
    ...INITIAL,
    enter: (opts) =>
      set((prev) => {
        const depth = prev.depth + 1;
        // Only the outer transition is user-visible; nested enters update
        // the label but do NOT re-raise `transitioning` (RFC §7.7 row 3).
        if (prev.depth === 0) {
          return {
            ...prev,
            active: true,
            depth,
            transitioning: true,
            enteredAt: Date.now(),
            command: opts?.command ?? prev.command,
            sessionId: opts?.sessionId ?? prev.sessionId,
            crashed: null,
          };
        }
        return {
          ...prev,
          depth,
          command: opts?.command ?? prev.command,
        };
      }),
    exit: () =>
      set((prev) => {
        if (prev.depth <= 0) {
          // Defensive: a stray exit without a matching enter should leave
          // the store inactive, not go negative.
          return {
            ...prev,
            active: false,
            depth: 0,
            transitioning: prev.active ? true : prev.transitioning,
            enteredAt: null,
          };
        }
        const depth = prev.depth - 1;
        if (depth === 0) {
          return {
            ...prev,
            active: false,
            depth: 0,
            transitioning: true,
            enteredAt: null,
          };
        }
        return { ...prev, depth };
      }),
    reportCrash: (reason: string) =>
      set((prev) => ({ ...prev, crashed: { reason } })),
    clearCrashed: () => set((prev) => ({ ...prev, crashed: null })),
    setLabel: (command: string) => set((prev) => ({ ...prev, command })),
    endTransition: () => set((prev) => ({ ...prev, transitioning: false })),
    reset: () => set(() => ({ ...INITIAL })),
  })),
);

/* ------------------------------------------------------------------------ */
/*  Selector hook — Appendix A of EPIC-H: the single source of truth.        */
/* ------------------------------------------------------------------------ */

/**
 * Read the alt-screen state as `{ active, depth, crashed, transitioning }`.
 *
 * This is the ONLY API widgets should use to observe alt-screen transitions.
 * Consumers MUST NOT derive from `useNeedsAltScreen()` (deprecated) or from
 * widget-local byte detectors.
 */
export function useAltScreenMode(): {
  readonly active: boolean;
  readonly depth: number;
  readonly crashed: { readonly reason: string } | null;
  readonly transitioning: boolean;
} {
  return useTuiStore((s) => ({
    active: s.active,
    depth: s.depth,
    crashed: s.crashed,
    transitioning: s.transitioning,
  }));
}

/**
 * Bell entity — tracks the most-recent terminal BEL (0x07) event.
 *
 * The `VtEmulator` fires a bare-BEL hook; this store is what the hook wires
 * into. The UI (visual flash overlay, optional audible beep) subscribes to
 * `bellCount` via zustand selectors and reacts whenever the counter advances.
 *
 * Throttle: real PTY streams can emit BEL at terrifying rates (tail -f of a
 * log that chimes on every error, or `yes $'\x07'`). We collapse any bell
 * that arrives within `BELL_THROTTLE_MS` of the previous accepted bell into
 * a no-op — neither `lastBellAt` nor `bellCount` moves. That means the flash
 * animation and the audible beep both coalesce naturally at the source; the
 * UI doesn't need its own de-dupe logic.
 *
 * State is ephemeral — a page reload starts at `lastBellAt: null`.
 */

import { create } from 'zustand';

/** Two bells closer together than this collapse into a single event. */
export const BELL_THROTTLE_MS = 50;

export interface BellState {
  /** Timestamp (performance-ish `Date.now()` ms) of the last accepted bell, or null. */
  readonly lastBellAt: number | null;
  /** Monotonic count of accepted bells; UI subscribes to this to rerun effects. */
  readonly bellCount: number;
}

export interface BellActions {
  /** Signal that a BEL byte was observed. Throttled; returns `true` if accepted. */
  readonly trigger: (now?: number) => boolean;
  /** Clear all bell state — used by tests and session reset. */
  readonly reset: () => void;
}

export type BellStore = BellState & BellActions;

export const useBellStore = create<BellStore>((set, get) => ({
  lastBellAt: null,
  bellCount: 0,
  trigger: (nowArg) => {
    const now = typeof nowArg === 'number' ? nowArg : Date.now();
    const prev = get().lastBellAt;
    if (prev !== null && now - prev < BELL_THROTTLE_MS) {
      return false;
    }
    set((s) => ({
      lastBellAt: now,
      bellCount: s.bellCount + 1,
    }));
    return true;
  },
  reset: () => {
    set({ lastBellAt: null, bellCount: 0 });
  },
}));

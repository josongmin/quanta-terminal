/**
 * Banner entity — tracks which banner conditions are currently "active" from
 * the UI's point of view, plus which ones have been dismissed for the lifetime
 * of this session.
 *
 * The precedence rule (which condition wins when several fire) lives in
 * `shared/lib/banner-precedence.ts` and is re-used here. This slice only
 * stores the raw active/dismissed sets; the banner-host widget applies
 * precedence when rendering.
 *
 * Phase 1 notes:
 *   - The session slice does not yet report `crash_recovery` or
 *     `secret_rescan`. Those wires live in a later phase; meanwhile the
 *     feature that decides a banner is active (`features/banner/detect.ts`)
 *     is already watching the session store so the plumbing is real even
 *     when the signals aren't all hooked up yet.
 *   - Dismissal is session-scoped. A persisted/per-session store comes with
 *     multi-session work.
 */

import { create } from 'zustand';
import type { BannerCondition } from '../../shared/lib/banner-precedence.js';

export interface BannerState {
  /** Conditions the detectors currently consider active. */
  readonly active: ReadonlySet<BannerCondition>;
  /** Conditions the user has dismissed for this session. */
  readonly dismissed: ReadonlySet<BannerCondition>;
}

export interface BannerActions {
  /** Mark a condition active. Idempotent. */
  raise(condition: BannerCondition): void;
  /** Clear a condition (the underlying problem was resolved). Idempotent. */
  clear(condition: BannerCondition): void;
  /** User dismissed the condition's banner. It stays suppressed until reset. */
  dismiss(condition: BannerCondition): void;
  /** Test / session-restart helper. */
  resetAll(): void;
}

const INITIAL: BannerState = {
  active: new Set<BannerCondition>(),
  dismissed: new Set<BannerCondition>(),
};

export const useBannerStore = create<BannerState & BannerActions>((set) => ({
  ...INITIAL,
  raise: (condition) =>
    set((prev) => {
      if (prev.active.has(condition)) return prev;
      const next = new Set(prev.active);
      next.add(condition);
      return { ...prev, active: next };
    }),
  clear: (condition) =>
    set((prev) => {
      if (!prev.active.has(condition)) return prev;
      const next = new Set(prev.active);
      next.delete(condition);
      return { ...prev, active: next };
    }),
  dismiss: (condition) =>
    set((prev) => {
      const nextDismissed = new Set(prev.dismissed);
      nextDismissed.add(condition);
      return { ...prev, dismissed: nextDismissed };
    }),
  resetAll: () =>
    set(() => ({
      active: new Set<BannerCondition>(),
      dismissed: new Set<BannerCondition>(),
    })),
}));

/**
 * Helper selector — the set of conditions that are active AND not dismissed.
 * Exported as a pure function so widgets can call it inside a memoized
 * selector without pulling both sets into the render scope.
 */
export function selectVisibleConditions(state: BannerState): readonly BannerCondition[] {
  const out: BannerCondition[] = [];
  for (const c of state.active) {
    if (!state.dismissed.has(c)) out.push(c);
  }
  return out;
}

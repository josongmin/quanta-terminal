/**
 * `useAltScreenModeFromStack` — projects the new ModeStack down to the legacy
 * `useAltScreenMode()` shape.
 *
 * Rationale (P1-D §D2 "existing single-bool consumer gets a helper"):
 *
 * The legacy `entities/tui` store exposes `{ active, depth, crashed,
 * transitioning }`. Many widgets already read it. Rather than porting
 * everything at once, we ship a selector that derives the same shape from
 * the ModeStack:
 *
 *   - `active`        = any `tui` layer exists.
 *   - `depth`         = count of `tui` layers (ADR 0008: nested alt-screen
 *                       enters stack, each pushes one layer).
 *   - `crashed`       = null (the ModeStack does not model crash ghosts yet;
 *                       that stays in `entities/tui` until P1-E session
 *                       restore lands, when the journal's mode-deltas replay
 *                       the stack and crashes are reported through a
 *                       separate channel).
 *   - `transitioning` = false (same reason; transition fades are a UI-layer
 *                       concern owned by the existing store).
 *
 * This shim lets a widget switch from `useAltScreenMode()` to
 * `useAltScreenModeFromStack()` without changing its type.
 */

import { useModeStackStore } from './mode-stack-store.js';

export function useAltScreenModeFromStack(): {
  readonly active: boolean;
  readonly depth: number;
  readonly crashed: { readonly reason: string } | null;
  readonly transitioning: boolean;
} {
  return useModeStackStore((s) => {
    let depth = 0;
    for (const layer of s.layers) {
      if (layer.kind === 'tui') depth += 1;
    }
    return {
      active: depth > 0,
      depth,
      crashed: null,
      transitioning: false,
    };
  });
}

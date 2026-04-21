/**
 * `useModeStack` — shim for Plan 0005 P1-D.
 *
 * P1-D owns the canonical `ModeStack`: a stack of currently-active shell
 * modes (pager, REPL, TUI, multiplexer, nested shell, …) surfaced from the
 * session's VT emulator + shell-integration signals. P1-G consumes that
 * stack to decide which ghost hint to render.
 *
 * Because P1-G and P1-D land in parallel, this file ships a minimal,
 * type-stable shim that returns an empty stack. Once P1-D lands on main,
 * the import in `GhostHint.tsx` swaps to the real hook — no other changes
 * required. The consumer also accepts a `stackHook` DI prop so tests (and
 * the eventual real hook) can inject their own source without patching a
 * module import.
 *
 * The shape below mirrors what P1-D plans to expose, so the shim doubles
 * as a type contract for early consumers.
 */

import type { GhostHintKind } from './hint-registry.js';

/**
 * A single entry on the mode stack. `kind` is the discriminator the
 * registry keys by; extra fields (`program`, `pid`, …) may be carried by
 * the real P1-D hook but are intentionally omitted here.
 *
 * `kind` is widened to `GhostHintKind | string` because the upstream stack
 * may surface modes that don't have a ghost hint (AI overlay, composer,
 * selection, …); `GhostHint` ignores those.
 */
export interface ModeStackLayer {
  readonly kind: GhostHintKind | string;
  /** Optional human label — unused by the shim but forwarded by the real hook. */
  readonly label?: string;
}

export interface ModeStackSnapshot {
  readonly layers: readonly ModeStackLayer[];
}

/**
 * Shim hook — always returns an empty stack. Consumers should treat the
 * empty-stack case as "no hint visible", which is exactly what the test
 * suite exercises when no explicit `stackHook` is injected.
 *
 * Once P1-D lands, replace the body with the real store selector:
 *
 *   return useModeStackStore((s) => ({ layers: s.layers }));
 */
export function useModeStack(): ModeStackSnapshot {
  return EMPTY_SNAPSHOT;
}

// Stable reference — prevents unnecessary re-renders in memoized consumers.
const EMPTY_SNAPSHOT: ModeStackSnapshot = Object.freeze({
  layers: Object.freeze([]) as readonly ModeStackLayer[],
});

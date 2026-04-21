/**
 * `useModeStack` — GhostHint's projection of the P1-D ModeStack.
 *
 * P1-D owns the canonical `ModeStack`: a stack of currently-active shell
 * modes (pager, REPL, TUI, multiplexer, nested shell, …) surfaced from the
 * session's VT emulator + shell-integration signals. P1-G consumes that
 * stack to decide which ghost hint to render.
 *
 * Registry coupling
 * -----------------
 * The hint registry keys by COMPOSITE kinds (`pager_less`, `repl_python`,
 * `tui_vim`, `multiplexer_tmux`, `shell_nested`) because the key determines
 * the exact instructional text. The ModeStack store on the other hand keys
 * by ABSTRACT kinds (`pager`, `repl`, `tui`, `multiplexer`, `nested-shell`)
 * plus a `hints` record. This hook is the single translation seam: it
 * walks `useModeStackStore`'s layers top→bottom and collapses each layer
 * into one or more `ModeStackLayer` entries whose `kind` matches a
 * registry entry when available. Layers without a mapped app hint (a
 * `pager` layer with no `hints.pagerApp`, for example) still produce an
 * entry keyed by the bare kind so tests and future registries that key by
 * abstract kind continue to resolve.
 *
 * Tests inject their own `stackHook` via `GhostHint`'s prop surface; the
 * production hook simply subscribes to `useModeStackStore` so any driver
 * push/pop immediately re-renders the pill.
 */

import { useMemo } from 'react';
import {
  useModeStackStore,
  type ModeLayer,
} from '../../features/mode-stack/index.js';
import type { GhostHintKind } from './hint-registry.js';

/**
 * A single entry on the mode stack as consumed by `GhostHint`. `kind` is the
 * discriminator the registry keys by; the abstract ModeStack kind is
 * reshaped here into the registry's composite form (`pager_less`,
 * `repl_python`, …) when the layer's hints identify a specific app.
 *
 * `kind` is widened to `GhostHintKind | string` because the upstream stack
 * may surface modes that don't have a ghost hint (AI overlay, composer,
 * selection, …); `GhostHint` ignores those.
 */
export interface ModeStackLayer {
  readonly kind: GhostHintKind | string;
  /** Optional human label — unused by the registry but forwarded for UX. */
  readonly label?: string;
}

export interface ModeStackSnapshot {
  readonly layers: readonly ModeStackLayer[];
}

/**
 * Project one abstract `ModeLayer` into the composite registry kind. Returns
 * `null` when the layer is the immortal shell root (no ghost affordance).
 */
function projectLayer(layer: ModeLayer): ModeStackLayer | null {
  switch (layer.kind) {
    case 'shell':
      // The outer shell root has no ghost-hint affordance — it's the
      // resting state, not a mode the user needs to escape.
      return null;
    case 'pager': {
      const app = layer.hints?.pagerApp;
      if (app === 'less' || app === 'man' || app === 'bat' || app === 'most') {
        // `bat` and `most` both use less-style keybindings; render the
        // `pager_less` hint. `man` has its own entry.
        return {
          kind: app === 'man' ? 'pager_man' : 'pager_less',
        };
      }
      // Unknown pager variant → fall back to the generic `pager_less`
      // hint; the "press q" affordance is correct for every pager.
      return { kind: 'pager_less' };
    }
    case 'repl': {
      const shell = layer.hints?.replShell;
      if (shell === 'python') return { kind: 'repl_python' };
      if (shell === 'node') return { kind: 'repl_node' };
      if (shell === 'psql') return { kind: 'repl_psql' };
      // ruby / unknown → no entry in the current registry; render nothing.
      return null;
    }
    case 'multiplexer':
      return { kind: 'multiplexer_tmux' };
    case 'tui':
      // Abstract `tui` → we don't know which app, the registry covers
      // `tui_vim` and `tui_htop`. A bare `tui` has no composite match;
      // `GhostHint` will fall through to a deeper layer that does match.
      return { kind: 'tui' };
    case 'nested-shell':
      return { kind: 'shell_nested' };
    default:
      return null;
  }
}

/**
 * Production hook — subscribes to `useModeStackStore` and projects the
 * abstract layers into the composite-kind registry form. The `useMemo`
 * stabilises the array reference across identical renders so
 * `GhostHint`'s `useEffect` dependency doesn't thrash.
 */
export function useModeStack(): ModeStackSnapshot {
  const layers = useModeStackStore((s) => s.layers);
  return useMemo<ModeStackSnapshot>(() => {
    const projected: ModeStackLayer[] = [];
    for (const layer of layers) {
      const entry = projectLayer(layer);
      if (entry !== null) projected.push(entry);
    }
    if (projected.length === 0) return EMPTY_SNAPSHOT;
    return { layers: projected };
  }, [layers]);
}

// Stable reference — prevents unnecessary re-renders in memoized consumers.
const EMPTY_SNAPSHOT: ModeStackSnapshot = Object.freeze({
  layers: Object.freeze([]) as readonly ModeStackLayer[],
});

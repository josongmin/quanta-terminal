/**
 * ModeStack — ordered stack of terminal "mode layers".
 *
 * Plan 0005 §P1-D. Replaces the binary `altScreen: on/off` model with an
 * ordered stack where each layer owns its own input / mouse / render policy.
 * Typical nesting examples that the stack expresses 1:1:
 *
 *   [ shell ] → [ shell, tui(vim) ]
 *   [ shell ] → [ shell, multiplexer(tmux) ] → [ shell, multiplexer(tmux),
 *                                                 nested-shell, tui(vim) ]
 *   [ shell ] → [ shell, pager(less) ]
 *   [ shell ] → [ shell, repl(python) ]
 *
 * Drivers in `./drivers/*` push/pop layers in response to stream detection;
 * consumers (status bar, input router, render surface) read the resolved
 * input/mouse/render policy off the top of the stack.
 *
 * The outermost `shell` layer is implicit — it is installed as layer 0 when
 * the store is constructed (and by `reset()`). Drivers push on top of it.
 * This mirrors EPIC-H `depth === 0` semantics: "no TUI is active" means the
 * stack has only the shell layer.
 *
 * Policy resolution rules (P1-D spec, §3):
 *   - Input: walk top→bottom; first layer whose `inputPolicy !== 'passthrough'`
 *     wins. If every layer is passthrough the resolver returns
 *     `'passthrough'` (which is also the outer-shell default).
 *   - Mouse: walk top→bottom; first layer whose `mousePolicy !== 'dropped'`
 *     wins. The "innermost wins" default models DECSET 1002/1003 at the
 *     deepest level taking priority over outer tracking.
 *   - Render hint: the topmost layer's `renderHint` is exposed via
 *     `topRenderHint()`; stacked ghosts below are rendered by UI code that
 *     walks `layers` directly.
 *
 * Identity: every `push` returns a string id; `pop(id)` is the only way to
 * remove a specific layer. `popUntil(kind)` walks down until (and including)
 * the topmost layer of that kind is popped — handy for a driver that learns
 * its layer went away but never saw the explicit exit sequence.
 *
 * Wrapped in `subscribeWithSelector` so non-React code (drivers, installer
 * modules) can subscribe outside the render loop.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

export type LayerKind =
  | 'shell'
  | 'tui'
  | 'pager'
  | 'multiplexer'
  | 'repl'
  | 'nested-shell';

export type InputPolicy = 'passthrough' | 'intercept_prefix' | 'line_edit';
export type MousePolicy = 'innermost_wins' | 'outermost_wins' | 'dropped';
export type RenderHint = 'chrome' | 'ghost' | 'none';

export interface ModeLayerHints {
  readonly pagerApp?: 'less' | 'more' | 'man' | 'most' | 'bat';
  readonly replShell?: 'python' | 'node' | 'psql' | 'ruby';
  readonly multiplexer?: 'tmux' | 'screen';
}

export interface ModeLayer {
  readonly id: string;
  readonly kind: LayerKind;
  readonly enteredAt: number;
  readonly hints?: ModeLayerHints;
  readonly inputPolicy: InputPolicy;
  readonly mousePolicy: MousePolicy;
  readonly renderHint: RenderHint;
}

export interface ModeStackState {
  /** Ordered outermost→innermost. Index 0 is always the shell layer. */
  readonly layers: readonly ModeLayer[];
  /** Monotonic counter used to stamp push/pop ordering across drivers. */
  readonly epoch: number;
}

export interface ModeStackActions {
  /** Push a layer on top. Returns its id. */
  push(layer: Omit<ModeLayer, 'id' | 'enteredAt'>): string;
  /** Pop a specific layer by id. No-op if the id is unknown. */
  pop(id: string): void;
  /** Pop layers from the top until (and including) the topmost of `kind`. */
  popUntil(kind: LayerKind): void;
  /** Return the topmost layer of `kind`, or null if none exists. */
  topmost<K extends LayerKind>(kind: K): ModeLayer | null;
  /** Resolve the input policy for the current stack. */
  resolveInputPolicy(): InputPolicy;
  /** Resolve the mouse policy for the current stack. */
  resolveMousePolicy(): MousePolicy;
  /** Topmost render hint. */
  topRenderHint(): RenderHint;
  /** Reset the stack back to a single `shell` layer. */
  reset(): void;
}

export type ModeStack = ModeStackState & ModeStackActions;

/** Base shell layer: permissive defaults — shell passes input through. */
function makeShellLayer(): ModeLayer {
  return {
    id: 'shell-root',
    kind: 'shell',
    enteredAt: 0,
    inputPolicy: 'passthrough',
    mousePolicy: 'outermost_wins',
    renderHint: 'chrome',
  };
}

const INITIAL: ModeStackState = {
  layers: [makeShellLayer()],
  epoch: 0,
};

/**
 * Walk top→bottom and return the first layer that is not `passthrough`.
 * If none match, return `'passthrough'` — the outer-shell default.
 */
function computeInputPolicy(layers: readonly ModeLayer[]): InputPolicy {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (!layer) continue;
    if (layer.inputPolicy !== 'passthrough') return layer.inputPolicy;
  }
  return 'passthrough';
}

/**
 * "Innermost wins" by default — walk top→bottom, skipping dropped layers,
 * and return the first non-dropped policy. If every layer above shell drops,
 * return the outer layer's policy.
 */
function computeMousePolicy(layers: readonly ModeLayer[]): MousePolicy {
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (!layer) continue;
    if (layer.mousePolicy !== 'dropped') return layer.mousePolicy;
  }
  // Every layer dropped — fallback to the default outermost shell policy.
  return 'outermost_wins';
}

function computeTopRenderHint(layers: readonly ModeLayer[]): RenderHint {
  // The topmost `chrome` layer wins per §3; everything below it is either
  // ghosted or hidden. If no layer declares `chrome`, fall back to the
  // very top's hint so the render surface at least has a signal.
  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    if (!layer) continue;
    if (layer.renderHint === 'chrome') return 'chrome';
  }
  const top = layers[layers.length - 1];
  return top?.renderHint ?? 'none';
}

let nextIdSeq = 0;
function makeLayerId(kind: LayerKind): string {
  nextIdSeq += 1;
  return `${kind}-${nextIdSeq.toString(36)}`;
}

/**
 * Concurrent-epoch tiebreak (P1-D §D5 audit). Drivers that observe the SAME
 * output row can both fire on the same PTY chunk — e.g. a `>>> ` line both
 * satisfies the REPL primary-prompt regex AND the pager bytes-fallback
 * `--More--` buffer when a user runs `less` on a python session log. Without
 * arbitration the stack gains two layers for one semantic mode.
 *
 * Rule — "already-existing top wins, new push coalesces":
 *   If the topmost layer was pushed in the IMMEDIATELY-prior op
 *   (`top.enteredAt === prev.epoch`) AND both layers are drawn from the
 *   competing set {`pager`, `repl`} AND they are different kinds, coalesce
 *   the incoming push — return the existing id, stack unchanged. This is
 *   deliberately narrow: nesting cases (vim-inside-tmux, ssh-inside-tmux)
 *   land in separate dispatch ticks and are NEVER coalesced.
 */
const CONCURRENT_TIEBREAK_KINDS: ReadonlySet<LayerKind> = new Set([
  'pager',
  'repl',
]);

export const useModeStackStore = create<ModeStack>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL,
    push(layer) {
      // Concurrent-epoch tiebreak (pager/repl only): when both fire on the
      // same chunk, the first-wins; the second push coalesces to the same id.
      // See `CONCURRENT_TIEBREAK_KINDS` doc for the full rationale.
      const prev = get();
      const top = prev.layers[prev.layers.length - 1];
      if (
        top !== undefined &&
        top.enteredAt === prev.epoch &&
        CONCURRENT_TIEBREAK_KINDS.has(top.kind) &&
        CONCURRENT_TIEBREAK_KINDS.has(layer.kind) &&
        top.kind !== layer.kind
      ) {
        return top.id;
      }
      const id = makeLayerId(layer.kind);
      set((p) => {
        const epoch = p.epoch + 1;
        const next: ModeLayer = {
          ...layer,
          id,
          enteredAt: epoch,
        };
        return { ...p, layers: [...p.layers, next], epoch };
      });
      return id;
    },
    pop(id) {
      set((prev) => {
        const idx = prev.layers.findIndex((l) => l.id === id);
        if (idx <= 0) {
          // Either unknown id, or attempting to pop the shell root — both are
          // defensive no-ops (the shell root is immortal).
          return prev;
        }
        const layers = [...prev.layers.slice(0, idx), ...prev.layers.slice(idx + 1)];
        return { ...prev, layers, epoch: prev.epoch + 1 };
      });
    },
    popUntil(kind) {
      set((prev) => {
        // Walk top→bottom; find the topmost of `kind` and slice down to it.
        for (let i = prev.layers.length - 1; i >= 1; i -= 1) {
          const layer = prev.layers[i];
          if (layer && layer.kind === kind) {
            return {
              ...prev,
              layers: prev.layers.slice(0, i),
              epoch: prev.epoch + 1,
            };
          }
        }
        return prev;
      });
    },
    topmost(kind) {
      const { layers } = get();
      for (let i = layers.length - 1; i >= 0; i -= 1) {
        const layer = layers[i];
        if (layer && layer.kind === kind) return layer;
      }
      return null;
    },
    resolveInputPolicy() {
      return computeInputPolicy(get().layers);
    },
    resolveMousePolicy() {
      return computeMousePolicy(get().layers);
    },
    topRenderHint() {
      return computeTopRenderHint(get().layers);
    },
    reset() {
      nextIdSeq = 0;
      set(() => ({ ...INITIAL, layers: [makeShellLayer()] }));
    },
  })),
);

/* ------------------------------------------------------------------------ */
/*  React-friendly selector hooks                                             */
/* ------------------------------------------------------------------------ */

/** Read the full stack (layers + epoch). */
export function useModeStack(): {
  readonly layers: readonly ModeLayer[];
  readonly epoch: number;
} {
  return useModeStackStore((s) => ({ layers: s.layers, epoch: s.epoch }));
}

/** Read the topmost layer of a given kind. */
export function useTopmostLayer<K extends LayerKind>(
  kind: K,
): ModeLayer | null {
  return useModeStackStore((s) => {
    for (let i = s.layers.length - 1; i >= 0; i -= 1) {
      const layer = s.layers[i];
      if (layer && layer.kind === kind) return layer;
    }
    return null;
  });
}

/** Read the resolved input/mouse policy pair. */
export function useResolvedPolicies(): {
  readonly input: InputPolicy;
  readonly mouse: MousePolicy;
  readonly renderHint: RenderHint;
} {
  return useModeStackStore((s) => ({
    input: computeInputPolicy(s.layers),
    mouse: computeMousePolicy(s.layers),
    renderHint: computeTopRenderHint(s.layers),
  }));
}

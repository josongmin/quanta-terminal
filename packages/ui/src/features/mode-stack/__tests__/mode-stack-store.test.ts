/**
 * Plan 0005 §P1-D — ModeStack store exit gate E-D-01.
 *
 * Covers push/pop/popUntil, topmost lookup, and the §3 policy-resolution rules
 * (input walk top→bottom, first non-passthrough wins; mouse walk top→bottom,
 * first non-dropped wins; renderHint — topmost `chrome` wins).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  useModeStackStore,
  type LayerKind,
  type ModeLayer,
} from '../mode-stack-store.js';

function layer(
  overrides: Partial<Omit<ModeLayer, 'id' | 'enteredAt'>> & {
    readonly kind: LayerKind;
  },
): Omit<ModeLayer, 'id' | 'enteredAt'> {
  const base: Omit<ModeLayer, 'id' | 'enteredAt'> = {
    kind: overrides.kind,
    inputPolicy: overrides.inputPolicy ?? 'passthrough',
    mousePolicy: overrides.mousePolicy ?? 'dropped',
    renderHint: overrides.renderHint ?? 'none',
  };
  return overrides.hints ? { ...base, hints: overrides.hints } : base;
}

describe('mode-stack store', () => {
  beforeEach(() => {
    useModeStackStore.getState().reset();
  });

  it('boots with a single shell layer and a passthrough input policy', () => {
    const s = useModeStackStore.getState();
    expect(s.layers).toHaveLength(1);
    expect(s.layers[0]?.kind).toBe('shell');
    expect(s.resolveInputPolicy()).toBe('passthrough');
  });

  it('push returns a unique id and appends to layers', () => {
    const s = useModeStackStore.getState();
    const idA = s.push(layer({ kind: 'tui' }));
    const idB = s.push(layer({ kind: 'pager' }));
    expect(idA).not.toBe(idB);
    const next = useModeStackStore.getState();
    expect(next.layers).toHaveLength(3);
    expect(next.layers[1]?.kind).toBe('tui');
    expect(next.layers[2]?.kind).toBe('pager');
    // epoch has advanced; enteredAt stamps are monotonic.
    expect(next.layers[2]?.enteredAt).toBeGreaterThan(next.layers[1]?.enteredAt ?? 0);
  });

  it('pop removes a specific id; unknown id is a no-op', () => {
    const s = useModeStackStore.getState();
    const idA = s.push(layer({ kind: 'tui' }));
    const idB = s.push(layer({ kind: 'pager' }));
    useModeStackStore.getState().pop('does-not-exist');
    expect(useModeStackStore.getState().layers).toHaveLength(3);
    useModeStackStore.getState().pop(idA);
    const layers = useModeStackStore.getState().layers;
    expect(layers.map((l) => l.kind)).toEqual(['shell', 'pager']);
    expect(layers.find((l) => l.id === idB)).toBeDefined();
  });

  it('pop cannot remove the shell root layer', () => {
    const s = useModeStackStore.getState();
    s.pop('shell-root');
    expect(useModeStackStore.getState().layers[0]?.kind).toBe('shell');
  });

  it('popUntil removes layers down to and including the topmost of kind', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'multiplexer' }));
    s.push(layer({ kind: 'nested-shell' }));
    s.push(layer({ kind: 'tui' }));
    s.push(layer({ kind: 'pager' }));
    useModeStackStore.getState().popUntil('nested-shell');
    const kinds = useModeStackStore.getState().layers.map((l) => l.kind);
    expect(kinds).toEqual(['shell', 'multiplexer']);
  });

  it('popUntil of unknown kind is a no-op', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'tui' }));
    const before = useModeStackStore.getState().layers.length;
    useModeStackStore.getState().popUntil('pager');
    expect(useModeStackStore.getState().layers.length).toBe(before);
  });

  it('topmost returns the deepest matching layer; null when absent', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'multiplexer' }));
    s.push(layer({ kind: 'multiplexer' }));
    s.push(layer({ kind: 'tui' }));
    const top = useModeStackStore.getState().topmost('multiplexer');
    expect(top?.kind).toBe('multiplexer');
    // "topmost" means the most-recently pushed of that kind — index 2, not 1.
    expect(top?.enteredAt).toBeGreaterThan(0);
    expect(useModeStackStore.getState().topmost('pager')).toBeNull();
  });

  it('input resolution: first non-passthrough from top wins', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'tui', inputPolicy: 'intercept_prefix' }));
    s.push(layer({ kind: 'pager', inputPolicy: 'passthrough' }));
    // pager is top and passthrough, so we fall through to tui's intercept.
    expect(useModeStackStore.getState().resolveInputPolicy()).toBe(
      'intercept_prefix',
    );
  });

  it('input resolution: all passthrough yields passthrough', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'tui', inputPolicy: 'passthrough' }));
    s.push(layer({ kind: 'multiplexer', inputPolicy: 'passthrough' }));
    expect(useModeStackStore.getState().resolveInputPolicy()).toBe('passthrough');
  });

  it('mouse resolution: innermost non-dropped wins (DECSET 1002/1003)', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'multiplexer', mousePolicy: 'outermost_wins' }));
    s.push(layer({ kind: 'tui', mousePolicy: 'innermost_wins' }));
    expect(useModeStackStore.getState().resolveMousePolicy()).toBe(
      'innermost_wins',
    );
  });

  it('mouse resolution: top-dropped falls through to deeper layer', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'multiplexer', mousePolicy: 'innermost_wins' }));
    s.push(layer({ kind: 'pager', mousePolicy: 'dropped' }));
    // pager drops mouse; fall through to multiplexer.
    expect(useModeStackStore.getState().resolveMousePolicy()).toBe(
      'innermost_wins',
    );
  });

  it('render hint: topmost `chrome` wins; ghost layers do not', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'tui', renderHint: 'chrome' }));
    s.push(layer({ kind: 'pager', renderHint: 'ghost' }));
    expect(useModeStackStore.getState().topRenderHint()).toBe('chrome');
  });

  it('render hint: no `chrome` layer → top layer wins (fallback)', () => {
    const s = useModeStackStore.getState();
    // Reset removes the shell root's chrome, replace with a bare stack.
    useModeStackStore.setState((prev) => ({
      ...prev,
      layers: [
        {
          ...(prev.layers[0] as ModeLayer),
          renderHint: 'none',
        },
      ],
    }));
    s.push(layer({ kind: 'tui', renderHint: 'ghost' }));
    expect(useModeStackStore.getState().topRenderHint()).toBe('ghost');
  });

  it('reset clears every pushed layer and rewinds the epoch', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'tui' }));
    s.push(layer({ kind: 'pager' }));
    expect(useModeStackStore.getState().layers).toHaveLength(3);
    useModeStackStore.getState().reset();
    const after = useModeStackStore.getState();
    expect(after.layers).toHaveLength(1);
    expect(after.layers[0]?.kind).toBe('shell');
    expect(after.epoch).toBe(0);
  });

  it('depth-3 nested stack: tmux/ssh/tmux layers all retained and resolve innermost mouse', () => {
    const s = useModeStackStore.getState();
    s.push(layer({ kind: 'multiplexer', mousePolicy: 'outermost_wins' }));
    s.push(layer({ kind: 'nested-shell', mousePolicy: 'dropped' }));
    s.push(
      layer({
        kind: 'multiplexer',
        mousePolicy: 'innermost_wins',
        inputPolicy: 'intercept_prefix',
        renderHint: 'chrome',
      }),
    );
    const top = useModeStackStore.getState();
    expect(top.layers).toHaveLength(4);
    // Innermost tmux "claims" the mouse via the innermost_wins policy.
    expect(top.resolveMousePolicy()).toBe('innermost_wins');
    // Innermost multiplexer intercepts (e.g. C-b prefix key).
    expect(top.resolveInputPolicy()).toBe('intercept_prefix');
    expect(top.topRenderHint()).toBe('chrome');
  });
});

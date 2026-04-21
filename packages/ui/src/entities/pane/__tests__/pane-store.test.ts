/**
 * Pane tree store tests.
 *
 * Covers the contract the PaneGrid widget and the pane-tabs feature rely on:
 *   - setRoot seeds the tree with a single leaf and is idempotent.
 *   - splitActive replaces the focused leaf with a split whose right child is
 *     the new leaf; focus moves to the right child.
 *   - Nested splits produce three+ panes in deterministic left-to-right order.
 *   - closeActive removes a leaf; a 1-of-2 split collapses back to a leaf.
 *   - focusSibling cycles through leaves in visit order.
 *   - setRatio clamps to [0.1, 0.9].
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { usePaneStore, collectLeaves, nodeAt } from '../index.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;
const C = 'sess-c' as SessionId;
const D = 'sess-d' as SessionId;

beforeEach(() => {
  usePaneStore.getState().reset();
});

describe('usePaneStore — setRoot', () => {
  it('seeds the tree with a single leaf', () => {
    usePaneStore.getState().setRoot(A);
    const s = usePaneStore.getState();
    expect(s.root).toEqual({ kind: 'leaf', sessionId: A });
    expect(s.focusPath).toEqual([]);
  });

  it('is idempotent when the same session id is set again', () => {
    usePaneStore.getState().setRoot(A);
    const before = usePaneStore.getState().root;
    usePaneStore.getState().setRoot(A);
    expect(usePaneStore.getState().root).toBe(before);
  });

  it('does NOT overwrite an existing tree with a different seed', () => {
    usePaneStore.getState().setRoot(A);
    usePaneStore.getState().setRoot(B);
    // root is unchanged — second setRoot is a no-op once a tree exists.
    const leaves = collectLeaves(usePaneStore.getState().root);
    expect(leaves).toHaveLength(1);
    expect(leaves[0]?.sessionId).toBe(A);
  });
});

describe('usePaneStore — splitActive', () => {
  it('splits a single leaf into a split with horizontal direction', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);

    const next = usePaneStore.getState();
    expect(next.root).toBeTruthy();
    expect(next.root?.kind).toBe('split');
    if (next.root?.kind !== 'split') throw new Error('expected split');
    expect(next.root.dir).toBe('horizontal');
    expect(next.root.left).toEqual({ kind: 'leaf', sessionId: A });
    expect(next.root.right).toEqual({ kind: 'leaf', sessionId: B });
    // Focus moves to the new (right) leaf.
    expect(next.focusPath).toEqual([1]);
  });

  it('supports nested splits producing 3+ panes', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B); // A | B, focus on B
    s.splitActive('vertical', C); // A | (B stacked over C), focus on C
    s.splitActive('horizontal', D); // A | (B / (C | D)), focus on D

    const leaves = collectLeaves(usePaneStore.getState().root);
    expect(leaves.map((l) => l.sessionId)).toEqual([A, B, C, D]);
  });
});

describe('usePaneStore — closeActive', () => {
  it('removes the focused leaf from a single-leaf tree', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    const closed = s.closeActive();
    expect(closed).toBe(A);
    expect(usePaneStore.getState().root).toBeNull();
  });

  it('collapses a split when it has only one child left (leaf promote)', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);
    // Focus is on B after split.
    const closed = s.closeActive();
    expect(closed).toBe(B);

    const next = usePaneStore.getState();
    expect(next.root).toEqual({ kind: 'leaf', sessionId: A });
  });

  it('keeps the deeper siblings intact when a non-trivial split closes', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B); // focus on B, path [1]
    s.splitActive('vertical', C); // focus on C, path [1, 1]

    s.closeActive(); // close C; parent split collapses into B

    const leaves = collectLeaves(usePaneStore.getState().root);
    expect(leaves.map((l) => l.sessionId)).toEqual([A, B]);
  });
});

describe('usePaneStore — focus cycling', () => {
  it('cycles focus through leaves in left-to-right order', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B); // focus on B
    s.splitActive('vertical', C); // focus on C

    // Reset focus to the first leaf (A).
    s.focusSession(A);
    expect(usePaneStore.getState().focusPath).toEqual([0]);

    s.focusSibling(1);
    // Next leaf in visit order is B, whose path is [1, 0] (B is under the
    // horizontal split's right child, which is now a vertical split whose
    // left is B).
    const leaves = collectLeaves(usePaneStore.getState().root);
    const focusAfter = usePaneStore.getState().focusPath;
    const focused = leaves.find((l) => pathEq(l.path, focusAfter));
    expect(focused?.sessionId).toBe(B);

    s.focusSibling(1);
    const focused2 = leaves.find((l) =>
      pathEq(l.path, usePaneStore.getState().focusPath),
    );
    expect(focused2?.sessionId).toBe(C);

    // Wrap-around.
    s.focusSibling(1);
    const focused3 = leaves.find((l) =>
      pathEq(l.path, usePaneStore.getState().focusPath),
    );
    expect(focused3?.sessionId).toBe(A);
  });
});

describe('usePaneStore — setRatio', () => {
  it('updates the ratio of a split node', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);
    s.setRatio([], 0.75);

    const root = usePaneStore.getState().root;
    if (root?.kind !== 'split') throw new Error('expected split');
    expect(root.ratio).toBeCloseTo(0.75);
  });

  it('clamps ratio into [0.1, 0.9] (min size enforcement)', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);

    s.setRatio([], 0.01);
    const rootLo = usePaneStore.getState().root;
    if (rootLo?.kind !== 'split') throw new Error('expected split');
    expect(rootLo.ratio).toBeCloseTo(0.1);

    s.setRatio([], 0.99);
    const rootHi = usePaneStore.getState().root;
    if (rootHi?.kind !== 'split') throw new Error('expected split');
    expect(rootHi.ratio).toBeCloseTo(0.9);
  });

  it('no-ops when the path does not resolve to a split', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    const before = usePaneStore.getState().root;
    s.setRatio([], 0.75); // root is a leaf, should be no-op
    expect(usePaneStore.getState().root).toBe(before);
  });
});

describe('usePaneStore — nodeAt', () => {
  it('returns the node at an empty path (root itself)', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    expect(nodeAt(usePaneStore.getState().root, [])).toEqual({
      kind: 'leaf',
      sessionId: A,
    });
  });

  it('walks into split children', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);
    const leftLeaf = nodeAt(usePaneStore.getState().root, [0]);
    const rightLeaf = nodeAt(usePaneStore.getState().root, [1]);
    expect(leftLeaf).toEqual({ kind: 'leaf', sessionId: A });
    expect(rightLeaf).toEqual({ kind: 'leaf', sessionId: B });
  });
});

describe('usePaneStore — zoom', () => {
  it('zoomPane sets zoomedPaneId and unzoomPane clears it', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);

    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
    s.zoomPane(A);
    expect(usePaneStore.getState().zoomedPaneId).toBe(A);

    s.unzoomPane();
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it('zoomPane ignores ids that are not leaves in the tree', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);
    s.zoomPane('ghost' as SessionId);
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it('toggleZoomFocusedPane zooms the focused leaf, then restores on repeat', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B); // focus on B (path [1])

    s.toggleZoomFocusedPane();
    expect(usePaneStore.getState().zoomedPaneId).toBe(B);

    s.toggleZoomFocusedPane();
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it('toggleZoomFocusedPane with a non-focused zoom target moves zoom to the focus', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B); // focus on B
    s.zoomPane(A); // zoom the non-focused leaf
    expect(usePaneStore.getState().zoomedPaneId).toBe(A);

    // Toggling while B is focused should RE-zoom onto B, not unzoom.
    s.toggleZoomFocusedPane();
    expect(usePaneStore.getState().zoomedPaneId).toBe(B);
  });

  it('closing the zoomed pane clears zoomedPaneId (layout restored)', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B); // focus on B
    s.zoomPane(B);
    expect(usePaneStore.getState().zoomedPaneId).toBe(B);

    s.closeActive(); // closes B
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it('closing a non-zoomed pane preserves zoomedPaneId when the zoomed leaf survives', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B); // focus on B
    s.splitActive('vertical', C); // focus on C, path [1, 1]
    s.zoomPane(A);

    s.closeActive(); // close C; A still exists
    expect(usePaneStore.getState().zoomedPaneId).toBe(A);
  });

  it('splitActive while zoomed unzooms first', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);
    s.zoomPane(B);
    expect(usePaneStore.getState().zoomedPaneId).toBe(B);

    s.splitActive('vertical', C);
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it('toggleZoomFocusedPane is a no-op on an empty tree', () => {
    const s = usePaneStore.getState();
    expect(usePaneStore.getState().root).toBeNull();
    s.toggleZoomFocusedPane();
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
  });

  it('reset clears zoom alongside the tree', () => {
    const s = usePaneStore.getState();
    s.setRoot(A);
    s.splitActive('horizontal', B);
    s.zoomPane(A);
    s.reset();
    expect(usePaneStore.getState().zoomedPaneId).toBeNull();
    expect(usePaneStore.getState().root).toBeNull();
  });
});

function pathEq(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

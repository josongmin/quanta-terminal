/**
 * Pane tree — binary tree of session panes for split-screen layouts.
 *
 * Shape
 * -----
 * A `PaneNode` is either a leaf carrying a `SessionId` or a split whose two
 * children (`left`, `right`) are themselves `PaneNode`s. The `dir` flag on a
 * split describes the direction of the SPLIT LINE between the children:
 *   - 'horizontal' → left/right (children side by side, vertical splitter)
 *   - 'vertical'   → top/bottom (children stacked,   horizontal splitter)
 * We follow the iTerm2/VS Code convention where "horizontal split" means the
 * panes sit side-by-side (the user drew a vertical line to split).
 *
 * The focused pane is identified by `focusPath`, a sequence of 0/1 steps that
 * walk from the root (0 = left/top child, 1 = right/bottom child). An empty
 * path means the root itself is the focused leaf — correct for the default
 * single-pane layout.
 *
 * Not persisted — per-launch. Matches `useSessionsStore` semantics.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { SessionId } from '../../shared/types/generated/index.js';

export type SplitDir = 'horizontal' | 'vertical';
export type FocusDir = 'left' | 'right' | 'up' | 'down';

export interface PaneLeaf {
  readonly kind: 'leaf';
  readonly sessionId: SessionId;
}

export interface PaneSplit {
  readonly kind: 'split';
  readonly dir: SplitDir;
  readonly ratio: number;
  readonly left: PaneNode;
  readonly right: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface PaneState {
  /** Root of the pane tree. `null` when no sessions have been registered. */
  readonly root: PaneNode | null;
  /** Path of 0/1 steps from the root to the focused leaf. */
  readonly focusPath: readonly number[];
  /**
   * Session id of the currently "zoomed" (maximized) pane, or `null` when the
   * split layout is rendered normally. Zoom mode hides every non-matching
   * leaf visually while preserving the tree, so restore is lossless. Stored
   * as the session id (not the focus path) so tree restructuring — focus
   * moves, ratio tweaks — doesn't desync the zoom target.
   */
  readonly zoomedPaneId: SessionId | null;
}

export interface PaneActions {
  /**
   * Seed the tree with a single leaf. Idempotent — if the tree already has a
   * leaf for this session id, the call is a no-op.
   */
  setRoot(sessionId: SessionId): void;
  /**
   * Replace the currently-focused leaf with a split whose left child is the
   * original leaf and right child is a new leaf carrying `newSessionId`.
   * Focus moves to the new (right) child. No-op when `root` is null.
   */
  splitActive(dir: SplitDir, newSessionId: SessionId): void;
  /**
   * Close the currently-focused leaf. Its sibling takes the split's slot
   * (the parent is collapsed). When the focused leaf is the root the tree
   * is cleared entirely. Returns the session id of the closed leaf for the
   * caller to tear down the PTY, or `null` if there was nothing to close.
   */
  closeActive(): SessionId | null;
  /**
   * Move focus to the nearest leaf in the given direction. Traverses the tree
   * using the split directions + the current focusPath — if no neighbor exists
   * in the requested direction, focus is unchanged.
   */
  focusNext(dir: FocusDir): void;
  /** Move focus to the next / previous leaf in the left-to-right visit order. */
  focusSibling(delta: 1 | -1): void;
  /** Focus a leaf by its session id. No-op when the id is not in the tree. */
  focusSession(id: SessionId): void;
  /**
   * Update the ratio of a split node identified by its path. No-op if the
   * path does not resolve to a split, or if the ratio is out of range
   * (clamped to [0.1, 0.9] to prevent a pane from collapsing to zero).
   */
  setRatio(path: readonly number[], ratio: number): void;
  /**
   * Maximize the pane carrying `sessionId` so its sibling leaves are
   * visually hidden (the tree is preserved). No-op when the id is not a
   * leaf in the current tree.
   */
  zoomPane(sessionId: SessionId): void;
  /** Restore the split layout. Idempotent when no pane is zoomed. */
  unzoomPane(): void;
  /**
   * Toggle the zoom state of the currently-focused leaf. If that leaf is
   * already the zoomed pane it unzooms; otherwise it zooms in. No-op when
   * the focused node is not a leaf (empty tree).
   */
  toggleZoomFocusedPane(): void;
  /** Test helper — wipe everything. */
  reset(): void;
}

const INITIAL: PaneState = {
  root: null,
  focusPath: [],
  zoomedPaneId: null,
};

/**
 * Walk the tree following `path`. Returns `null` when the path runs off a
 * leaf or the node at `path` is not present.
 */
export function nodeAt(root: PaneNode | null, path: readonly number[]): PaneNode | null {
  if (!root) return null;
  let cur: PaneNode = root;
  for (const step of path) {
    if (cur.kind !== 'split') return null;
    cur = step === 0 ? cur.left : cur.right;
  }
  return cur;
}

/**
 * Collect the session ids of every leaf in the tree in left-to-right visit
 * order. Used for `focusSibling` and to enumerate the tree from tests.
 */
export function collectLeaves(
  root: PaneNode | null,
): Array<{ readonly sessionId: SessionId; readonly path: number[] }> {
  const out: Array<{ sessionId: SessionId; path: number[] }> = [];
  const walk = (node: PaneNode, path: number[]): void => {
    if (node.kind === 'leaf') {
      out.push({ sessionId: node.sessionId, path });
      return;
    }
    walk(node.left, [...path, 0]);
    walk(node.right, [...path, 1]);
  };
  if (root) walk(root, []);
  return out;
}

/**
 * Replace the node at `path` by applying `replacer`. Returns a new tree;
 * structural sharing keeps unchanged subtrees referentially equal. When
 * `replacer` returns `null`, the node is deleted and its sibling is hoisted
 * into the split's slot; if the deletion bubbles up to the root, the result
 * is `null`.
 */
function replaceAt(
  root: PaneNode,
  path: readonly number[],
  replacer: (n: PaneNode) => PaneNode | null,
): PaneNode | null {
  if (path.length === 0) {
    return replacer(root);
  }
  if (root.kind !== 'split') {
    // Path is invalid — overshoots a leaf. Return tree unchanged.
    return root;
  }
  const step = path[0];
  const rest = path.slice(1);
  if (step === 0) {
    const nextLeft = replaceAt(root.left, rest, replacer);
    if (nextLeft === null) return root.right; // sibling hoist
    if (nextLeft === root.left) return root;
    return { ...root, left: nextLeft };
  }
  const nextRight = replaceAt(root.right, rest, replacer);
  if (nextRight === null) return root.left; // sibling hoist
  if (nextRight === root.right) return root;
  return { ...root, right: nextRight };
}

/**
 * After a sibling hoist the current focusPath may land on a node that no
 * longer exists. This walks the (possibly new) tree and returns the nearest
 * valid leaf path by chopping trailing steps and then following the right
 * child when the chopped prefix lands on a split.
 */
function reconcileFocus(root: PaneNode | null, path: readonly number[]): number[] {
  if (!root) return [];
  // Chop steps until `nodeAt` returns a valid node.
  let pathCopy = path.slice();
  while (pathCopy.length > 0 && nodeAt(root, pathCopy) === null) {
    pathCopy = pathCopy.slice(0, -1);
  }
  // If the landing node is a split, descend into the right-most leaf (the
  // sibling that was just hoisted is typically to the left of the deleted
  // pane). We prefer the "nearest" leaf; right-descent is stable.
  let cur: PaneNode | null = nodeAt(root, pathCopy);
  while (cur && cur.kind === 'split') {
    pathCopy.push(0); // pick left child by convention
    cur = cur.left;
  }
  return pathCopy;
}

/**
 * Resolve direction-based focus movement. Walks UP the tree looking for the
 * first ancestor whose split direction matches the requested axis and whose
 * relationship to the descent allows movement in the requested direction.
 * If found, descends from the OTHER child into the leaf most adjacent to
 * the axis crossing.
 */
function moveFocusByDirection(
  root: PaneNode,
  path: readonly number[],
  dir: FocusDir,
): number[] | null {
  const axis: SplitDir = dir === 'left' || dir === 'right' ? 'horizontal' : 'vertical';
  const forward = dir === 'right' || dir === 'down';
  // Walk up from the deepest ancestor.
  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const ancestorPath = path.slice(0, depth);
    const ancestor = nodeAt(root, ancestorPath);
    if (!ancestor || ancestor.kind !== 'split' || ancestor.dir !== axis) continue;
    const childStep = path[depth];
    // To move `forward` we must currently be on the LEFT side (step === 0).
    // To move backward we must be on the RIGHT side (step === 1).
    if (forward && childStep === 0) {
      // Descend into the right subtree, picking adjacency to the split line.
      return [...ancestorPath, 1, ...descendAdjacent(ancestor.right, axis, /* fromForward */ true)];
    }
    if (!forward && childStep === 1) {
      return [...ancestorPath, 0, ...descendAdjacent(ancestor.left, axis, /* fromForward */ false)];
    }
  }
  return null;
}

/**
 * Descend into a subtree, picking the child that sits closest to the axis
 * crossing the caller just stepped over. For horizontal siblings this means
 * "prefer the left child of a horizontal split to stay near the splitter",
 * etc. For splits orthogonal to the movement axis we arbitrarily descend
 * into the left child (first visit order).
 */
function descendAdjacent(node: PaneNode, axis: SplitDir, fromForward: boolean): number[] {
  const out: number[] = [];
  let cur: PaneNode = node;
  while (cur.kind === 'split') {
    if (cur.dir === axis) {
      // The child nearest the just-crossed splitter is 0 when we stepped
      // forward (we want the left-most leaf of the right subtree) and 1
      // when we stepped backward.
      const step = fromForward ? 0 : 1;
      out.push(step);
      cur = step === 0 ? cur.left : cur.right;
    } else {
      out.push(0);
      cur = cur.left;
    }
  }
  return out;
}

export const usePaneStore = create<PaneState & PaneActions>()(
  subscribeWithSelector((set, get) => ({
    ...INITIAL,

    setRoot: (sessionId) =>
      set((prev) => {
        if (prev.root && prev.root.kind === 'leaf' && prev.root.sessionId === sessionId) {
          return prev;
        }
        if (prev.root) return prev; // only seed when empty
        return {
          root: { kind: 'leaf', sessionId },
          focusPath: [],
        };
      }),

    splitActive: (dir, newSessionId) =>
      set((prev) => {
        if (!prev.root) {
          return {
            root: { kind: 'leaf', sessionId: newSessionId },
            focusPath: [],
            zoomedPaneId: null,
          };
        }
        const nextRoot = replaceAt(prev.root, prev.focusPath, (node) => {
          if (node.kind !== 'leaf') return node;
          return {
            kind: 'split',
            dir,
            ratio: 0.5,
            left: node,
            right: { kind: 'leaf', sessionId: newSessionId },
          };
        });
        if (nextRoot === null || nextRoot === prev.root) return prev;
        // Focus moves to the new (right) child. Splitting while zoomed
        // unzooms first — the intuitive outcome is that the user sees the
        // newly-created split, not a single maximized pane with a hidden
        // sibling. (tmux / iTerm2 behave the same way.)
        return {
          root: nextRoot,
          focusPath: [...prev.focusPath, 1],
          zoomedPaneId: null,
        };
      }),

    closeActive: () => {
      const prev = get();
      if (!prev.root) return null;
      const target = nodeAt(prev.root, prev.focusPath);
      if (!target || target.kind !== 'leaf') return null;
      const closedId = target.sessionId;
      // Closing the zoomed pane restores the layout — otherwise the UI
      // would remain in zoom mode but have no matching leaf, hiding all
      // remaining panes.
      const nextZoom = prev.zoomedPaneId === closedId ? null : prev.zoomedPaneId;
      if (prev.focusPath.length === 0) {
        set({ root: null, focusPath: [], zoomedPaneId: null });
        return closedId;
      }
      const parentPath = prev.focusPath.slice(0, -1);
      const nextRoot = replaceAt(prev.root, prev.focusPath, () => null);
      const nextFocus = reconcileFocus(nextRoot, parentPath);
      set({ root: nextRoot, focusPath: nextFocus, zoomedPaneId: nextZoom });
      return closedId;
    },

    focusNext: (dir) =>
      set((prev) => {
        if (!prev.root) return prev;
        const next = moveFocusByDirection(prev.root, prev.focusPath, dir);
        if (!next) return prev;
        return { ...prev, focusPath: next };
      }),

    focusSibling: (delta) =>
      set((prev) => {
        if (!prev.root) return prev;
        const leaves = collectLeaves(prev.root);
        if (leaves.length < 2) return prev;
        const idx = leaves.findIndex(
          (l) => pathEq(l.path, prev.focusPath),
        );
        const curIdx = idx < 0 ? 0 : idx;
        const nextIdx = (curIdx + delta + leaves.length) % leaves.length;
        const nextLeaf = leaves[nextIdx];
        if (!nextLeaf) return prev;
        return { ...prev, focusPath: nextLeaf.path };
      }),

    focusSession: (id) =>
      set((prev) => {
        if (!prev.root) return prev;
        const leaves = collectLeaves(prev.root);
        const match = leaves.find((l) => l.sessionId === id);
        if (!match) return prev;
        return { ...prev, focusPath: match.path };
      }),

    setRatio: (path, ratio) =>
      set((prev) => {
        if (!prev.root) return prev;
        if (!Number.isFinite(ratio)) return prev;
        const clamped = Math.min(0.9, Math.max(0.1, ratio));
        const nextRoot = replaceAt(prev.root, path, (node) => {
          if (node.kind !== 'split') return node;
          if (node.ratio === clamped) return node;
          return { ...node, ratio: clamped };
        });
        if (nextRoot === null || nextRoot === prev.root) return prev;
        return { ...prev, root: nextRoot };
      }),

    zoomPane: (sessionId) =>
      set((prev) => {
        if (!prev.root) return prev;
        // Only allow zoom on a leaf that actually exists in the tree —
        // callers should never pass a stale id, but guarding here means a
        // concurrent close that races with a palette click can't leave the
        // store pointing at a ghost.
        const leaves = collectLeaves(prev.root);
        const exists = leaves.some((l) => l.sessionId === sessionId);
        if (!exists) return prev;
        if (prev.zoomedPaneId === sessionId) return prev;
        return { ...prev, zoomedPaneId: sessionId };
      }),

    unzoomPane: () =>
      set((prev) => {
        if (prev.zoomedPaneId === null) return prev;
        return { ...prev, zoomedPaneId: null };
      }),

    toggleZoomFocusedPane: () =>
      set((prev) => {
        if (!prev.root) return prev;
        const leaf = nodeAt(prev.root, prev.focusPath);
        if (!leaf || leaf.kind !== 'leaf') return prev;
        // Already zoomed on this leaf → unzoom. Zoomed on a different leaf
        // or not zoomed at all → zoom onto the focused leaf. Toggling the
        // focused leaf (rather than the stored target) matches the
        // tmux prefix-Z behaviour: the key always operates on "what you
        // have focused right now".
        if (prev.zoomedPaneId === leaf.sessionId) {
          return { ...prev, zoomedPaneId: null };
        }
        return { ...prev, zoomedPaneId: leaf.sessionId };
      }),

    reset: () => set(() => ({ ...INITIAL })),
  })),
);

function pathEq(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/** Convenience: the session id of the currently focused leaf. */
export function getActivePaneSessionId(): SessionId | null {
  const s = usePaneStore.getState();
  const n = nodeAt(s.root, s.focusPath);
  return n && n.kind === 'leaf' ? n.sessionId : null;
}

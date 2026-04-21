/**
 * Block-filter entity — a tiny zustand store holding the active tag filter.
 *
 * Shape
 * -----
 * `activeTags` is a `Set<string>` of normalized tags (lowercase, already
 * validated by the block model). `mode` is either `'any'` (block matches if
 * it has at least one active tag — the OR semantics, most useful day-to-day)
 * or `'all'` (block must carry every active tag — AND semantics, for power
 * users narrowing to the intersection).
 *
 * The store is deliberately independent of the block entity: the filter does
 * not need to know about block ids, chunks, or lifecycle. The BlockList
 * composes both stores via a selector hook (`useFilteredBlockIds`) that lives
 * in this file — keeping it here so the "filter a list by tags" logic is
 * co-located with its state.
 *
 * Empty-filter contract
 * ---------------------
 * When `activeTags.size === 0` the filter is inert — every id passes. This
 * keeps the feature invisible until the user enables it (adds a tag to the
 * filter bar) without BlockList needing a separate "is filter active" branch
 * in its hot render path.
 */

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { normalizeTag, useBlockStore, type BlockState } from '../block/index.js';

export type FilterMode = 'any' | 'all';

export interface BlockFilterState {
  readonly activeTags: ReadonlySet<string>;
  readonly mode: FilterMode;
}

export interface BlockFilterActions {
  /** Toggle a tag in/out of the active set. Normalizes input. */
  toggleTag(tag: string): void;
  /** Add a tag to the active set (no-op when already present). */
  addTag(tag: string): void;
  /** Remove a tag from the active set. */
  removeTag(tag: string): void;
  /** Flip between `any` and `all` semantics. */
  setMode(mode: FilterMode): void;
  /** Clear everything — restores the "no filter" state. */
  clear(): void;
}

const INITIAL: BlockFilterState = {
  activeTags: new Set<string>(),
  mode: 'any',
};

export const useBlockFilterStore = create<BlockFilterState & BlockFilterActions>((set) => ({
  ...INITIAL,

  toggleTag: (rawTag) => {
    const t = normalizeTag(rawTag);
    if (t.length === 0) return;
    set((prev) => {
      const next = new Set(prev.activeTags);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return { ...prev, activeTags: next };
    });
  },

  addTag: (rawTag) => {
    const t = normalizeTag(rawTag);
    if (t.length === 0) return;
    set((prev) => {
      if (prev.activeTags.has(t)) return prev;
      const next = new Set(prev.activeTags);
      next.add(t);
      return { ...prev, activeTags: next };
    });
  },

  removeTag: (rawTag) => {
    const t = normalizeTag(rawTag);
    if (t.length === 0) return;
    set((prev) => {
      if (!prev.activeTags.has(t)) return prev;
      const next = new Set(prev.activeTags);
      next.delete(t);
      return { ...prev, activeTags: next };
    });
  },

  setMode: (mode) => set((prev) => (prev.mode === mode ? prev : { ...prev, mode })),

  clear: () =>
    set((prev) =>
      prev.activeTags.size === 0 && prev.mode === 'any'
        ? prev
        : { activeTags: new Set<string>(), mode: 'any' },
    ),
}));

/**
 * Pure predicate — does the tag set on a block pass the active filter?
 * Empty active set always passes (see file docblock). Exported for
 * consumers that already hold a block reference (BlockList row renderer).
 */
export function blockPassesFilter(
  blockTags: readonly string[],
  active: ReadonlySet<string>,
  mode: FilterMode,
): boolean {
  if (active.size === 0) return true;
  if (mode === 'any') {
    for (const t of blockTags) {
      if (active.has(t)) return true;
    }
    return false;
  }
  // 'all': every active tag must be present on the block.
  for (const t of active) {
    if (!blockTags.includes(t)) return false;
  }
  return true;
}

/**
 * Filter a block-id list against the current filter state. When no tags are
 * active, returns the input array unchanged (same reference where possible)
 * so BlockList's memo stays identity-stable in the hot "no filter" path.
 */
export function filterBlockIds(
  ids: readonly string[],
  state: BlockState,
  filter: BlockFilterState,
): readonly string[] {
  if (filter.activeTags.size === 0) return ids;
  const out: string[] = [];
  for (const id of ids) {
    const b = state.entities[id];
    if (!b) continue;
    if (blockPassesFilter(b.tags, filter.activeTags, filter.mode)) out.push(id);
  }
  return out;
}

/**
 * Hook: subscribe to the current filter snapshot. Shallow-compared so the
 * returned object is stable across unrelated store mutations (the `Set`
 * reference changes on every action, which is intentional — downstream
 * selectors recompute only when we actually edit the filter).
 */
export function useBlockFilter(): BlockFilterState {
  return useBlockFilterStore(
    useShallow((s) => ({ activeTags: s.activeTags, mode: s.mode })),
  );
}

/**
 * Hook: the filtered id list for a given (pre-scoped) input. BlockList already
 * scopes by session via `useBlocksForSession`; this hook layers the tag filter
 * on top. Shallow-compared array reference so unrelated block mutations don't
 * invalidate downstream memos.
 */
export function useFilteredBlockIds(ids: readonly string[]): readonly string[] {
  const filter = useBlockFilter();
  return useBlockStore(
    useShallow((s: BlockState) => filterBlockIds(ids, s, filter)),
  );
}

/**
 * Count blocks passing the filter for a given pre-scoped id list. Used by
 * BlockFilterBar to render "showing N of M". Cheap to compute — O(n) over
 * the scoped list; memoized via the shallow hook so it only recomputes on a
 * relevant entity change.
 */
export function useFilteredBlockCount(ids: readonly string[]): {
  readonly matched: number;
  readonly total: number;
} {
  const filtered = useFilteredBlockIds(ids);
  return { matched: filtered.length, total: ids.length };
}

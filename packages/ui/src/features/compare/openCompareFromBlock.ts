/**
 * openCompareFromBlock — the BlockCard's "Compare" button dispatcher.
 *
 * Given a block id, look up its rerun predecessor via the lineage chain and
 * open the Compare panel with `(leftId = predecessor, rightId = block)`. If
 * the block has no prior run (no `rerunOfId`), we return a not-found result
 * and do NOT touch the compare store — the BlockCard already disables the
 * button in that case, but we still guard so a stale id can't open an empty
 * panel.
 *
 * Symmetry note: opening from either side of a rerun pair should produce
 * the same panel. When a user hits Compare on the OLDER block (the one that
 * IS someone's predecessor), we don't have a forward pointer — we instead
 * scan `order` for the newest block whose `rerunOfId` equals the input's
 * id. That keeps the lineage model one-directional (child → parent) while
 * still letting both surfaces open the same comparison.
 */

import {
  useBlockStore,
  type Block,
  type BlockState,
} from '../../entities/block/index.js';
import { useCompareStore } from '../../entities/compare/index.js';

export type OpenCompareResult =
  | { readonly ok: true; readonly leftId: string; readonly rightId: string }
  | { readonly ok: false; readonly reason: 'not-found' | 'no-predecessor' };

export function openCompareFromBlock(blockId: string): OpenCompareResult {
  const state = useBlockStore.getState();
  const target = state.entities[blockId];
  if (!target) return { ok: false, reason: 'not-found' };

  const pair = resolveComparePair(target, state);
  if (!pair) return { ok: false, reason: 'no-predecessor' };

  useCompareStore.getState().openCompare(pair);
  return { ok: true, ...pair };
}

/**
 * Figure out which (left, right) pair best represents "this block against
 * its sibling run":
 *   - If the target has `rerunOfId` pointing at an existing block → use that
 *     predecessor as the left side.
 *   - Otherwise, find the most recent block whose `rerunOfId` points at the
 *     target (forward scan, newest-first) → target is the predecessor of
 *     the match; left = target, right = match.
 *   - If neither applies, return null.
 *
 * Pure: accepts a snapshot of the block state, no `getState()` call so
 * tests can feed synthetic state without the Zustand store.
 */
export function resolveComparePair(
  target: Block,
  state: Pick<BlockState, 'entities' | 'order'>,
): { readonly leftId: string; readonly rightId: string } | null {
  const { entities, order } = state;

  if (target.rerunOfId !== null) {
    const predecessor = entities[target.rerunOfId];
    if (predecessor) {
      return { leftId: predecessor.id, rightId: target.id };
    }
    // Dangling pointer — fall through so we can still try the forward scan.
  }

  for (let i = order.length - 1; i >= 0; i -= 1) {
    const id = order[i];
    if (!id) continue;
    const b = entities[id];
    if (b && b.rerunOfId === target.id) {
      return { leftId: target.id, rightId: b.id };
    }
  }

  return null;
}

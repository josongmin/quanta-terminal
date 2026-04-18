/**
 * Clear the block history.
 *
 * Thin wrapper over the entity's `clearHistory` action. Pinned blocks are
 * preserved by the store. Exposed as a feature so widgets don't reach into
 * the store directly for a destructive action — keeps the audit list of
 * "who can wipe history" short.
 */

import { useBlockStore } from '../../entities/block/index.js';

export interface ClearBlocksResult {
  readonly removed: number;
  readonly preserved: number;
}

export function clearBlocks(): ClearBlocksResult {
  const before = useBlockStore.getState();
  let pinned = 0;
  for (const id of before.order) {
    if (before.entities[id]?.pinned) pinned += 1;
  }
  const total = before.order.length;
  useBlockStore.getState().clearHistory();
  return { removed: total - pinned, preserved: pinned };
}

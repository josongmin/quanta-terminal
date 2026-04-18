/**
 * Active-block pointer — read-only selector over the block store.
 *
 * The active-block pointer used to be a module-level `let` in this file.
 * That placement meant the "create block → set active" dispatch was two
 * separate steps that could race the mock bridge's synchronous `pty_data`
 * emit inside `bridge.write()`. Ownership moved into the block store so
 * `startBlock` can do cancel-previous + create + set-active as ONE state
 * mutation. Everything here delegates to the store's port.
 *
 * `setActiveBlockId` is still exported because:
 *   - the output router clears the pointer to null when it detects a
 *     boundary; `null` is a legitimate state the router owns;
 *   - tests seed the active block directly without going through the full
 *     submit flow (see __tests__/route-output.test.ts).
 *
 * `resetActiveBlock` is a convenience alias for `setActiveBlockId(null)`
 * used by the router's dispose path and test setup.
 */

import type { BlockId } from '../../shared/types/generated/index.js';
import { tryGetBlockStore } from './block-store-port.js';

export function getActiveBlockId(): BlockId | null {
  return tryGetBlockStore()?.getActiveBlockId() ?? null;
}

export function setActiveBlockId(id: BlockId | null): void {
  const store = tryGetBlockStore();
  if (!store) return;
  store.setActiveBlockId(id);
}

export function resetActiveBlock(): void {
  setActiveBlockId(null);
}

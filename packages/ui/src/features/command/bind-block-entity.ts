/**
 * Block-entity adapter — the one place where the command feature reaches
 * into `entities/block`. Called once at bootstrap by the page/orchestrator.
 *
 * Why a separate file:
 *
 *   - The port (`block-store-port.ts`) is pure shape; no cross-slice import.
 *   - The adapter is the single FSD seam. If the store's signatures change,
 *     only THIS file needs to adapt — the rest of the feature speaks through
 *     the port.
 *   - Tests don't bundle this adapter: they bind a recorder directly. So
 *     importing from `entities/block` here does not leak into test files
 *     that exercise the feature in isolation.
 */

import { useBlockStore } from '../../entities/block/index.js';
import { bindSessionRemovalHook } from '../../entities/session/index.js';
import { bindBlockStore, type BlockStoreActions } from './block-store-port.js';
import { setRouterBlockSessionLookup } from './route-output.js';
import type { BlockId, SessionId } from '../../shared/types/generated/index.js';

/**
 * Install the live block-store adapter. Returns the disposer so the
 * orchestrator can unbind on teardown (hot-reload, StrictMode double-effect).
 */
export function bindBlockEntity(): () => void {
  const actions: BlockStoreActions = {
    createBlock(command: string, cwd: string, options?: { sessionId?: SessionId }): BlockId {
      return useBlockStore.getState().createBlock(command, cwd, options) as BlockId;
    },
    startBlock(command, cwd, options) {
      return useBlockStore.getState().startBlock(command, cwd, options) as BlockId;
    },
    setActiveBlockId(id: BlockId | null): void {
      useBlockStore.getState().setActiveBlockId(id);
    },
    getActiveBlockId(): BlockId | null {
      return (useBlockStore.getState().activeBlockId as BlockId | null) ?? null;
    },
    appendBlockOutput(blockId: BlockId, chunk: Uint8Array): void {
      useBlockStore.getState().appendBlockOutput(blockId, chunk);
    },
    completeBlock(blockId: BlockId, exitCode: number | null): void {
      useBlockStore.getState().completeBlock(blockId, exitCode);
    },
    cancelBlock(blockId: BlockId): void {
      useBlockStore.getState().cancelBlock(blockId);
    },
    errorBlock(blockId: BlockId, message: string): void {
      useBlockStore.getState().errorBlock(blockId, message);
    },
    getRunningBlockIds(): readonly BlockId[] {
      // Derived — the store surfaces `order`/`entities` but not a
      // running-only list; computing on demand avoids adding an action to
      // the store just for this caller.
      const state = useBlockStore.getState();
      const out: BlockId[] = [];
      for (const id of state.order) {
        const b = state.entities[id];
        if (b && b.status === 'running') out.push(id as BlockId);
      }
      return out;
    },
  };
  const unbind = bindBlockStore(actions);
  // Register the block → session lookup on the router so the multi-session
  // dispose path can scope its active-block clear. Safe to register here
  // because the block entity is the only thing that knows a block's owning
  // session; without this the router falls back to blanket-clear.
  setRouterBlockSessionLookup((blockId: BlockId) => {
    const b = useBlockStore.getState().entities[blockId];
    return b?.sessionId as SessionId | undefined;
  });
  // Audit P1 (fix 3): when a session is removed from the sessions store,
  // clear the block store's `activeBlockId` if and only if the live pointer
  // targets a block owned by that session. Without this hook, a closed
  // session leaves a dangling active pointer; the next pty_data (after a
  // different session becomes active) would route onto the stale id.
  //
  // Registering here (rather than in the session entity) preserves the FSD
  // boundary: the session entity knows nothing about blocks; the command
  // feature, which is already the seam between the two, owns the wiring.
  const unbindRemoval = bindSessionRemovalHook((removedId: SessionId) => {
    const state = useBlockStore.getState();
    const active = state.activeBlockId;
    if (active === null) return;
    const block = state.entities[active];
    if (block?.sessionId === removedId) {
      state.setActiveBlockId(null);
    }
  });
  return () => {
    unbindRemoval();
    setRouterBlockSessionLookup(null);
    unbind();
  };
}

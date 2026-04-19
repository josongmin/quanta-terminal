/**
 * Multi-session router hygiene.
 *
 * Regression coverage for the audit-pass fix: `installCommandRouter(A).dispose()`
 * must NOT clear the active-block pointer when the pointer currently targets
 * a block owned by a DIFFERENT session. Before the fix, dispose unconditionally
 * called `setActiveBlockId(null)` which stomped on sibling sessions.
 *
 * Also asserts that double-install for the same session id is silently
 * idempotent: the second install replaces the router atomically and the
 * first disposer's guard (`routers.get(sessionId) === handle`) prevents
 * the superseded handle from deleting the live one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BlockId, SessionId } from '../../../shared/types/generated/index.js';
import {
  __resetRouterForTests,
  __resetRawObserversForTests,
  addRouterRawObserver,
  appendToActiveBlock,
  installCommandRouter,
  setRouterBlockSessionLookup,
} from '../route-output.js';
import { bindBlockStore, type BlockStoreActions } from '../block-store-port.js';

// Build a recorder that stashes its active block + knows each block's session,
// so the dispose path can consult the router's lookup hook.
function makeMultiSessionRecorder() {
  let active: BlockId | null = null;
  const blockToSession = new Map<BlockId, SessionId>();
  const appends: Array<{ id: BlockId; bytes: Uint8Array }> = [];
  const store: BlockStoreActions = {
    createBlock: vi.fn(() => 'blk-unused' as BlockId),
    startBlock: vi.fn(() => 'blk-unused' as BlockId),
    setActiveBlockId: (id) => {
      active = id;
    },
    getActiveBlockId: () => active,
    appendBlockOutput: (id, chunk) => {
      appends.push({ id, bytes: new Uint8Array(chunk) });
    },
    completeBlock: vi.fn(),
    cancelBlock: vi.fn(),
    errorBlock: vi.fn(),
    getRunningBlockIds: vi.fn(() => []),
  };
  return {
    store,
    appends,
    setActive: (id: BlockId | null) => {
      active = id;
    },
    bind: (id: BlockId, session: SessionId) => {
      blockToSession.set(id, session);
    },
    lookup: (id: BlockId) => blockToSession.get(id),
  };
}

let unbindStore: (() => void) | undefined;

beforeEach(() => {
  __resetRouterForTests();
  __resetRawObserversForTests();
});

afterEach(() => {
  if (unbindStore) unbindStore();
  unbindStore = undefined;
  __resetRouterForTests();
  __resetRawObserversForTests();
  setRouterBlockSessionLookup(null);
});

describe('installCommandRouter — multi-session dispose hygiene', () => {
  it('disposing session A does NOT clear the active block when it belongs to session B', () => {
    const rec = makeMultiSessionRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const B = 'sess-b' as SessionId;
    const routerA = installCommandRouter(A);
    installCommandRouter(B);

    rec.bind('blk-b' as BlockId, B);
    rec.setActive('blk-b' as BlockId);

    routerA.dispose();

    // B's active pointer must survive A's dispose.
    expect(rec.store.getActiveBlockId()).toBe('blk-b');
  });

  it('disposing session A DOES clear the active block when it belongs to A', () => {
    const rec = makeMultiSessionRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const routerA = installCommandRouter(A);
    rec.bind('blk-a' as BlockId, A);
    rec.setActive('blk-a' as BlockId);

    routerA.dispose();
    expect(rec.store.getActiveBlockId()).toBeNull();
  });

  it('audit P0: does NOT clear the active pointer when the lookup port is null (early-boot timing)', () => {
    const rec = makeMultiSessionRecorder();
    unbindStore = bindBlockStore(rec.store);
    // Deliberately DO NOT register the lookup — simulates the dispose path
    // firing before `bindBlockEntity()` has registered the adapter.

    const A = 'sess-a' as SessionId;
    const routerA = installCommandRouter(A);
    rec.setActive('blk-anywhere' as BlockId);

    routerA.dispose();
    // No lookup → positive-confirmation posture leaves the pointer alone.
    // The previous "clear on unknown" default could nuke a sibling session's
    // active block during adapter-registration races.
    expect(rec.store.getActiveBlockId()).toBe('blk-anywhere');
  });

  it('audit P0: does NOT clear when the lookup returns undefined (unknown block id)', () => {
    const rec = makeMultiSessionRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const routerA = installCommandRouter(A);
    // Set an active block id but DO NOT bind it to any session — the lookup
    // will return undefined for it.
    rec.setActive('blk-orphan' as BlockId);

    routerA.dispose();
    expect(rec.store.getActiveBlockId()).toBe('blk-orphan');
  });

  it('audit P0: swap active-block ownership between two sessions, dispose A, B\'s pointer survives', () => {
    const rec = makeMultiSessionRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const B = 'sess-b' as SessionId;
    const routerA = installCommandRouter(A);
    installCommandRouter(B);

    // Start with A's block as active, then hand off to B.
    rec.bind('blk-a' as BlockId, A);
    rec.bind('blk-b' as BlockId, B);
    rec.setActive('blk-a' as BlockId);
    rec.setActive('blk-b' as BlockId); // ownership now B

    routerA.dispose();
    expect(rec.store.getActiveBlockId()).toBe('blk-b');
  });
});

describe('installCommandRouter — idempotent double-install per session id', () => {
  it('a second install for the same id atomically replaces the router', () => {
    const rec = makeMultiSessionRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    const first = installCommandRouter(A);
    const second = installCommandRouter(A);

    // The first disposer should now be a harmless no-op: the live router is
    // owned by `second`. Disposing `first` must not stomp on sibling state.
    rec.bind('blk-a' as BlockId, A);
    rec.setActive('blk-a' as BlockId);
    first.dispose();
    // Active should NOT have been cleared — `first` lost ownership when
    // `second` replaced it, so dispose's guard trips and the no-op wins.
    expect(rec.store.getActiveBlockId()).toBe('blk-a');

    // The live (second) router still processes bytes.
    appendToActiveBlock(A, 'Zm9v');
    expect(rec.appends).toHaveLength(1);
    second.dispose();
  });
});

describe('raw chunk observers — global, cleared by router reset', () => {
  it('a stale observer does not survive __resetRawObserversForTests', () => {
    const rec = makeMultiSessionRecorder();
    unbindStore = bindBlockStore(rec.store);
    setRouterBlockSessionLookup(rec.lookup);

    const A = 'sess-a' as SessionId;
    installCommandRouter(A);
    rec.bind('blk-a' as BlockId, A);
    rec.setActive('blk-a' as BlockId);

    const observed: Uint8Array[] = [];
    addRouterRawObserver((c) => observed.push(new Uint8Array(c)));
    appendToActiveBlock(A, 'Zm9v');
    expect(observed).toHaveLength(1);

    __resetRawObserversForTests();
    appendToActiveBlock(A, 'YmFy');
    expect(observed).toHaveLength(1); // no new delivery after reset
  });
});

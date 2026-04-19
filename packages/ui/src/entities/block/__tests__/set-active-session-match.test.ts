/**
 * Audit P1 (fix 4) — `setActiveBlockId` with a session-match guard.
 *
 * Scenario: the router is disposing a session A while the composer is
 * simultaneously setting a new active block on session B. Without a guard,
 * the router's "clear to null" can overwrite the composer's write. Both
 * callers now pass `requireSessionMatch: <owning session id>` and the
 * reducer short-circuits when the target block does NOT belong to that
 * session.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../model.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const S1 = 's1' as SessionId;
const S2 = 's2' as SessionId;

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('setActiveBlockId — session-match guard (fix 4)', () => {
  it('applies when the target block belongs to the required session', () => {
    const id = useBlockStore.getState().createBlock('a', '/', { sessionId: S1 });
    useBlockStore.getState().setActiveBlockId(id, { requireSessionMatch: S1 });
    expect(useBlockStore.getState().activeBlockId).toBe(id);
  });

  it('is a no-op when the target block belongs to a different session', () => {
    const id = useBlockStore.getState().createBlock('a', '/', { sessionId: S1 });
    useBlockStore.getState().setActiveBlockId(id, { requireSessionMatch: S2 });
    expect(useBlockStore.getState().activeBlockId).toBeNull();
  });

  it('is a no-op when setting null but the current active block is NOT in the required session', () => {
    // Reproduce the documented race: S1 set an active block; a disposer on
    // S2 tries to clear-to-null. The clear must be rejected because the
    // currently-active block is owned by S1.
    const aId = useBlockStore.getState().createBlock('a', '/', { sessionId: S1 });
    useBlockStore.getState().setActiveBlockId(aId);
    expect(useBlockStore.getState().activeBlockId).toBe(aId);

    useBlockStore.getState().setActiveBlockId(null, { requireSessionMatch: S2 });

    expect(useBlockStore.getState().activeBlockId).toBe(aId);
  });

  it('applies null-clear when the current active block IS in the required session', () => {
    const aId = useBlockStore.getState().createBlock('a', '/', { sessionId: S1 });
    useBlockStore.getState().setActiveBlockId(aId);
    useBlockStore.getState().setActiveBlockId(null, { requireSessionMatch: S1 });
    expect(useBlockStore.getState().activeBlockId).toBeNull();
  });

  it('is a no-op when requireSessionMatch targets an unknown block id', () => {
    const id = useBlockStore.getState().createBlock('a', '/', { sessionId: S1 });
    useBlockStore.getState().setActiveBlockId(id);
    useBlockStore.getState().setActiveBlockId('unknown-id', { requireSessionMatch: S1 });
    // Still pointing at the real block — the unknown target was rejected.
    expect(useBlockStore.getState().activeBlockId).toBe(id);
  });

  it('unguarded call (no options) still works as before', () => {
    const id = useBlockStore.getState().createBlock('a', '/', { sessionId: S1 });
    useBlockStore.getState().setActiveBlockId(id);
    expect(useBlockStore.getState().activeBlockId).toBe(id);
    useBlockStore.getState().setActiveBlockId(null);
    expect(useBlockStore.getState().activeBlockId).toBeNull();
  });
});

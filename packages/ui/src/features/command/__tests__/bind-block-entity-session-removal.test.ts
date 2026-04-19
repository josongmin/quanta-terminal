/**
 * Audit P1 (fix 3) — integration: `bindBlockEntity` wires the session store's
 * removal hook to clear `useBlockStore.activeBlockId` when the closing
 * session owned it.
 *
 * Covered scenarios:
 *   (a) removing a session whose block is active → active is cleared.
 *   (b) removing a session that does NOT own the active block → active
 *       pointer is untouched (sibling-session safety).
 *   (c) removing without the hook bound is a no-op — doesn't crash,
 *       doesn't touch the block store.
 *
 * Why this lives in the command feature (not the block entity):
 *   The wiring seam is `features/command/bind-block-entity.ts`. That seam
 *   is already the single authorized cross-slice glue (block entity + router
 *   + session hook) per the bind-block-entity docblock. Testing it here
 *   keeps the entity tests free of the cross-slice binding concern.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindBlockEntity } from '../bind-block-entity.js';
import { useBlockStore } from '../../../entities/block/index.js';
import { useSessionsStore } from '../../../entities/session/index.js';
import { __resetRouterForTests } from '../route-output.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const A = 'sess-a' as SessionId;
const B = 'sess-b' as SessionId;

let unbind: (() => void) | undefined;

beforeEach(() => {
  useBlockStore.getState().resetAll();
  useSessionsStore.getState().reset();
  __resetRouterForTests();
});

afterEach(() => {
  if (unbind) unbind();
  unbind = undefined;
  useBlockStore.getState().resetAll();
  useSessionsStore.getState().reset();
  __resetRouterForTests();
});

describe('bindBlockEntity — session removal clears orphaned activeBlockId', () => {
  it('(a) clears activeBlockId when the removed session owns the active block', () => {
    unbind = bindBlockEntity();
    const aId = useBlockStore.getState().createBlock('echo a', '/tmp', { sessionId: A });
    useBlockStore.getState().setActiveBlockId(aId);
    useSessionsStore.getState().addSession({ id: A });

    useSessionsStore.getState().removeSession(A);

    expect(useBlockStore.getState().activeBlockId).toBeNull();
  });

  it('(b) does NOT clear activeBlockId when the removed session does NOT own it', () => {
    unbind = bindBlockEntity();
    const bId = useBlockStore.getState().createBlock('echo b', '/tmp', { sessionId: B });
    useBlockStore.getState().setActiveBlockId(bId);
    useSessionsStore.getState().addSession({ id: A });
    useSessionsStore.getState().addSession({ id: B });

    useSessionsStore.getState().removeSession(A);

    // Block B's pointer must survive a sibling session's removal.
    expect(useBlockStore.getState().activeBlockId).toBe(bId);
  });

  it('(c) removing without the hook bound is a no-op and does not crash', () => {
    // Deliberately DO NOT call bindBlockEntity — the hook is unbound.
    const aId = useBlockStore.getState().createBlock('echo a', '/tmp', { sessionId: A });
    useBlockStore.getState().setActiveBlockId(aId);
    useSessionsStore.getState().addSession({ id: A });

    expect(() => useSessionsStore.getState().removeSession(A)).not.toThrow();
    // Without the hook, the active block pointer is not touched — the
    // orphan is still present. That is the documented degraded mode, and
    // the assertion encodes it so a future accidental side-effect is caught.
    expect(useBlockStore.getState().activeBlockId).toBe(aId);
  });
});

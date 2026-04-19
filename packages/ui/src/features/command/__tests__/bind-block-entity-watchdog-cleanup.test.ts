/**
 * Audit P1 (fix 3) — on session removal, every watchdog timer owned by a
 * block in the closing session is cleared. Without this, a session closed
 * with a running block leaves a ~30s orphan timer that would later promote
 * the block to `error` (even though it's no longer visible).
 *
 * The cleanup is wired in `bindBlockEntity` alongside the existing active-
 * pointer clear (fix from audit P1 #3 in Track γ) — both use the same
 * `bindSessionRemovalHook`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindBlockEntity } from '../bind-block-entity.js';
import { __hasWatchdogForTests, useBlockStore } from '../../../entities/block/index.js';
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

describe('bindBlockEntity — watchdog cleanup on session removal (fix 3)', () => {
  it('clears watchdog timers for every block in the closing session', () => {
    unbind = bindBlockEntity();
    useSessionsStore.getState().addSession({ id: A });
    useSessionsStore.getState().addSession({ id: B });

    // `startBlock` cancels the PREVIOUSLY-active block (there is one
    // global `activeBlockId`), so arming two concurrent A-owned watchdogs
    // requires releasing the active pointer between calls — otherwise the
    // second startBlock cancels the first, clearing its timer. We then
    // release again before arming B so we don't stomp a2.
    const a1 = useBlockStore.getState().startBlock('sleep 60', '/', { sessionId: A, watchdogMs: 30_000 });
    useBlockStore.getState().setActiveBlockId(null);
    const a2 = useBlockStore.getState().startBlock('sleep 60', '/', { sessionId: A, watchdogMs: 30_000 });
    useBlockStore.getState().setActiveBlockId(null);
    const b1 = useBlockStore.getState().startBlock('sleep 60', '/', { sessionId: B, watchdogMs: 30_000 });

    expect(__hasWatchdogForTests(a1)).toBe(true);
    expect(__hasWatchdogForTests(a2)).toBe(true);
    expect(__hasWatchdogForTests(b1)).toBe(true);

    useSessionsStore.getState().removeSession(A);

    expect(__hasWatchdogForTests(a1)).toBe(false);
    expect(__hasWatchdogForTests(a2)).toBe(false);
    // B's timer is unaffected — the cleanup is strictly scoped to the
    // removed session.
    expect(__hasWatchdogForTests(b1)).toBe(true);
  });

  it('is a no-op when no blocks belong to the removed session', () => {
    unbind = bindBlockEntity();
    useSessionsStore.getState().addSession({ id: A });
    useSessionsStore.getState().addSession({ id: B });
    const b1 = useBlockStore.getState().startBlock('sleep 9', '/', { sessionId: B });
    expect(__hasWatchdogForTests(b1)).toBe(true);

    useSessionsStore.getState().removeSession(A);

    // A had no blocks — B's timer survives.
    expect(__hasWatchdogForTests(b1)).toBe(true);
  });

  it('also clears the timer for a block whose watchdog has already been re-armed by an output chunk', () => {
    unbind = bindBlockEntity();
    useSessionsStore.getState().addSession({ id: A });
    const blk = useBlockStore.getState().startBlock('cat', '/', { sessionId: A });
    // Re-arm by appending output — the watchdog path resets.
    useBlockStore.getState().appendBlockOutput(blk, new Uint8Array([0x61]));
    expect(__hasWatchdogForTests(blk)).toBe(true);

    useSessionsStore.getState().removeSession(A);

    expect(__hasWatchdogForTests(blk)).toBe(false);
  });
});

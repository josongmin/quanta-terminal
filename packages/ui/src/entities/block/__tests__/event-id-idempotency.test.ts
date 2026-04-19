/**
 * Audit P0 (fix 2) — event-id idempotency LRU in the block reducer.
 *
 * The sidecar's resume cursor re-delivers events after a UI reconnect. Any
 * reducer action that consumes an event envelope MUST short-circuit on a
 * duplicate `event_id`, otherwise the replay would flip terminal state
 * (a second `completeBlock` on an already-running block is fine, but a
 * replayed `completeBlock` + `cancelBlock` pair could race).
 *
 * These tests drive every event-bearing action through a deliberate
 * double-apply and assert:
 *   1. second call with the same event_id is a no-op;
 *   2. different event_ids both apply;
 *   3. LRU evicts the oldest entry at the 257th insertion;
 *   4. actions without an event_id skip the dedupe path entirely
 *      (backward compatibility with composer / test call sites).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  APPLIED_EVENT_ID_LRU_CAPACITY,
  useBlockStore,
} from '../model.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('block store — event-id idempotency LRU (fix 2)', () => {
  it('same event_id applied to appendBlockOutput twice: second is a no-op', () => {
    const id = useBlockStore.getState().createBlock('cat', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([65]), 'ev-1');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([66]), 'ev-1');
    const b = useBlockStore.getState().entities[id];
    expect(b?.outputChunks.length).toBe(1);
    expect(b?.outputChunks[0]?.[0]).toBe(65);
  });

  it('different event_ids both apply', () => {
    const id = useBlockStore.getState().createBlock('cat', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([65]), 'ev-1');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([66]), 'ev-2');
    const b = useBlockStore.getState().entities[id];
    expect(b?.outputChunks.length).toBe(2);
    expect(b?.outputChunks[1]?.[0]).toBe(66);
  });

  it('actions without an event_id skip dedupe (backward compat)', () => {
    const id = useBlockStore.getState().createBlock('cat', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([1]));
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([2]));
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([3]));
    const b = useBlockStore.getState().entities[id];
    expect(b?.outputChunks.length).toBe(3);
  });

  it('completeBlock with replayed event_id is a no-op (does not re-stamp completedAt)', () => {
    const id = useBlockStore.getState().createBlock('true', '/');
    useBlockStore.getState().completeBlock(id, 0, 'ev-complete');
    const first = useBlockStore.getState().entities[id];
    // A replayed terminal event — second call with the same event_id MUST
    // short-circuit before even reaching the running-state guard, so a
    // currently-running sibling block can't accidentally be completed.
    useBlockStore.getState().completeBlock(id, 1, 'ev-complete');
    const after = useBlockStore.getState().entities[id];
    expect(after).toBe(first);
    expect(after?.exitCode).toBe(0);
  });

  it('cancelBlock with replayed event_id is a no-op', () => {
    const id = useBlockStore.getState().createBlock('sleep 9', '/');
    useBlockStore.getState().cancelBlock(id, 'ev-cancel');
    const snap = useBlockStore.getState().entities[id];
    useBlockStore.getState().cancelBlock(id, 'ev-cancel');
    expect(useBlockStore.getState().entities[id]).toBe(snap);
  });

  it('errorBlock with replayed event_id is a no-op', () => {
    const id = useBlockStore.getState().createBlock('nope', '/');
    useBlockStore.getState().errorBlock(id, 'spawn EACCES', 'ev-err');
    const snap = useBlockStore.getState().entities[id];
    useBlockStore.getState().errorBlock(id, 'spawn EACCES', 'ev-err');
    expect(useBlockStore.getState().entities[id]).toBe(snap);
  });

  it(`LRU evicts the oldest entry at the ${APPLIED_EVENT_ID_LRU_CAPACITY + 1}th insertion`, () => {
    const id = useBlockStore.getState().createBlock('cat', '/');
    // Fill LRU to capacity with unique event ids.
    for (let i = 0; i < APPLIED_EVENT_ID_LRU_CAPACITY; i += 1) {
      useBlockStore.getState().appendBlockOutput(id, new Uint8Array([1]), `ev-${i}`);
    }
    expect(useBlockStore.getState().appliedEventIds.size).toBe(APPLIED_EVENT_ID_LRU_CAPACITY);
    expect(useBlockStore.getState().appliedEventIds.has('ev-0')).toBe(true);

    // One more push — ev-0 must be evicted.
    useBlockStore
      .getState()
      .appendBlockOutput(id, new Uint8Array([1]), `ev-${APPLIED_EVENT_ID_LRU_CAPACITY}`);
    expect(useBlockStore.getState().appliedEventIds.size).toBe(APPLIED_EVENT_ID_LRU_CAPACITY);
    expect(useBlockStore.getState().appliedEventIds.has('ev-0')).toBe(false);
    expect(
      useBlockStore.getState().appliedEventIds.has(`ev-${APPLIED_EVENT_ID_LRU_CAPACITY}`),
    ).toBe(true);
  });

  it('once evicted, a re-arriving old event can be re-applied (LRU, not set-membership-forever)', () => {
    const id = useBlockStore.getState().createBlock('cat', '/');
    for (let i = 0; i < APPLIED_EVENT_ID_LRU_CAPACITY + 5; i += 1) {
      useBlockStore.getState().appendBlockOutput(id, new Uint8Array([1]), `ev-${i}`);
    }
    const evictedId = 'ev-0';
    expect(useBlockStore.getState().appliedEventIds.has(evictedId)).toBe(false);
    // Re-sending ev-0 is allowed now (it's been evicted). The chunk count
    // should go up by one — this is the documented behavior. In practice the
    // sidecar will never resurrect an event id this stale; the test just
    // nails down the semantics.
    const before = useBlockStore.getState().entities[id]?.outputChunks.length ?? 0;
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([1]), evictedId);
    const after = useBlockStore.getState().entities[id]?.outputChunks.length ?? 0;
    expect(after).toBe(before + 1);
  });

  it('startBlock with replayed event_id does not spawn a second block', () => {
    const id1 = useBlockStore.getState().startBlock('a', '/', { eventId: 'ev-start' });
    const orderBefore = useBlockStore.getState().order.length;
    const id2 = useBlockStore.getState().startBlock('b', '/', { eventId: 'ev-start' });
    // Dedupe means no second block is added.
    expect(useBlockStore.getState().order.length).toBe(orderBefore);
    // The returned id is a fresh uuid (the action always allocates one
    // before entering the set callback) but no entity exists for it.
    expect(useBlockStore.getState().entities[id2]).toBeUndefined();
    expect(useBlockStore.getState().entities[id1]).toBeDefined();
  });

  it('resetAll clears the applied event id set', () => {
    const id = useBlockStore.getState().createBlock('cat', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([1]), 'ev-a');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([2]), 'ev-b');
    expect(useBlockStore.getState().appliedEventIds.size).toBe(2);
    useBlockStore.getState().resetAll();
    expect(useBlockStore.getState().appliedEventIds.size).toBe(0);
  });
});

/**
 * `useBlocksForSession` — Phase 4 session scoping selector.
 *
 * BlockList uses this to show only the active tab's blocks. Covers:
 *   - Empty store → empty array.
 *   - Blocks from mixed sessions → only the requested session is returned.
 *   - Order follows `state.order` (insertion order).
 *   - Unknown id → empty array.
 *   - `null` id → empty array (pre-first-spawn paint is valid state).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBlockStore, useBlocksForSession } from '../index.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const S1 = 'sess-1' as SessionId;
const S2 = 'sess-2' as SessionId;

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('useBlocksForSession', () => {
  it('returns an empty array when the store has nothing for the session', () => {
    const { result } = renderHook(() => useBlocksForSession(S1));
    expect(result.current).toEqual([]);
  });

  it('returns only blocks belonging to the requested session, in insertion order', () => {
    const a = useBlockStore.getState().createBlock('cmd-a', '/', { sessionId: S1 });
    const b = useBlockStore.getState().createBlock('cmd-b', '/', { sessionId: S2 });
    const c = useBlockStore.getState().createBlock('cmd-c', '/', { sessionId: S1 });

    const { result: r1 } = renderHook(() => useBlocksForSession(S1));
    expect(r1.current).toEqual([a, c]);

    const { result: r2 } = renderHook(() => useBlocksForSession(S2));
    expect(r2.current).toEqual([b]);
  });

  it('returns an empty array for a null id (pre-first-spawn paint)', () => {
    useBlockStore.getState().createBlock('cmd', '/', { sessionId: S1 });
    const { result } = renderHook(() => useBlocksForSession(null));
    expect(result.current).toEqual([]);
  });

  it('returns an empty array for an unknown session id', () => {
    useBlockStore.getState().createBlock('cmd', '/', { sessionId: S1 });
    const { result } = renderHook(() => useBlocksForSession('nope' as SessionId));
    expect(result.current).toEqual([]);
  });
});

/**
 * Block selector shape tests.
 *
 * The critical properties:
 *   - `useBlockIds` returns a shallow-stable array reference when unrelated
 *     fields of individual blocks change. Only an add/remove/reorder bumps it.
 *   - `useBlock(id)` returns a new reference precisely when that block's own
 *     fields change, and is unaffected by mutations to other blocks.
 *   - `useActiveBlockId` follows the newest running block through its
 *     lifecycle.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useBlockStore } from '../model.js';
import {
  useActiveBlockId,
  useBlock,
  useBlockHeader,
  useBlockIds,
  useBlockOutputChunks,
  getRerunLineage,
  getRerunLineageFromState,
} from '../selectors.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('useBlockIds', () => {
  it('returns the ordered id list', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    const b = useBlockStore.getState().createBlock('b', '/');
    const { result } = renderHook(() => useBlockIds());
    expect(result.current).toEqual([a, b]);
  });

  it('does not change reference when a block mutates but order does not', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    const { result, rerender } = renderHook(() => useBlockIds());
    const first = result.current;
    act(() => {
      useBlockStore.getState().appendBlockOutput(a, new Uint8Array([65]));
    });
    rerender();
    expect(result.current).toBe(first);
  });

  it('changes reference when a new block is created', () => {
    useBlockStore.getState().createBlock('a', '/');
    const { result, rerender } = renderHook(() => useBlockIds());
    const first = result.current;
    act(() => {
      useBlockStore.getState().createBlock('b', '/');
    });
    rerender();
    expect(result.current).not.toBe(first);
  });
});

describe('useBlock', () => {
  it('returns the target block', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const { result } = renderHook(() => useBlock(id));
    expect(result.current?.command).toBe('ls');
  });

  it('returns undefined once the block is cleared', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const { result, rerender } = renderHook(() => useBlock(id));
    expect(result.current).toBeDefined();
    act(() => {
      useBlockStore.getState().clearHistory();
    });
    rerender();
    expect(result.current).toBeUndefined();
  });

  it('is insensitive to mutations of other blocks', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    const b = useBlockStore.getState().createBlock('b', '/');
    const { result, rerender } = renderHook(() => useBlock(a));
    const first = result.current;
    act(() => {
      useBlockStore.getState().appendBlockOutput(b, new Uint8Array([1]));
    });
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useBlockHeader', () => {
  it('exposes header fields and omits outputChunks', () => {
    const id = useBlockStore.getState().createBlock('pwd', '/tmp');
    const { result } = renderHook(() => useBlockHeader(id));
    expect(result.current?.command).toBe('pwd');
    expect(result.current?.cwd).toBe('/tmp');
    expect(result.current?.status).toBe('running');
    // The view must NOT surface outputChunks — that's what keeps the header
    // stable while the body streams.
    expect(
      Object.prototype.hasOwnProperty.call(result.current ?? {}, 'outputChunks'),
    ).toBe(false);
  });

  it('is stable under appendBlockOutput (header fields unchanged)', () => {
    const id = useBlockStore.getState().createBlock('a', '/');
    const { result, rerender } = renderHook(() => useBlockHeader(id));
    const first = result.current;
    act(() => {
      useBlockStore.getState().appendBlockOutput(id, new Uint8Array([65]));
    });
    rerender();
    expect(result.current).toBe(first);
  });

  it('updates when collapse toggles', () => {
    const id = useBlockStore.getState().createBlock('a', '/');
    const { result, rerender } = renderHook(() => useBlockHeader(id));
    const first = result.current;
    act(() => {
      useBlockStore.getState().toggleCollapse(id);
    });
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current?.collapsed).toBe(true);
  });

  it('updates when the block completes', () => {
    const id = useBlockStore.getState().createBlock('a', '/');
    const { result, rerender } = renderHook(() => useBlockHeader(id));
    act(() => {
      useBlockStore.getState().completeBlock(id, 0);
    });
    rerender();
    expect(result.current?.status).toBe('completed');
    expect(result.current?.exitCode).toBe(0);
  });

  it('returns undefined after clearHistory drops the block', () => {
    const id = useBlockStore.getState().createBlock('a', '/');
    const { result, rerender } = renderHook(() => useBlockHeader(id));
    expect(result.current).toBeDefined();
    act(() => {
      useBlockStore.getState().clearHistory();
    });
    rerender();
    expect(result.current).toBeUndefined();
  });
});

describe('useBlockOutputChunks', () => {
  it('reports the current chunks and chunkCount', () => {
    const id = useBlockStore.getState().createBlock('a', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([1, 2]));
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([3]));
    const { result } = renderHook(() => useBlockOutputChunks(id));
    expect(result.current?.chunkCount).toBe(2);
    expect(result.current?.outputChunks.length).toBe(2);
    expect(result.current?.status).toBe('running');
  });

  it('bumps on appendBlockOutput (outputChunks ref changes)', () => {
    const id = useBlockStore.getState().createBlock('a', '/');
    const { result, rerender } = renderHook(() => useBlockOutputChunks(id));
    const first = result.current;
    act(() => {
      useBlockStore.getState().appendBlockOutput(id, new Uint8Array([1]));
    });
    rerender();
    expect(result.current).not.toBe(first);
    expect(result.current?.chunkCount).toBe(1);
  });

  it('is stable under header-only toggles (collapse, pin)', () => {
    const id = useBlockStore.getState().createBlock('a', '/');
    const { result, rerender } = renderHook(() => useBlockOutputChunks(id));
    const first = result.current;
    act(() => {
      useBlockStore.getState().toggleCollapse(id);
    });
    rerender();
    act(() => {
      useBlockStore.getState().togglePin(id);
    });
    rerender();
    expect(result.current).toBe(first);
  });
});

describe('useBlock (shallow)', () => {
  it('is stable when other blocks mutate', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    const b = useBlockStore.getState().createBlock('b', '/');
    const { result, rerender } = renderHook(() => useBlock(a));
    const first = result.current;
    act(() => {
      useBlockStore.getState().appendBlockOutput(b, new Uint8Array([1]));
    });
    rerender();
    expect(result.current).toBe(first);
  });

  it('updates when the subscribed block mutates', () => {
    const id = useBlockStore.getState().createBlock('a', '/');
    const { result, rerender } = renderHook(() => useBlock(id));
    const first = result.current;
    act(() => {
      useBlockStore.getState().appendBlockOutput(id, new Uint8Array([1]));
    });
    rerender();
    expect(result.current).not.toBe(first);
  });
});

describe('getRerunLineage', () => {
  it('returns [] for an unknown id', () => {
    expect(getRerunLineage('nope')).toEqual([]);
  });

  it('returns a single-element chain for an original run', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const chain = getRerunLineage(id);
    expect(chain).toHaveLength(1);
    expect(chain[0]?.id).toBe(id);
  });

  it('walks back through rerunOfId pointers, oldest first', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('ls', '/', { rerunOf: a });
    const c = useBlockStore.getState().createBlock('ls', '/', { rerunOf: b });
    const chain = getRerunLineage(c);
    expect(chain.map((b_) => b_.id)).toEqual([a, b, c]);
  });

  it('stops at a dangling predecessor pointer', () => {
    // Simulate a dangling pointer via the state-level helper.
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('ls', '/', { rerunOf: a });
    const state = useBlockStore.getState();
    const filtered = { ...state.entities };
    delete filtered[a];
    const chain = getRerunLineageFromState(
      { ...state, entities: filtered },
      b,
    );
    expect(chain.map((x) => x.id)).toEqual([b]);
  });
});

describe('useActiveBlockId', () => {
  it('is null with no running blocks', () => {
    const { result } = renderHook(() => useActiveBlockId());
    expect(result.current).toBeNull();
  });

  it('tracks the newest running block', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    const b = useBlockStore.getState().createBlock('b', '/');
    const { result, rerender } = renderHook(() => useActiveBlockId());
    expect(result.current).toBe(b);
    act(() => {
      useBlockStore.getState().completeBlock(b, 0);
    });
    rerender();
    expect(result.current).toBe(a);
    act(() => {
      useBlockStore.getState().completeBlock(a, 0);
    });
    rerender();
    expect(result.current).toBeNull();
  });
});

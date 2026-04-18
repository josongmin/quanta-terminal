/**
 * Block store — lifecycle and shape tests.
 *
 * Covers the contract the widgets and features depend on:
 *   - createBlock appends to order and populates entities.
 *   - appendBlockOutput accumulates chunks without concat or decode.
 *   - lifecycle transitions are one-way from `running` (completed / canceled /
 *     error are terminal; further completes are no-ops).
 *   - clearHistory preserves pinned blocks and their relative order.
 *   - concatChunks joins bytes lossless.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore, concatChunks, type Block } from '../model.js';

function getBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('block store — creation', () => {
  it('createBlock appends id to order and seeds entity defaults', () => {
    const id = useBlockStore.getState().createBlock('ls -la', '/tmp');
    const s = useBlockStore.getState();
    expect(s.order).toEqual([id]);
    const b = getBlock(id);
    expect(b.command).toBe('ls -la');
    expect(b.cwd).toBe('/tmp');
    expect(b.status).toBe('running');
    expect(b.completedAt).toBeNull();
    expect(b.exitCode).toBeNull();
    expect(b.outputChunks).toEqual([]);
    expect(b.collapsed).toBe(false);
    expect(b.pinned).toBe(false);
  });

  it('createBlock yields unique ids for successive calls', () => {
    const a = useBlockStore.getState().createBlock('pwd', '/');
    const b = useBlockStore.getState().createBlock('pwd', '/');
    expect(a).not.toBe(b);
    expect(useBlockStore.getState().order).toEqual([a, b]);
  });
});

describe('block store — output accumulation', () => {
  it('appendBlockOutput adds chunks in order without decoding', () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([104, 105])); // "hi"
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([10]));       // "\n"
    const b = getBlock(id);
    expect(b.outputChunks.length).toBe(2);
    expect(concatChunks(b.outputChunks)).toEqual(new Uint8Array([104, 105, 10]));
  });

  it('appendBlockOutput copies incoming bytes so caller buffer reuse is safe', () => {
    const id = useBlockStore.getState().createBlock('echo x', '/');
    const shared = new Uint8Array([1, 2, 3]);
    useBlockStore.getState().appendBlockOutput(id, shared);
    shared[0] = 99;
    const stored = getBlock(id).outputChunks[0];
    expect(stored).toBeDefined();
    expect(stored?.[0]).toBe(1);
  });

  it('appendBlockOutput on an unknown id is a no-op', () => {
    const before = useBlockStore.getState();
    useBlockStore.getState().appendBlockOutput('nope', new Uint8Array([1]));
    expect(useBlockStore.getState()).toBe(before);
  });
});

describe('block store — lifecycle transitions', () => {
  it('completeBlock moves status to completed and stamps exit code + completedAt', () => {
    const id = useBlockStore.getState().createBlock('true', '/');
    useBlockStore.getState().completeBlock(id, 0);
    const b = getBlock(id);
    expect(b.status).toBe('completed');
    expect(b.exitCode).toBe(0);
    expect(b.completedAt).not.toBeNull();
  });

  it('completeBlock on an already-terminal block is a no-op', () => {
    const id = useBlockStore.getState().createBlock('false', '/');
    useBlockStore.getState().completeBlock(id, 1);
    const first = getBlock(id);
    useBlockStore.getState().completeBlock(id, 0);
    expect(getBlock(id)).toBe(first);
  });

  it('cancelBlock moves status to canceled', () => {
    const id = useBlockStore.getState().createBlock('sleep 99', '/');
    useBlockStore.getState().cancelBlock(id);
    expect(getBlock(id).status).toBe('canceled');
  });

  it('cancelBlock on a completed block is a no-op', () => {
    const id = useBlockStore.getState().createBlock('true', '/');
    useBlockStore.getState().completeBlock(id, 0);
    const snap = getBlock(id);
    useBlockStore.getState().cancelBlock(id);
    expect(getBlock(id)).toBe(snap);
  });

  it('errorBlock moves status to error and captures the message', () => {
    const id = useBlockStore.getState().createBlock('nope', '/');
    useBlockStore.getState().errorBlock(id, 'spawn EACCES');
    const b = getBlock(id);
    expect(b.status).toBe('error');
    expect(b.errorMessage).toBe('spawn EACCES');
  });
});

describe('block store — toggles', () => {
  it('toggleCollapse flips the flag', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    expect(getBlock(id).collapsed).toBe(false);
    useBlockStore.getState().toggleCollapse(id);
    expect(getBlock(id).collapsed).toBe(true);
    useBlockStore.getState().toggleCollapse(id);
    expect(getBlock(id).collapsed).toBe(false);
  });

  it('togglePin flips the flag', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().togglePin(id);
    expect(getBlock(id).pinned).toBe(true);
  });
});

describe('block store — clearHistory', () => {
  it('removes all blocks when none are pinned', () => {
    useBlockStore.getState().createBlock('a', '/');
    useBlockStore.getState().createBlock('b', '/');
    useBlockStore.getState().clearHistory();
    expect(useBlockStore.getState().order).toEqual([]);
    expect(useBlockStore.getState().entities).toEqual({});
  });

  it('preserves pinned blocks and keeps their relative order', () => {
    const a = useBlockStore.getState().createBlock('a', '/');
    const b = useBlockStore.getState().createBlock('b', '/');
    const c = useBlockStore.getState().createBlock('c', '/');
    useBlockStore.getState().togglePin(a);
    useBlockStore.getState().togglePin(c);
    useBlockStore.getState().clearHistory();
    const s = useBlockStore.getState();
    expect(s.order).toEqual([a, c]);
    expect(s.entities[b]).toBeUndefined();
    expect(s.entities[a]?.pinned).toBe(true);
    expect(s.entities[c]?.pinned).toBe(true);
  });
});

describe('concatChunks', () => {
  it('returns an empty array for no chunks', () => {
    expect(concatChunks([])).toEqual(new Uint8Array(0));
  });

  it('joins multiple chunks byte-for-byte', () => {
    const out = concatChunks([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5, 6]),
    ]);
    expect(out).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });
});

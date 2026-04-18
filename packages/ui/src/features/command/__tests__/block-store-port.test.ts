/**
 * Port binding tests. The port exists to let the command feature compile and
 * test without the `entities/block` module being live. The contract:
 *
 *   - `getBlockStore()` throws when nothing is bound (fast failure beats
 *     `undefined.createBlock` in downstream code).
 *   - `tryGetBlockStore()` returns undefined in that case (used by the
 *     router's hot path).
 *   - `bindBlockStore()` returns a disposer that restores the previous
 *     binding. This matters for tests that bind per-case.
 */

import { describe, expect, it, vi } from 'vitest';
import type { BlockId } from '../../../shared/types/generated/index.js';
import {
  bindBlockStore,
  getBlockStore,
  tryGetBlockStore,
  type BlockStoreActions,
} from '../block-store-port.js';

function stub(): BlockStoreActions {
  return {
    createBlock: vi.fn(() => 'blk-x' as BlockId),
    startBlock: vi.fn(() => 'blk-x' as BlockId),
    setActiveBlockId: vi.fn(),
    getActiveBlockId: vi.fn(() => null),
    appendBlockOutput: vi.fn(),
    completeBlock: vi.fn(),
    cancelBlock: vi.fn(),
    errorBlock: vi.fn(),
    getRunningBlockIds: vi.fn(() => []),
  };
}

describe('block-store-port', () => {
  it('tryGetBlockStore returns the last bound adapter', () => {
    const s1 = stub();
    const dispose = bindBlockStore(s1);
    try {
      expect(tryGetBlockStore()).toBe(s1);
      expect(getBlockStore()).toBe(s1);
    } finally {
      dispose();
    }
  });

  it('disposer restores the previous binding (nesting)', () => {
    const outer = stub();
    const inner = stub();
    const d1 = bindBlockStore(outer);
    const d2 = bindBlockStore(inner);
    try {
      expect(tryGetBlockStore()).toBe(inner);
      d2();
      expect(tryGetBlockStore()).toBe(outer);
    } finally {
      d1();
    }
  });

  it('getBlockStore throws when no adapter is bound', () => {
    // Ensure we start clean. A disposer from a prior test suite would have
    // restored to undefined; in isolation this passes immediately.
    const d = bindBlockStore(stub());
    d();
    expect(() => getBlockStore()).toThrow(/no BlockStoreActions bound/u);
    expect(tryGetBlockStore()).toBeUndefined();
  });
});

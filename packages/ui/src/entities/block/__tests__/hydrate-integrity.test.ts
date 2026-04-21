/**
 * Bug 1 regression: hydrateBlocks must not leave holes in `order` where
 * `entities[id]` is undefined. Previously a `running` block in the hydration
 * list was filtered out of `nextEntities` but its ID still ended up in
 * `hydratedIds`, which was spread directly into `order`.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../model.js';
import type { Block } from '../model.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

const SESSION = 'hydrate-test' as SessionId;

function makeBlock(overrides: Partial<Block>): Block {
  return {
    id: overrides.id ?? 'block-default',
    sessionId: SESSION,
    command: 'echo test',
    cwd: '/',
    status: 'completed',
    startedAt: Date.now(),
    completedAt: Date.now(),
    exitCode: 0,
    outputChunks: [],
    collapsed: false,
    pinned: false,
    errorMessage: null,
    rerunOfId: null,
    tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('hydrateBlocks — order/entities integrity (bug 1)', () => {
  it('all ids in order have a defined entity after hydration (completed blocks)', () => {
    const blocks: Block[] = [
      makeBlock({ id: 'a', status: 'completed' }),
      makeBlock({ id: 'b', status: 'canceled' }),
      makeBlock({ id: 'c', status: 'error', errorMessage: 'oops' }),
    ];
    useBlockStore.getState().hydrateBlocks(blocks);
    const { order, entities } = useBlockStore.getState();
    for (const id of order) {
      expect(entities[id]).toBeDefined();
    }
  });

  it('running blocks in the hydration list are excluded from order entirely', () => {
    // Hydrate a mix: completed + running (running should be dropped per the
    // existing terminal-state filter). The critical invariant: the running
    // block's id must NOT appear in `order`.
    const blocks: Block[] = [
      makeBlock({ id: 'completed-1', status: 'completed' }),
      makeBlock({ id: 'running-bad', status: 'running', completedAt: null }),
      makeBlock({ id: 'completed-2', status: 'completed' }),
    ];
    useBlockStore.getState().hydrateBlocks(blocks);
    const { order, entities } = useBlockStore.getState();

    // No undefined holes: every id in order must map to a real block.
    for (const id of order) {
      expect(entities[id]).toBeDefined();
    }
    // The running block must be absent from order.
    expect(order).not.toContain('running-bad');
    // The valid blocks should be present.
    expect(order).toContain('completed-1');
    expect(order).toContain('completed-2');
  });

  it('no undefined holes even when all incoming blocks are running', () => {
    const blocks: Block[] = [
      makeBlock({ id: 'run-1', status: 'running', completedAt: null }),
      makeBlock({ id: 'run-2', status: 'running', completedAt: null }),
    ];
    useBlockStore.getState().hydrateBlocks(blocks);
    const { order, entities } = useBlockStore.getState();
    for (const id of order) {
      expect(entities[id]).toBeDefined();
    }
    expect(order).toHaveLength(0);
  });
});

/**
 * Mock runs-store — basic coverage so the P2-E stand-in is exercised
 * end-to-end until the real W2-D entity lands.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useRunsStore } from '../runs-store.js';

beforeEach(() => {
  useRunsStore.getState().resetAll();
});

describe('useRunsStore', () => {
  it('createRun appends the id to the ordered list', () => {
    useRunsStore.getState().createRun({
      id: 'r1',
      type: 'agent',
      command: null,
      startedAt: 1,
      metadata: { tool: 't' },
    });
    expect(useRunsStore.getState().order).toEqual(['r1']);
  });

  it('completeRun flips status to completed for exit 0', () => {
    useRunsStore.getState().createRun({
      id: 'r1',
      type: 'agent',
      command: null,
      startedAt: 1,
      metadata: {},
    });
    useRunsStore.getState().completeRun('r1', 0);
    expect(useRunsStore.getState().entities['r1']?.status).toBe('completed');
  });

  it('completeRun flips status to error for non-zero exit', () => {
    useRunsStore.getState().createRun({
      id: 'r1',
      type: 'agent',
      command: null,
      startedAt: 1,
      metadata: {},
    });
    useRunsStore.getState().completeRun('r1', 1);
    expect(useRunsStore.getState().entities['r1']?.status).toBe('error');
  });

  it('cancelRun only acts while the run is still running', () => {
    useRunsStore.getState().createRun({
      id: 'r1',
      type: 'agent',
      command: null,
      startedAt: 1,
      metadata: {},
    });
    useRunsStore.getState().completeRun('r1', 0);
    // Already completed — cancel is a no-op.
    useRunsStore.getState().cancelRun('r1');
    expect(useRunsStore.getState().entities['r1']?.status).toBe('completed');
  });

  it('appendRunOutput grows outputChunks in order', () => {
    useRunsStore.getState().createRun({
      id: 'r1',
      type: 'agent',
      command: null,
      startedAt: 1,
      metadata: {},
    });
    useRunsStore.getState().appendRunOutput('r1', new Uint8Array([1]));
    useRunsStore.getState().appendRunOutput('r1', new Uint8Array([2, 3]));
    expect(useRunsStore.getState().entities['r1']?.outputChunks.length).toBe(2);
  });

  it('resetAll clears order and entities', () => {
    useRunsStore.getState().createRun({
      id: 'r1',
      type: 'agent',
      command: null,
      startedAt: 1,
      metadata: {},
    });
    useRunsStore.getState().resetAll();
    expect(useRunsStore.getState().order).toEqual([]);
    expect(Object.keys(useRunsStore.getState().entities)).toEqual([]);
  });
});

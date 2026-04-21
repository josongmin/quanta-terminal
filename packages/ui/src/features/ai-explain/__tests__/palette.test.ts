/**
 * Palette command — "Explain last failure".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import {
  createExplainLastFailureCommand,
  EXPLAIN_LAST_FAILURE_COMMAND_ID,
  pickLastFailedBlockId,
} from '../palette.js';
import { EXPLAIN_BLOCK_EVENT } from '../AiExplainPanel.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('pickLastFailedBlockId', () => {
  it('returns null when there are no blocks', () => {
    expect(pickLastFailedBlockId()).toBeNull();
  });

  it('ignores running and successful blocks', () => {
    const okId = useBlockStore.getState().createBlock('ls', '/tmp');
    useBlockStore.getState().completeBlock(okId, 0);
    useBlockStore.getState().createBlock('sleep 10', '/tmp'); // still running
    expect(pickLastFailedBlockId()).toBeNull();
  });

  it('returns the most recent failed block', () => {
    const firstFail = useBlockStore.getState().createBlock('cmd1', '/tmp');
    useBlockStore.getState().completeBlock(firstFail, 1);
    const secondFail = useBlockStore.getState().createBlock('cmd2', '/tmp');
    useBlockStore.getState().completeBlock(secondFail, 127);
    // Add one successful block at the end — the picker should still find
    // the most recent FAILED block.
    const ok = useBlockStore.getState().createBlock('ok', '/tmp');
    useBlockStore.getState().completeBlock(ok, 0);
    expect(pickLastFailedBlockId()).toBe(secondFail);
  });
});

describe('createExplainLastFailureCommand', () => {
  it('has a stable id and label', () => {
    const cmd = createExplainLastFailureCommand();
    expect(cmd.id).toBe(EXPLAIN_LAST_FAILURE_COMMAND_ID);
    expect(cmd.id).toBe('ai.explainLastFailure');
    expect(cmd.section).toBe('actions');
    expect(typeof cmd.run).toBe('function');
  });

  it('run() dispatches quanta:explain-block with the most recent failed block id', () => {
    const failId = useBlockStore.getState().createBlock('boom', '/tmp');
    useBlockStore.getState().completeBlock(failId, 2);
    const listener = vi.fn();
    window.addEventListener(EXPLAIN_BLOCK_EVENT, listener);
    createExplainLastFailureCommand().run?.();
    expect(listener).toHaveBeenCalledOnce();
    const ev = listener.mock.calls[0]![0] as CustomEvent<{ blockId: string }>;
    expect(ev.detail.blockId).toBe(failId);
    window.removeEventListener(EXPLAIN_BLOCK_EVENT, listener);
  });

  it('run() is a no-op when there are no failed blocks', () => {
    const listener = vi.fn();
    window.addEventListener(EXPLAIN_BLOCK_EVENT, listener);
    createExplainLastFailureCommand().run?.();
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener(EXPLAIN_BLOCK_EVENT, listener);
  });
});

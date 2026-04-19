import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { rerunBlock } from '../rerun.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('rerunBlock', () => {
  it('resubmits the block\'s command via the injected callback', async () => {
    const id = useBlockStore.getState().createBlock('ls -la', '/tmp');
    // Audit P1 (fix 4): rerun is only legal on a non-running block. Mark it
    // completed before invoking — the legitimate user flow is "previous run
    // finished → click Rerun".
    useBlockStore.getState().completeBlock(id, 0);
    const submit = vi.fn().mockResolvedValue(undefined);
    const result = await rerunBlock({ blockId: id, submit });
    expect(result).toEqual({ ok: true });
    expect(submit).toHaveBeenCalledWith('ls -la');
  });

  it('returns not-found when the block is missing', async () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const result = await rerunBlock({ blockId: 'nope', submit });
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('captures a submit failure and returns the error', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    const err = new Error('pipe closed');
    const submit = vi.fn().mockRejectedValue(err);
    const result = await rerunBlock({ blockId: id, submit });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('submit-failed');
      expect(result.error).toBe(err);
    }
  });

  it('passes the predecessor id through the two-arg submit signature', async () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().completeBlock(id, 0);
    const captured: Array<readonly [string, { rerunOf: string } | undefined]> = [];
    // A declared two-arg function has `.length === 2`, which is how rerunBlock
    // picks the extended code path without changing callers.
    const submit = async (text: string, opts: { rerunOf: string }): Promise<void> => {
      captured.push([text, opts]);
    };
    const result = await rerunBlock({ blockId: id, submit });
    expect(result.ok).toBe(true);
    expect(captured).toEqual([['echo hi', { rerunOf: id }]]);
  });
});

describe('rerunBlock — audit P1 (fix 4): source-running guard', () => {
  it('rejects with source-running when the source block is still running', async () => {
    // Block is fresh from createBlock → status === 'running'.
    const id = useBlockStore.getState().createBlock('sleep 5', '/tmp');
    const submit = vi.fn().mockResolvedValue(undefined);
    const result = await rerunBlock({ blockId: id, submit });
    expect(result).toEqual({ ok: false, reason: 'source-running' });
    // The guard must fire BEFORE submit is invoked — no duplicate spawn.
    expect(submit).not.toHaveBeenCalled();
  });

  it('proceeds when the source block has completed', async () => {
    const id = useBlockStore.getState().createBlock('true', '/tmp');
    useBlockStore.getState().completeBlock(id, 0);
    const submit = vi.fn().mockResolvedValue(undefined);
    const result = await rerunBlock({ blockId: id, submit });
    expect(result).toEqual({ ok: true });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the source block errored', async () => {
    const id = useBlockStore.getState().createBlock('false', '/tmp');
    useBlockStore.getState().errorBlock(id, 'kaboom');
    const submit = vi.fn().mockResolvedValue(undefined);
    const result = await rerunBlock({ blockId: id, submit });
    expect(result).toEqual({ ok: true });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('proceeds when the source block was canceled', async () => {
    const id = useBlockStore.getState().createBlock('sleep 1', '/tmp');
    useBlockStore.getState().cancelBlock(id);
    const submit = vi.fn().mockResolvedValue(undefined);
    const result = await rerunBlock({ blockId: id, submit });
    expect(result).toEqual({ ok: true });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

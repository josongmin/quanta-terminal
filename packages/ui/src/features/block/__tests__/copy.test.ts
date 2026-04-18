import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import { copyBlock } from '../copy.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('copyBlock', () => {
  it('copies the block command when scope=command', async () => {
    const id = useBlockStore.getState().createBlock('ls -la', '/');
    const writeText = vi.fn().mockResolvedValue(undefined);
    const result = await copyBlock({ blockId: id, scope: 'command', writeText });
    expect(result.ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('ls -la');
  });

  it('copies the decoded output when scope=output', async () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    // "hi\n" in UTF-8
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([104, 105, 10]));
    const writeText = vi.fn().mockResolvedValue(undefined);
    const result = await copyBlock({ blockId: id, scope: 'output', writeText });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toBe(3);
    expect(writeText).toHaveBeenCalledWith('hi\n');
  });

  it('returns not-found when the block is missing', async () => {
    const writeText = vi.fn();
    const result = await copyBlock({ blockId: 'nope', scope: 'output', writeText });
    expect(result).toEqual({ ok: false, reason: 'not-found' });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns write-failed with the error when the writer rejects', async () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    const err = new Error('permission denied');
    const writeText = vi.fn().mockRejectedValue(err);
    const result = await copyBlock({ blockId: id, scope: 'command', writeText });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('write-failed');
      expect(result.error).toBe(err);
    }
  });
});

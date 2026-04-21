/**
 * Bug 2 regression: appendBlockOutput must be a no-op when the target block
 * is not in `running` state. A late PTY chunk arriving after completeBlock /
 * cancelBlock / errorBlock must not grow outputChunks on an already-terminal
 * block.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../model.js';

const CHUNK = new Uint8Array([104, 105]); // "hi"

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('appendBlockOutput — terminal-state guard (bug 2)', () => {
  it('does NOT append output to a completed block', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);

    const before = useBlockStore.getState().entities[id]!.outputChunks.length;
    useBlockStore.getState().appendBlockOutput(id, CHUNK);
    const after = useBlockStore.getState().entities[id]!.outputChunks.length;

    expect(after).toBe(before);
  });

  it('does NOT append output to a canceled block', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().cancelBlock(id);

    const before = useBlockStore.getState().entities[id]!.outputChunks.length;
    useBlockStore.getState().appendBlockOutput(id, CHUNK);
    const after = useBlockStore.getState().entities[id]!.outputChunks.length;

    expect(after).toBe(before);
  });

  it('does NOT append output to an errored block', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().errorBlock(id, 'process crashed');

    const before = useBlockStore.getState().entities[id]!.outputChunks.length;
    useBlockStore.getState().appendBlockOutput(id, CHUNK);
    const after = useBlockStore.getState().entities[id]!.outputChunks.length;

    expect(after).toBe(before);
  });

  it('DOES append output to a running block (control case)', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');

    const before = useBlockStore.getState().entities[id]!.outputChunks.length;
    useBlockStore.getState().appendBlockOutput(id, CHUNK);
    const after = useBlockStore.getState().entities[id]!.outputChunks.length;

    expect(after).toBe(before + 1);
  });

  it('completedAt is unchanged after a rejected append on a completed block', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    const completedAt = useBlockStore.getState().entities[id]!.completedAt;

    useBlockStore.getState().appendBlockOutput(id, CHUNK);

    expect(useBlockStore.getState().entities[id]!.completedAt).toBe(completedAt);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore, type Block } from '../../../entities/block/index.js';
import { compareBlocks, decodeStrippedOutput } from '../compareBlocks.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

function readBlock(id: string): Block {
  const b = useBlockStore.getState().entities[id];
  if (!b) throw new Error(`block ${id} missing`);
  return b;
}

describe('compareBlocks — deltas', () => {
  it('reports duration, bytes, exit-code deltas', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('ls', '/', { rerunOf: a });
    useBlockStore.getState().appendBlockOutput(a, new Uint8Array([104, 105])); // "hi"
    useBlockStore.getState().appendBlockOutput(b, new Uint8Array([104, 105, 33])); // "hi!"
    useBlockStore.getState().completeBlock(a, 0);
    useBlockStore.getState().completeBlock(b, 1);

    const view = compareBlocks(readBlock(a), readBlock(b));
    expect(view.deltas.leftBytes).toBe(2);
    expect(view.deltas.rightBytes).toBe(3);
    expect(view.deltas.bytesDeltaBytes).toBe(1);
    expect(view.deltas.leftExitCode).toBe(0);
    expect(view.deltas.rightExitCode).toBe(1);
    expect(view.deltas.commandsDiffer).toBe(false);
  });

  it('flags commandsDiffer when the two commands are not identical', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('ls -la', '/', { rerunOf: a });
    const view = compareBlocks(readBlock(a), readBlock(b));
    expect(view.deltas.commandsDiffer).toBe(true);
  });
});

describe('decodeStrippedOutput', () => {
  it('strips CSI SGR sequences from the decoded output', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    // "\x1b[31mred\x1b[0m ok\n"
    const bytes = new Uint8Array([
      0x1b, 0x5b, 0x33, 0x31, 0x6d, // ESC[31m
      0x72, 0x65, 0x64,             // "red"
      0x1b, 0x5b, 0x30, 0x6d,       // ESC[0m
      0x20, 0x6f, 0x6b, 0x0a,       // " ok\n"
    ]);
    useBlockStore.getState().appendBlockOutput(id, bytes);
    expect(decodeStrippedOutput(readBlock(id))).toBe('red ok\n');
  });

  it('returns empty string for a block with no chunks', () => {
    const id = useBlockStore.getState().createBlock('echo', '/');
    expect(decodeStrippedOutput(readBlock(id))).toBe('');
  });
});

describe('compareBlocks — diff of stripped text', () => {
  it('treats colored vs uncolored identical text as equal', () => {
    const a = useBlockStore.getState().createBlock('ls', '/');
    const b = useBlockStore.getState().createBlock('ls', '/', { rerunOf: a });
    // left has color wrapping: "\x1b[1mhi\x1b[0m\n"
    useBlockStore.getState().appendBlockOutput(a, new Uint8Array([
      0x1b, 0x5b, 0x31, 0x6d, 0x68, 0x69, 0x1b, 0x5b, 0x30, 0x6d, 0x0a,
    ]));
    // right is just "hi\n"
    useBlockStore.getState().appendBlockOutput(b, new Uint8Array([0x68, 0x69, 0x0a]));
    const view = compareBlocks(readBlock(a), readBlock(b));
    expect(view.diff.lines).toHaveLength(1);
    expect(view.diff.lines[0]?.kind).toBe(' ');
    expect(view.diff.lines[0]?.text).toBe('hi');
  });
});

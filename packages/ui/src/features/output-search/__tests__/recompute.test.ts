import { beforeEach, describe, expect, it } from 'vitest';
import { blockOutputText, computeMatches } from '../recompute.js';
import { useBlockStore } from '../../../entities/block/index.js';

const encoder = new TextEncoder();

function seedBlockWithBytes(command: string, cwd: string, bytes: Uint8Array) {
  const id = useBlockStore.getState().createBlock(command, cwd);
  useBlockStore.getState().appendBlockOutput(id, bytes);
  useBlockStore.getState().completeBlock(id, 0);
  return id;
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('blockOutputText', () => {
  it('returns empty for no chunks', () => {
    expect(blockOutputText([])).toBe('');
  });

  it('strips ANSI escape codes', () => {
    const raw = '\x1b[31mred\x1b[0m green';
    expect(blockOutputText([encoder.encode(raw)])).toBe('red green');
  });

  it('collapses carriage returns (progress bar redraws)', () => {
    // "downloading 50%\rdownloading 100%" → last redraw only
    const raw = 'downloading 50%\rdownloading 100%';
    expect(blockOutputText([encoder.encode(raw)])).toBe('downloading 100%');
  });
});

describe('computeMatches', () => {
  it('returns empty for empty query', () => {
    seedBlockWithBytes('echo foo', '/', encoder.encode('foo'));
    const blocks = useBlockStore.getState().order.map(
      (id) => useBlockStore.getState().entities[id]!,
    );
    expect(computeMatches({ blocks, query: '' })).toEqual([]);
  });

  it('counts matches across multiple blocks', () => {
    const a = seedBlockWithBytes('one', '/', encoder.encode('foo bar foo'));
    const b = seedBlockWithBytes('two', '/', encoder.encode('baz'));
    const c = seedBlockWithBytes('three', '/', encoder.encode('foo'));
    const blocks = useBlockStore.getState().order.map(
      (id) => useBlockStore.getState().entities[id]!,
    );
    const matches = computeMatches({ blocks, query: 'foo' });
    // 2 hits in block a, 0 in b, 1 in c → 3 total, blockId order preserved.
    expect(matches).toEqual([
      { blockId: a, charOffset: 0, length: 3 },
      { blockId: a, charOffset: 8, length: 3 },
      { blockId: c, charOffset: 0, length: 3 },
    ]);
    // block b contributes nothing — the blockId shouldn't appear.
    expect(matches.find((m) => m.blockId === b)).toBeUndefined();
  });

  it('is case-insensitive', () => {
    seedBlockWithBytes('case', '/', encoder.encode('Hello HELLO hello'));
    const blocks = useBlockStore.getState().order.map(
      (id) => useBlockStore.getState().entities[id]!,
    );
    expect(computeMatches({ blocks, query: 'hello' })).toHaveLength(3);
  });
});

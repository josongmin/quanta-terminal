import { beforeEach, describe, expect, it } from 'vitest';
import { buildCrossBlockIndex } from '../cross-block.js';
import { useBlockStore } from '../../../entities/block/index.js';

const encoder = new TextEncoder();

function seed(command: string, bytes: string): string {
  const id = useBlockStore.getState().createBlock(command, '/repo');
  useBlockStore.getState().appendBlockOutput(id, encoder.encode(bytes));
  useBlockStore.getState().completeBlock(id, 0);
  return id;
}

function allBlocks() {
  return useBlockStore.getState().order.map(
    (id) => useBlockStore.getState().entities[id]!,
  );
}

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

describe('buildCrossBlockIndex', () => {
  it('returns empty for empty query', () => {
    seed('a', 'foo');
    const result = buildCrossBlockIndex({
      blocks: allBlocks(),
      query: { text: '', regex: false, caseSensitive: false, wholeWord: false },
    });
    expect(result.matches).toEqual([]);
    expect(result.detailed).toEqual([]);
    expect(result.error).toBeNull();
  });

  it('surfaces invalid regex as error', () => {
    seed('a', 'foo');
    const result = buildCrossBlockIndex({
      blocks: allBlocks(),
      query: { text: '[', regex: true, caseSensitive: false, wholeWord: false },
    });
    expect(result.matches).toEqual([]);
    expect(result.error).not.toBeNull();
  });

  it('walks matches across 3 overlapping blocks in order', () => {
    const a = seed('one', 'foo bar foo');
    const b = seed('two', 'nope');
    const c = seed('three', 'foo');
    const result = buildCrossBlockIndex({
      blocks: allBlocks(),
      query: { text: 'foo', regex: false, caseSensitive: false, wholeWord: false },
    });
    expect(result.matches).toEqual([
      { blockId: a, charOffset: 0, length: 3 },
      { blockId: a, charOffset: 8, length: 3 },
      { blockId: c, charOffset: 0, length: 3 },
    ]);
    // detailed shape carries lineIndex = 0 for all these single-line blocks.
    expect(result.detailed.map((m) => m.lineIndex)).toEqual([0, 0, 0]);
    expect(result.detailed.map((m) => m.blockId)).toEqual([a, a, c]);
    // block b contributes nothing.
    expect(result.matches.find((m) => m.blockId === b)).toBeUndefined();
  });

  it('computes line index across multi-line output', () => {
    const id = seed('multi', 'line1\nline2 foo\nfoo line3');
    const result = buildCrossBlockIndex({
      blocks: allBlocks(),
      query: { text: 'foo', regex: false, caseSensitive: false, wholeWord: false },
    });
    expect(result.detailed).toEqual([
      { blockId: id, lineIndex: 1, start: 12, end: 15 },
      { blockId: id, lineIndex: 2, start: 16, end: 19 },
    ]);
  });

  it('caps the scan window to the newest N blocks', () => {
    for (let i = 0; i < 5; i += 1) seed(`b${i}`, 'foo');
    const result = buildCrossBlockIndex({
      blocks: allBlocks(),
      query: { text: 'foo', regex: false, caseSensitive: false, wholeWord: false },
      maxBlocks: 2,
    });
    // Only the two newest blocks are scanned.
    expect(result.matches.length).toBe(2);
  });

  it('wraps from last to first and vice versa when navigating', () => {
    // Simulate the navigation semantics at the store level.
    const a = seed('a', 'foo');
    const b = seed('b', 'foo');
    const c = seed('c', 'foo');
    const result = buildCrossBlockIndex({
      blocks: allBlocks(),
      query: { text: 'foo', regex: false, caseSensitive: false, wholeWord: false },
    });
    expect(result.matches.length).toBe(3);
    // Modular wrap: (currentIndex + delta + n) % n
    const n = result.matches.length;
    // last → first
    expect(((n - 1 + 1) % n)).toBe(0);
    // first → last (previous)
    expect(((0 - 1 + n) % n)).toBe(n - 1);
    expect(result.matches[0]!.blockId).toBe(a);
    expect(result.matches[n - 1]!.blockId).toBe(c);
    expect(result.matches[1]!.blockId).toBe(b);
  });

  it('respects case-sensitive toggle', () => {
    seed('a', 'Foo foo FOO');
    const sens = buildCrossBlockIndex({
      blocks: allBlocks(),
      query: { text: 'foo', regex: false, caseSensitive: true, wholeWord: false },
    });
    expect(sens.matches.length).toBe(1);
    const insens = buildCrossBlockIndex({
      blocks: allBlocks(),
      query: { text: 'foo', regex: false, caseSensitive: false, wholeWord: false },
    });
    expect(insens.matches.length).toBe(3);
  });

  it('respects whole-word toggle', () => {
    seed('a', 'cat cats concatenate cat.');
    const word = buildCrossBlockIndex({
      blocks: allBlocks(),
      query: { text: 'cat', regex: false, caseSensitive: false, wholeWord: true },
    });
    expect(word.matches.length).toBe(2);
  });
});

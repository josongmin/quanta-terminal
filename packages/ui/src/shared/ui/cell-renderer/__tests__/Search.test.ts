import { describe, it, expect } from 'vitest';
import { CellBuffer } from '../CellBuffer.js';
import { MirrorSource } from '../MirrorSource.js';
import { Search, SearchError } from '../Search.js';
import { widthAwareRow } from './fixtures.js';

function buildBuffer(lines: Array<{ text: string; continuation?: boolean }>, cols: number): CellBuffer {
  const source = new MirrorSource();
  const buffer = new CellBuffer(source, { rows: lines.length, cols });
  lines.forEach((l, i) =>
    buffer.writeRow(i, widthAwareRow(l.text, cols, l.continuation ?? false)),
  );
  return buffer;
}

describe('Search — basic', () => {
  it('returns empty for empty query', () => {
    const buffer = buildBuffer([{ text: 'hello' }], 5);
    const search = new Search(buffer);
    expect(
      search.find({ query: '', regex: false, caseSensitive: false, respectBufferScope: true }),
    ).toEqual([]);
  });

  it('finds a single substring match', () => {
    const buffer = buildBuffer([{ text: 'hello world' }], 11);
    const search = new Search(buffer);
    const matches = search.find({
      query: 'world',
      regex: false,
      caseSensitive: true,
      respectBufferScope: true,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]?.anchors.start.row).toBe(0);
  });

  it('finds multiple matches', () => {
    const buffer = buildBuffer([{ text: 'abcabcabc' }], 9);
    const search = new Search(buffer);
    const matches = search.find({
      query: 'abc',
      regex: false,
      caseSensitive: true,
      respectBufferScope: true,
    });
    expect(matches.length).toBe(3);
  });

  it('case-insensitive substring', () => {
    const buffer = buildBuffer([{ text: 'HELLO hello' }], 11);
    const search = new Search(buffer);
    const matches = search.find({
      query: 'hello',
      regex: false,
      caseSensitive: false,
      respectBufferScope: true,
    });
    expect(matches.length).toBe(2);
  });

  it('case-sensitive substring', () => {
    const buffer = buildBuffer([{ text: 'HELLO hello' }], 11);
    const search = new Search(buffer);
    const matches = search.find({
      query: 'hello',
      regex: false,
      caseSensitive: true,
      respectBufferScope: true,
    });
    expect(matches.length).toBe(1);
  });
});

describe('Search — wrap-aware', () => {
  it('matches span continuation rows (DoD-D-44)', () => {
    const buffer = buildBuffer(
      [{ text: 'abcde' }, { text: 'fghij', continuation: true }],
      5,
    );
    const search = new Search(buffer);
    const matches = search.find({
      query: 'cdefg',
      regex: false,
      caseSensitive: true,
      respectBufferScope: true,
    });
    expect(matches.length).toBe(1);
  });

  it('does not match across hard newlines', () => {
    const buffer = buildBuffer([{ text: 'abcde' }, { text: 'fghij' }], 5);
    const search = new Search(buffer);
    const matches = search.find({
      query: 'cdefg',
      regex: false,
      caseSensitive: true,
      respectBufferScope: true,
    });
    expect(matches.length).toBe(0);
  });
});

describe('Search — regex', () => {
  it('regex mode works (DoD-D-45)', () => {
    const buffer = buildBuffer([{ text: 'abc123def' }], 9);
    const search = new Search(buffer);
    const matches = search.find({
      query: '\\d+',
      regex: true,
      caseSensitive: true,
      respectBufferScope: true,
    });
    expect(matches.length).toBe(1);
  });

  it('regex invalid throws SearchError', () => {
    const buffer = buildBuffer([{ text: 'abc' }], 3);
    const search = new Search(buffer);
    expect(() =>
      search.find({
        query: '[',
        regex: true,
        caseSensitive: true,
        respectBufferScope: true,
      }),
    ).toThrow(SearchError);
  });

  it('regex case-insensitive modifier (DoD-D-46)', () => {
    const buffer = buildBuffer([{ text: 'Abc' }], 3);
    const search = new Search(buffer);
    const matches = search.find({
      query: 'abc',
      regex: true,
      caseSensitive: false,
      respectBufferScope: true,
    });
    expect(matches.length).toBe(1);
  });
});

describe('Search — cycling', () => {
  it('next/prev cycle wraps at ends (DoD-D-47)', () => {
    const buffer = buildBuffer([{ text: 'abc abc abc' }], 11);
    const search = new Search(buffer);
    search.find({
      query: 'abc',
      regex: false,
      caseSensitive: true,
      respectBufferScope: true,
    });
    expect(search.all().length).toBe(3);
    expect(search.next()).toBe(1);
    expect(search.next()).toBe(2);
    expect(search.next()).toBe(0);
    expect(search.prev()).toBe(2);
  });

  it('active() returns current match', () => {
    const buffer = buildBuffer([{ text: 'abc' }], 3);
    const search = new Search(buffer);
    search.find({
      query: 'abc',
      regex: false,
      caseSensitive: true,
      respectBufferScope: true,
    });
    expect(search.active()).toBeTruthy();
  });

  it('next on empty returns -1', () => {
    const buffer = buildBuffer([{ text: 'abc' }], 3);
    const search = new Search(buffer);
    expect(search.next()).toBe(-1);
    expect(search.prev()).toBe(-1);
  });
});

describe('Search — logical view stability', () => {
  it('buildLogicalView returns consistent text for unchanged buffer', () => {
    const buffer = buildBuffer([{ text: 'hello' }, { text: 'world' }], 5);
    const search = new Search(buffer);
    const v1 = search.buildLogicalView();
    const v2 = search.buildLogicalView();
    expect(v1.text).toBe(v2.text);
  });

  it('logical view joins continuation rows without separator', () => {
    const buffer = buildBuffer([{ text: 'foo' }, { text: 'bar', continuation: true }], 3);
    const search = new Search(buffer);
    const view = search.buildLogicalView();
    expect(view.text).toBe('foobar');
  });

  it('anchorAt maps offset back to row/col', () => {
    const buffer = buildBuffer([{ text: 'hello' }, { text: 'world' }], 5);
    const search = new Search(buffer);
    const view = search.buildLogicalView();
    const anchor = view.anchorAt(0);
    expect(anchor.row).toBe(0);
    expect(anchor.col).toBe(0);
  });
});

describe('Search — clear', () => {
  it('clear drops matches (DoD-D-48)', () => {
    const buffer = buildBuffer([{ text: 'abc' }], 3);
    const search = new Search(buffer);
    search.find({
      query: 'abc',
      regex: false,
      caseSensitive: true,
      respectBufferScope: true,
    });
    expect(search.all().length).toBe(1);
    search.clear();
    expect(search.all().length).toBe(0);
  });
});

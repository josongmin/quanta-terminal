/**
 * Tests for the composer insert-text bus.
 *
 * Verifies:
 *   - `applyInsert` joins an append with a single space separator
 *   - `applyInsert` in replace mode overwrites the existing value
 *   - `shellQuotePath` wraps paths with whitespace / special chars
 *   - `dispatchComposerInsertText` → `onComposerInsertText` is a round-trip
 */

import { describe, expect, it, vi } from 'vitest';

import {
  applyInsert,
  dispatchComposerInsertText,
  onComposerInsertText,
  shellQuotePath,
} from '../insertText.js';

describe('shellQuotePath', () => {
  it('leaves plain paths alone', () => {
    expect(shellQuotePath('/Users/me/code/proj/a.txt')).toBe('/Users/me/code/proj/a.txt');
  });
  it('quotes paths with spaces', () => {
    expect(shellQuotePath('/Users/me/My Docs/x.txt')).toBe('"/Users/me/My Docs/x.txt"');
  });
  it('escapes embedded double quotes and backslashes', () => {
    expect(shellQuotePath('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('applyInsert', () => {
  const base = { focus: false } as const;
  it('appends with a space when current is non-empty', () => {
    expect(
      applyInsert('mv', { text: '/tmp/a.txt', mode: 'append', quote: false, ...base }),
    ).toBe('mv /tmp/a.txt');
  });
  it('does not double-space when current already ends in whitespace', () => {
    expect(
      applyInsert('mv ', { text: '/tmp/a.txt', mode: 'append', quote: false, ...base }),
    ).toBe('mv /tmp/a.txt');
  });
  it('replaces when mode is replace', () => {
    expect(
      applyInsert('old', { text: 'new', mode: 'replace', quote: false, ...base }),
    ).toBe('new');
  });
  it('shell-quotes when quote:true', () => {
    expect(
      applyInsert('cat', {
        text: '/tmp/with space.txt',
        mode: 'append',
        quote: true,
        ...base,
      }),
    ).toBe('cat "/tmp/with space.txt"');
  });
});

describe('dispatch / subscribe', () => {
  it('round-trips a dispatched event through the subscriber', () => {
    const handler = vi.fn();
    const unsub = onComposerInsertText(handler);
    dispatchComposerInsertText('/tmp/x', { mode: 'append', quote: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      text: '/tmp/x',
      mode: 'append',
      quote: true,
      focus: true,
    });
    unsub();
    dispatchComposerInsertText('/tmp/y');
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('defaults mode=append, quote=false, focus=true', () => {
    const handler = vi.fn();
    const unsub = onComposerInsertText(handler);
    dispatchComposerInsertText('hello');
    expect(handler).toHaveBeenCalledWith({
      text: 'hello',
      mode: 'append',
      quote: false,
      focus: true,
    });
    unsub();
  });
});

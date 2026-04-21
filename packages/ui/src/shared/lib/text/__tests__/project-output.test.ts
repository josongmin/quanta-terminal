/**
 * Tests for `projectChunksToText` — the single entry point non-render consumers
 * use instead of reaching into `shared/lib/ansi-parser/`.
 */

import { describe, it, expect } from 'vitest';

import { projectChunksToText, stripAnsi } from '../project-output.js';

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('projectChunksToText', () => {
  it('returns empty string for an empty chunk list', () => {
    expect(projectChunksToText([])).toBe('');
  });

  it('returns empty string for a zero-length Uint8Array', () => {
    expect(projectChunksToText(new Uint8Array(0))).toBe('');
  });

  it('passes plain ASCII through unchanged (single chunk)', () => {
    expect(projectChunksToText([encode('hello world')])).toBe('hello world');
  });

  it('accepts a single concatenated Uint8Array (overload)', () => {
    expect(projectChunksToText(encode('hello world'))).toBe('hello world');
  });

  it('strips CSI SGR escape sequences', () => {
    expect(projectChunksToText([encode('[31merror[0m')])).toBe(
      'error',
    );
  });

  it('strips OSC sequences terminated by BEL', () => {
    expect(
      projectChunksToText([encode(']0;window titlevisible')]),
    ).toBe('visible');
  });

  it('strips OSC 8 hyperlinks cleanly', () => {
    expect(
      projectChunksToText([
        encode(
          ']8;;https://example.comexample]8;; tail',
        ),
      ]),
    ).toBe('example tail');
  });

  it('concatenates multiple chunks before decoding (no mojibake on UTF-8 splits)', () => {
    // "héllo" — é is 0xC3 0xA9 in UTF-8; split the multibyte sequence
    // across two chunks. A naive per-chunk decode would emit U+FFFD twice;
    // the helper must concat first, then decode, then strip.
    const chunks: Uint8Array[] = [
      new Uint8Array([0x68, 0xc3]), // "h" + first byte of é
      new Uint8Array([0xa9, 0x6c, 0x6c, 0x6f]), // second byte of é + "llo"
    ];
    expect(projectChunksToText(chunks)).toBe('héllo');
  });

  it('concatenates many small chunks in order', () => {
    const chunks = 'abcdef'.split('').map((ch) => encode(ch));
    expect(projectChunksToText(chunks)).toBe('abcdef');
  });

  it('preserves whitespace that screen readers / copy-paste consumers need', () => {
    expect(projectChunksToText([encode('line1\nline2\tcol2\r')])).toBe(
      'line1\nline2\tcol2\r',
    );
  });

  it('drops bare C0 control bytes that are not whitespace', () => {
    // 0x07 is BEL — non-whitespace C0, must be stripped.
    expect(projectChunksToText([encode('ab')])).toBe('ab');
  });

  it('is idempotent — stripping twice yields the same result', () => {
    const once = projectChunksToText([
      encode('[1;31mBOOM[0m done'),
    ]);
    expect(stripAnsi(once)).toBe(once);
    expect(once).toBe('BOOM done');
  });

  it('re-exported stripAnsi matches the ansi-parser implementation', () => {
    // The re-export exists so downstream callers that already own a
    // decoded string (e.g. `exportAsMarkdown` after decoding for raw view)
    // can strip without reaching back into `shared/lib/ansi-parser/`.
    expect(stripAnsi('[2J[Hclean')).toBe('clean');
  });
});

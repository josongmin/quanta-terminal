/**
 * OSC 8 hyperlink parsing. The spec is:
 *   ESC ] 8 ; <params> ; <URL> ST
 *   ESC ] 8 ; ;             ST   (close)
 * where ST is either BEL (0x07) or ESC \\.
 *
 * Nesting policy (documented on the parser): innermost wins — a new OPEN
 * replaces the current link; there is no stack.
 */

import { describe, expect, it } from 'vitest';
import { AnsiParser } from '../parser.js';
import type { AnsiSpan } from '../types.js';

const enc = new TextEncoder();

function parse(input: string): AnsiSpan[] {
  const p = new AnsiParser();
  const out = p.feed(enc.encode(input));
  return [...out, ...p.flush()];
}

describe('OSC 8 — hyperlinks', () => {
  it('open and close with BEL terminator', () => {
    const spans = parse('\x1b]8;;https://example.com\x07link\x1b]8;;\x07');
    expect(spans).toEqual([
      { text: 'link', link: 'https://example.com' },
    ]);
  });

  it('open and close with ST (ESC \\) terminator', () => {
    const spans = parse('\x1b]8;;https://a.example\x1b\\link\x1b]8;;\x1b\\');
    expect(spans).toEqual([
      { text: 'link', link: 'https://a.example' },
    ]);
  });

  it('preserves plain text before and after the link', () => {
    const spans = parse('see \x1b]8;;https://ex.com\x07here\x1b]8;;\x07 now');
    expect(spans).toEqual([
      { text: 'see ' },
      { text: 'here', link: 'https://ex.com' },
      { text: ' now' },
    ]);
  });

  it('carries params in the middle; params are ignored but tolerated', () => {
    // id=42 is a valid OSC 8 param.
    const spans = parse('\x1b]8;id=42;https://x\x07X\x1b]8;;\x07');
    expect(spans).toEqual([{ text: 'X', link: 'https://x' }]);
  });

  it('innermost-wins on re-open without close', () => {
    const spans = parse(
      '\x1b]8;;https://outer\x07a\x1b]8;;https://inner\x07b\x1b]8;;\x07',
    );
    expect(spans).toEqual([
      { text: 'a', link: 'https://outer' },
      { text: 'b', link: 'https://inner' },
    ]);
  });

  it('link style survives SGR reset (documented behaviour)', () => {
    const spans = parse('\x1b]8;;https://x\x07\x1b[1ma\x1b[0mb\x1b]8;;\x07');
    expect(spans).toEqual([
      { text: 'a', bold: true, link: 'https://x' },
      { text: 'b', link: 'https://x' },
    ]);
  });

  it('SGR attributes inside a link apply only to the enclosed run', () => {
    const spans = parse('\x1b]8;;https://x\x07\x1b[31mr\x1b]8;;\x07n');
    expect(spans).toEqual([
      { text: 'r', fg: { kind: 'named', index: 1 }, link: 'https://x' },
      { text: 'n', fg: { kind: 'named', index: 1 } },
    ]);
  });

  it('non-8 OSC (title, cwd, 52-clipboard) is silently ignored', () => {
    // Title (OSC 0) then regular text.
    const spans = parse('\x1b]0;My Title\x07plain');
    expect(spans).toEqual([{ text: 'plain' }]);
  });
});

/**
 * stripAnsi — regression coverage for the PTY byte streams that show up in
 * the Block peek + copy + export + diff paths.
 *
 * The motivating bug: zsh's `PROMPT_EOL_MARK` (the reverse-video `%` that
 * marks missing trailing newlines) emits a compact SGR bundle at the tail
 * of every command. Before the shared strip helper was introduced, each
 * consumer rolled its own regex and the peek path decoded raw bytes without
 * one, so users saw literal tofu glyphs for `\x1b` in the UI.
 */

import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../strip.js';

describe('stripAnsi', () => {
  it('returns empty input unchanged', () => {
    expect(stripAnsi('')).toBe('');
  });

  it('leaves plain ASCII alone', () => {
    expect(stripAnsi('hello world\n')).toBe('hello world\n');
  });

  it('preserves whitespace control bytes (\\t \\n \\r)', () => {
    expect(stripAnsi('a\tb\nc\rd')).toBe('a\tb\nc\rd');
  });

  it('strips a single CSI SGR sequence', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red');
  });

  it('strips the zsh PROMPT_EOL_MARK sequence ENTIRELY (SGR-wrapped `%`)', () => {
    // Updated: the mark IS the "no-trailing-newline" sigil zsh emits; it
    // is noise for our block-rendering UI (the shell already shows the
    // next prompt as its own block header). The whole wrapped glyph —
    // including the bare `%` — must go so the block output does not
    // dangle a stray `%` at the bottom of `ls`, `cat`, etc. See
    // `widgets/block-card/BlockCard.tsx` peek / BlockBody echo-strip for
    // the consuming UI path.
    const raw = '\x1b[1m\x1b[7m%\x1b[27m\x1b[1m\x1b[0m';
    expect(stripAnsi(raw)).toBe('');
    // Root / bash / tcsh variants also strip cleanly.
    expect(stripAnsi('\x1b[7m#\x1b[27m')).toBe('');
    expect(stripAnsi('\x1b[7m$\x1b[27m')).toBe('');
    expect(stripAnsi('\x1b[7m>\x1b[27m')).toBe('');
  });

  it('does NOT strip a bare `%` outside SGR brackets (preserve literal percents)', () => {
    expect(stripAnsi('50% done')).toBe('50% done');
    expect(stripAnsi('a%b%c')).toBe('a%b%c');
  });

  it('strips OSC with BEL terminator', () => {
    expect(stripAnsi('\x1b]0;Title\x07body')).toBe('body');
  });

  it('strips OSC with ESC-backslash terminator (ST)', () => {
    expect(stripAnsi('\x1b]8;;https://example.com\x1b\\text\x1b]8;;\x1b\\')).toBe('text');
  });

  it('strips DCS payloads', () => {
    expect(stripAnsi('\x1bPxy\x1b\\after')).toBe('after');
  });

  it('strips charset-select two-byte escapes', () => {
    expect(stripAnsi('\x1b(Bhello')).toBe('hello');
    expect(stripAnsi('\x1b)0pipes')).toBe('pipes');
  });

  it('strips bare two-byte ESC (RIS, save cursor, etc.)', () => {
    expect(stripAnsi('\x1b7saved\x1b8restored')).toBe('savedrestored');
    expect(stripAnsi('\x1bcmore')).toBe('more');
  });

  it('strips non-whitespace C0 control bytes', () => {
    expect(stripAnsi('a\x00b\x07c\x1fd\x7fe')).toBe('abcde');
  });

  it('is idempotent (strip ∘ strip === strip)', () => {
    const raw = 'x\x1b[31mred\x1b[0m\x1b]0;T\x07y';
    const once = stripAnsi(raw);
    expect(stripAnsi(once)).toBe(once);
  });

  it('nested / interleaved mix: every escape AND the wrapped EOL-mark goes, other printables stay', () => {
    // `\x1b[1m\x1b[7m%\x1b[0m` is a zsh PROMPT_EOL_MARK — matched as a
    // unit by the EOL_MARK stripper and removed whole, including the
    // bare `%`. Everything else printable (file.txt, "next") survives.
    const raw =
      '\x1b]0;Title\x07\x1b[1m\x1b[7m%\x1b[0m\x1b(B  \rfile.txt\n\x1bPxyz\x1b\\next';
    expect(stripAnsi(raw)).toBe('  \rfile.txt\nnext');
  });
});

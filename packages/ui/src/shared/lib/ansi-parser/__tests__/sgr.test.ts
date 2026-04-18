/**
 * Per-SGR-code coverage. Every supported code has at least one assertion
 * here; adding a new code requires adding a test row (OCP-style contract).
 */

import { describe, expect, it } from 'vitest';
import { AnsiParser } from '../parser.js';
import type { AnsiSpan } from '../types.js';

const enc = new TextEncoder();

/** Feed a single string and flush; return all spans. */
function parse(input: string): AnsiSpan[] {
  const p = new AnsiParser();
  const out = p.feed(enc.encode(input));
  return [...out, ...p.flush()];
}

describe('SGR — attribute codes', () => {
  it('0 resets all attributes', () => {
    const spans = parse('\x1b[1;3;4mfoo\x1b[0mbar');
    expect(spans).toEqual([
      { text: 'foo', bold: true, italic: true, underline: true },
      { text: 'bar' },
    ]);
  });

  it('1 bold / 22 clears bold and dim', () => {
    expect(parse('\x1b[1mA\x1b[22mB')).toEqual([
      { text: 'A', bold: true },
      { text: 'B' },
    ]);
    // 22 also clears dim:
    expect(parse('\x1b[2mD\x1b[22mN')).toEqual([
      { text: 'D', dim: true },
      { text: 'N' },
    ]);
  });

  it('2 dim', () => {
    expect(parse('\x1b[2mx')).toEqual([{ text: 'x', dim: true }]);
  });

  it('3 italic / 23 no-italic', () => {
    expect(parse('\x1b[3mi\x1b[23mn')).toEqual([
      { text: 'i', italic: true },
      { text: 'n' },
    ]);
  });

  it('4 underline and 21 also set underline; 24 clears it', () => {
    expect(parse('\x1b[4mu\x1b[24mn')).toEqual([
      { text: 'u', underline: true },
      { text: 'n' },
    ]);
    expect(parse('\x1b[21mU')).toEqual([{ text: 'U', underline: true }]);
  });

  it('7 inverse / 27 no-inverse', () => {
    expect(parse('\x1b[7mv\x1b[27mn')).toEqual([
      { text: 'v', inverse: true },
      { text: 'n' },
    ]);
  });

  it('8 hidden / 28 no-hidden', () => {
    expect(parse('\x1b[8mh\x1b[28mn')).toEqual([
      { text: 'h', hidden: true },
      { text: 'n' },
    ]);
  });

  it('9 strike / 29 no-strike', () => {
    expect(parse('\x1b[9ms\x1b[29mn')).toEqual([
      { text: 's', strike: true },
      { text: 'n' },
    ]);
  });

  it('bare CSI m is treated as reset (0)', () => {
    const spans = parse('\x1b[1mx\x1b[my');
    expect(spans).toEqual([
      { text: 'x', bold: true },
      { text: 'y' },
    ]);
  });

  it('empty CSI parameter slot is treated as 0 (e.g. CSI ;31 m)', () => {
    // `CSI ;31 m` = reset then red fg
    const spans = parse('\x1b[1mx\x1b[;31my');
    expect(spans).toEqual([
      { text: 'x', bold: true },
      { text: 'y', fg: { kind: 'named', index: 1 } },
    ]);
  });
});

describe('SGR — named colors', () => {
  it.each([
    [30, 0],
    [31, 1],
    [32, 2],
    [33, 3],
    [34, 4],
    [35, 5],
    [36, 6],
    [37, 7],
  ])('code %d maps to fg named index %d', (code, index) => {
    const spans = parse(`\x1b[${code}mx`);
    expect(spans).toEqual([{ text: 'x', fg: { kind: 'named', index } }]);
  });

  it.each([
    [40, 0],
    [41, 1],
    [42, 2],
    [43, 3],
    [44, 4],
    [45, 5],
    [46, 6],
    [47, 7],
  ])('code %d maps to bg named index %d', (code, index) => {
    const spans = parse(`\x1b[${code}mx`);
    expect(spans).toEqual([{ text: 'x', bg: { kind: 'named', index } }]);
  });

  it('39 resets fg to default; 49 resets bg to default', () => {
    const spans = parse('\x1b[31;42mx\x1b[39;49my');
    expect(spans).toEqual([
      { text: 'x', fg: { kind: 'named', index: 1 }, bg: { kind: 'named', index: 2 } },
      { text: 'y', fg: { kind: 'default' }, bg: { kind: 'default' } },
    ]);
  });
});

describe('SGR — bright colors', () => {
  it.each([
    [90, 0],
    [91, 1],
    [97, 7],
  ])('code %d maps to fg bright index %d', (code, index) => {
    const spans = parse(`\x1b[${code}mx`);
    expect(spans).toEqual([{ text: 'x', fg: { kind: 'bright', index } }]);
  });

  it.each([
    [100, 0],
    [101, 1],
    [107, 7],
  ])('code %d maps to bg bright index %d', (code, index) => {
    const spans = parse(`\x1b[${code}mx`);
    expect(spans).toEqual([{ text: 'x', bg: { kind: 'bright', index } }]);
  });
});

describe('SGR — indexed (256-color)', () => {
  it('38;5;N sets fg to indexed N', () => {
    const spans = parse('\x1b[38;5;200mx');
    expect(spans).toEqual([{ text: 'x', fg: { kind: 'indexed', index: 200 } }]);
  });

  it('48;5;N sets bg to indexed N', () => {
    const spans = parse('\x1b[48;5;17mx');
    expect(spans).toEqual([{ text: 'x', bg: { kind: 'indexed', index: 17 } }]);
  });

  it('clamps N > 255 to 255', () => {
    const spans = parse('\x1b[38;5;999mx');
    expect(spans).toEqual([{ text: 'x', fg: { kind: 'indexed', index: 255 } }]);
  });

  it('missing N is tolerated and leaves fg unchanged', () => {
    const spans = parse('\x1b[38;5mx');
    expect(spans).toEqual([{ text: 'x' }]);
  });
});

describe('SGR — truecolor', () => {
  it('38;2;R;G;B sets fg to rgb', () => {
    const spans = parse('\x1b[38;2;12;34;56mx');
    expect(spans).toEqual([{ text: 'x', fg: { kind: 'rgb', r: 12, g: 34, b: 56 } }]);
  });

  it('48;2;R;G;B sets bg to rgb', () => {
    const spans = parse('\x1b[48;2;255;0;128mx');
    expect(spans).toEqual([{ text: 'x', bg: { kind: 'rgb', r: 255, g: 0, b: 128 } }]);
  });

  it('clamps channel > 255 to 255', () => {
    const spans = parse('\x1b[38;2;999;0;0mx');
    expect(spans).toEqual([{ text: 'x', fg: { kind: 'rgb', r: 255, g: 0, b: 0 } }]);
  });

  it('short truecolor (missing channels) is tolerated', () => {
    const spans = parse('\x1b[38;2;12mx');
    expect(spans).toEqual([{ text: 'x' }]);
  });
});

describe('SGR — stateful runs', () => {
  it('style applies only to following text, not retro-actively', () => {
    const spans = parse('plain\x1b[31mred');
    expect(spans).toEqual([
      { text: 'plain' },
      { text: 'red', fg: { kind: 'named', index: 1 } },
    ]);
  });

  it('successive escapes with no text between do not emit empty spans', () => {
    const spans = parse('\x1b[1m\x1b[31mred');
    expect(spans).toEqual([
      { text: 'red', bold: true, fg: { kind: 'named', index: 1 } },
    ]);
  });

  it('private-mode SGR (CSI ? ... m) is ignored', () => {
    const spans = parse('\x1b[?1mx');
    expect(spans).toEqual([{ text: 'x' }]);
  });
});

/**
 * Rust↔TS parity tests for `packages/ui/src/shared/lib/width/`.
 *
 * These tests load the exact golden corpora from the Rust side
 * (`crates/quanta-vt-width/tests/fixtures/*.txt`) and assert the TS
 * classifier produces identical results for every entry.
 *
 * Divergence is a hard CI failure. The fixture path is resolved relative
 * to the repo root via `__dirname`, so moving the fixtures requires
 * updating both sides in the same PR.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DefaultClassifier } from '../classifier.js';
import {
  cellsForWidth,
  resolveAmbiguousPolicy,
  type CellWidth,
} from '../types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// __tests__/ → width/ → lib/ → shared/ → src/ → ui/ → packages/ → repo root.
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..', '..', '..');
const WIDTH_CORPUS = resolve(
  REPO_ROOT,
  'crates/quanta-vt-width/tests/fixtures/width_corpus.txt',
);
const GRAPHEME_CORPUS = resolve(
  REPO_ROOT,
  'crates/quanta-vt-width/tests/fixtures/grapheme_corpus.txt',
);

function parseWidthToken(tok: string): CellWidth {
  switch (tok.trim()) {
    case '0':
      return 'zero';
    case '1':
      return 'one';
    case '2':
      return 'two';
    default:
      throw new Error(`unexpected width token in corpus: ${JSON.stringify(tok)}`);
  }
}

/** UTF-8 hex byte stream → JS string. Matches the Rust helper. */
function hexBytesToString(hex: string): string {
  const bytes: number[] = [];
  for (const token of hex.trim().split(/\s+/)) {
    if (token.length === 0) continue;
    const b = Number.parseInt(token, 16);
    if (!Number.isFinite(b) || b < 0 || b > 0xff) {
      throw new Error(`bad hex token ${JSON.stringify(token)}`);
    }
    bytes.push(b);
  }
  // TextDecoder with fatal=true so invalid UTF-8 throws rather than returning
  // U+FFFD — the corpus is curated, bad UTF-8 here is a bug.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  return decoder.decode(new Uint8Array(bytes));
}

function parseCorpusLines(text: string): string[] {
  return text.split('\n').filter((l) => l.length > 0 && !l.startsWith('#'));
}

describe('width parity — width_corpus.txt', () => {
  const classifier = new DefaultClassifier('narrow');
  const raw = readFileSync(WIDTH_CORPUS, 'utf-8');
  const lines = parseCorpusLines(raw);

  it('has at least 500 entries', () => {
    expect(lines.length).toBeGreaterThanOrEqual(500);
  });

  it('every entry matches the Rust side under narrow policy', () => {
    const mismatches: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      // Format: <literal><TAB><expected width (0|1|2)><TAB><note>
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const literal = parts[0];
      const expectedTok = parts[1];
      if (literal === undefined || expectedTok === undefined) continue;
      const note = parts[2] ?? '';
      const expected = parseWidthToken(expectedTok);
      const { width } = classifier.classifyGrapheme(literal);
      if (width !== expected) {
        mismatches.push(
          `line ${i + 1}: literal=${JSON.stringify(literal)} expected=${expected} got=${width} note=${JSON.stringify(note)}`,
        );
      }
    }
    expect(mismatches, `\n${mismatches.join('\n')}`).toEqual([]);
  });
});

describe('grapheme parity — grapheme_corpus.txt', () => {
  const classifier = new DefaultClassifier('narrow');
  const raw = readFileSync(GRAPHEME_CORPUS, 'utf-8');
  const lines = parseCorpusLines(raw);

  it('has at least 100 entries', () => {
    expect(lines.length).toBeGreaterThanOrEqual(100);
  });

  it('every entry matches the Rust side: grapheme count and widths', () => {
    const mismatches: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      // Format: <hex utf-8 bytes><TAB><grapheme count><TAB><widths_csv>
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const [hex, countStr, widthsCsv] = parts;
      if (hex === undefined || countStr === undefined || widthsCsv === undefined) continue;
      const s = hexBytesToString(hex);
      const expectedCount = Number.parseInt(countStr.trim(), 10);
      if (!Number.isFinite(expectedCount)) {
        throw new Error(`bad count on line ${i + 1}: ${JSON.stringify(countStr)}`);
      }
      const expectedWidths = widthsCsv.split(',').map((tok) => parseWidthToken(tok));
      const got = classifier.classifyStr(s);
      if (got.length !== expectedCount) {
        mismatches.push(
          `line ${i + 1}: ${JSON.stringify(s)}: grapheme count mismatch expected=${expectedCount} got=${got.length}`,
        );
        continue;
      }
      if (got.length === expectedWidths.length) {
        for (let j = 0; j < got.length; j += 1) {
          const actual = got[j];
          const expected = expectedWidths[j];
          if (actual === undefined || expected === undefined) continue;
          if (actual.width !== expected) {
            mismatches.push(
              `line ${i + 1}: ${JSON.stringify(s)}: cluster ${j} (${JSON.stringify(actual.grapheme)}): expected=${expected} got=${actual.width}`,
            );
          }
        }
      }
    }
    expect(mismatches, `\n${mismatches.join('\n')}`).toEqual([]);
  });
});

describe('AmbiguousWidthPolicy.resolve — 7 documented cases', () => {
  it('macos + any lang → narrow', () => {
    expect(resolveAmbiguousPolicy('auto', 'macos', 'ko_KR.UTF-8')).toBe('narrow');
  });
  it('windows + any lang → narrow', () => {
    expect(resolveAmbiguousPolicy('auto', 'windows', 'ja_JP')).toBe('narrow');
  });
  it('linux + en lang → narrow', () => {
    expect(resolveAmbiguousPolicy('auto', 'linux', 'en_US.UTF-8')).toBe('narrow');
  });
  it('linux + ko lang → wide', () => {
    expect(resolveAmbiguousPolicy('auto', 'linux', 'ko_KR.UTF-8')).toBe('wide');
  });
  it('linux + ja lang → wide', () => {
    expect(resolveAmbiguousPolicy('auto', 'linux', 'ja_JP.UTF-8')).toBe('wide');
  });
  it('linux + zh lang → wide', () => {
    expect(resolveAmbiguousPolicy('auto', 'linux', 'zh_CN.UTF-8')).toBe('wide');
  });
  it('other_unix + no lang → narrow', () => {
    expect(resolveAmbiguousPolicy('auto', 'other_unix', null)).toBe('narrow');
  });
  it('already-resolved narrow passes through', () => {
    expect(resolveAmbiguousPolicy('narrow', 'linux', 'ko_KR.UTF-8')).toBe('narrow');
  });
  it('already-resolved wide passes through', () => {
    expect(resolveAmbiguousPolicy('wide', 'macos', null)).toBe('wide');
  });
});

describe('VS15 / VS16 post-modification', () => {
  const classifier = new DefaultClassifier('narrow');

  it('❤ (U+2764) alone is 1 cell', () => {
    expect(classifier.classifyGrapheme('\u2764').width).toBe('one');
  });
  it('❤️ (U+2764 + VS16) is 2 cells', () => {
    expect(classifier.classifyGrapheme('\u2764\ufe0f').width).toBe('two');
  });
  it('❤︎ (U+2764 + VS15) is 1 cell', () => {
    expect(classifier.classifyGrapheme('\u2764\ufe0e').width).toBe('one');
  });
  it('1 + VS15 is 1 cell (text-presentation forced)', () => {
    expect(classifier.classifyGrapheme('1\ufe0e').width).toBe('one');
  });
  it('1️⃣ (1 + VS16 + U+20E3) is 2 cells (keycap)', () => {
    expect(classifier.classifyGrapheme('1\ufe0f\u20e3').width).toBe('two');
  });
  it('VS15 isolated is 0 cells', () => {
    expect(classifier.classifyGrapheme('\ufe0e').width).toBe('zero');
  });
  it('VS16 isolated is 0 cells', () => {
    expect(classifier.classifyGrapheme('\ufe0f').width).toBe('zero');
  });
});

describe('ZWJ collapse', () => {
  const classifier = new DefaultClassifier('narrow');
  it('family (4 emoji + 3 ZWJ) is 1 grapheme, width 2', () => {
    const family =
      '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}';
    const out = classifier.classifyStr(family);
    expect(out.length).toBe(1);
    expect(out[0]?.width).toBe('two');
  });
  it('woman technologist (2 emoji + ZWJ) is 1 grapheme, width 2', () => {
    const woman = '\u{1F469}\u{200D}\u{1F4BB}';
    const out = classifier.classifyStr(woman);
    expect(out.length).toBe(1);
    expect(out[0]?.width).toBe('two');
  });
});

describe('combining marks', () => {
  const classifier = new DefaultClassifier('narrow');
  it('e + U+0301 is 1 grapheme of width 1', () => {
    const out = classifier.classifyStr('e\u0301');
    expect(out.length).toBe(1);
    expect(out[0]?.width).toBe('one');
    expect(out[0]?.grapheme).toBe('e\u0301');
  });
  it('isolated combining mark is 0 cells', () => {
    expect(classifier.classifyGrapheme('\u0301').width).toBe('zero');
  });
});

describe('regional indicator pairs (flags)', () => {
  const classifier = new DefaultClassifier('narrow');
  it('🇰🇷 (KR) is 1 grapheme of width 2', () => {
    const out = classifier.classifyStr('\u{1F1F0}\u{1F1F7}');
    expect(out.length).toBe(1);
    expect(out[0]?.width).toBe('two');
  });
});

describe('wrapEligible', () => {
  const classifier = new DefaultClassifier('narrow');
  it('one-cell at col 79 of 80 cols → fits', () => {
    expect(classifier.wrapEligible('one', 'one', 79, 80)).toBe('fits');
  });
  it('two-cell at col 79 of 80 cols → must_wrap', () => {
    expect(classifier.wrapEligible('one', 'two', 79, 80)).toBe('must_wrap');
  });
  it('two-cell at col 78 of 80 cols → fits', () => {
    expect(classifier.wrapEligible('one', 'two', 78, 80)).toBe('fits');
  });
  it('one-cell at col 80 of 80 cols → must_wrap', () => {
    expect(classifier.wrapEligible('one', 'one', 80, 80)).toBe('must_wrap');
  });
  it('zero-width at any col → no_break_hint', () => {
    expect(classifier.wrapEligible('one', 'zero', 5, 80)).toBe('no_break_hint');
  });
});

describe('cellsForWidth helper', () => {
  it('zero → 0', () => {
    expect(cellsForWidth('zero')).toBe(0);
  });
  it('one → 1', () => {
    expect(cellsForWidth('one')).toBe(1);
  });
  it('two → 2', () => {
    expect(cellsForWidth('two')).toBe(2);
  });
});

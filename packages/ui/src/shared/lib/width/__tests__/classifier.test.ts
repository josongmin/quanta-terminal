/**
 * Unit tests for `DefaultClassifier` and `resolveAmbiguousPolicy`.
 *
 * Scope: single-module behavior — grapheme segmentation, per-cluster width,
 * wrap eligibility, ambiguous-width policy resolution. Rust ↔ TS byte-for-
 * byte parity is owned by `parity.test.ts` and deliberately NOT repeated
 * here.
 *
 * Everything below exercises the TS classifier in isolation so a regression
 * in Intl.Segmenter handling, override application, or VS / ZWJ cluster
 * logic surfaces immediately without requiring the Rust fixture corpus.
 */

import { describe, expect, it } from 'vitest';

import { DefaultClassifier } from '../classifier.js';
import { resolveAmbiguousPolicy } from '../types.js';

/** Convenience — narrow-policy classifier is the default for macOS hosts. */
const narrow = () => new DefaultClassifier('narrow');
/** Wide-policy classifier models the CJK Linux case. */
const wide = () => new DefaultClassifier('wide');

describe('DefaultClassifier.classifyGrapheme — plain code points', () => {
  it('ASCII "a" (U+0061) returns width "one"', () => {
    const c = narrow();
    expect(c.classifyGrapheme('a')).toEqual({ grapheme: 'a', width: 'one' });
  });

  it('CJK "한" (U+D55C) returns width "two"', () => {
    const c = narrow();
    expect(c.classifyGrapheme('한')).toEqual({ grapheme: '한', width: 'two' });
  });

  it('Latin combining cluster "é" (e U+0065 + ́ U+0301) is ONE grapheme of width "one"', () => {
    // Not NFC-composed — deliberately decomposed to force cluster merging.
    const c = narrow();
    const decomposed = 'e\u0301';
    const result = c.classifyGrapheme(decomposed);
    expect(result.width).toBe('one');
    // The decomposed pair must collapse into a single grapheme cluster.
    expect(Array.from(result.grapheme)).toHaveLength(2);
    expect(result.grapheme).toBe(decomposed);
  });

  it('empty input yields the neutral element { "", "zero" }', () => {
    const c = narrow();
    expect(c.classifyGrapheme('')).toEqual({ grapheme: '', width: 'zero' });
  });

  it('zero-width space (U+200B) alone → width "zero" via override table', () => {
    const c = narrow();
    expect(c.classifyGrapheme('\u200b').width).toBe('zero');
  });

  it('lone ZWJ (U+200D) → width "zero" (override authoritative; no cluster widening)', () => {
    const c = narrow();
    expect(c.classifyGrapheme('\u200d').width).toBe('zero');
  });

  it('C0 control (U+0007 BEL) → width "zero"', () => {
    const c = narrow();
    expect(c.classifyGrapheme('\u0007').width).toBe('zero');
  });
});

describe('DefaultClassifier.classifyGrapheme — emoji & VS clusters', () => {
  it('emoji without VS — bare sun "\u2600" wields the EmojiWidening override → "two"', () => {
    // U+2600 BLACK SUN WITH RAYS. Overrides pin this to 2 cells.
    const c = narrow();
    expect(c.classifyGrapheme('\u2600').width).toBe('two');
  });

  it('☀︎ with VS15 (U+2600 U+FE0E) forces text presentation → "one"', () => {
    const c = narrow();
    const textSun = '\u2600\ufe0e';
    expect(c.classifyGrapheme(textSun).width).toBe('one');
  });

  it('☀️ with VS16 (U+2600 U+FE0F) forces emoji presentation → "two"', () => {
    const c = narrow();
    const emojiSun = '\u2600\ufe0f';
    expect(c.classifyGrapheme(emojiSun).width).toBe('two');
  });

  it('ZWJ cluster family "👨‍👩‍👧" collapses to a single 2-cell grapheme', () => {
    const c = narrow();
    // U+1F468 MAN + ZWJ + U+1F469 WOMAN + ZWJ + U+1F467 GIRL
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    const result = c.classifyGrapheme(family);
    expect(result.grapheme).toBe(family);
    expect(result.width).toBe('two');
  });

  it('regional indicator pair "🇰🇷" (KR flag) → single cluster, width "two"', () => {
    const c = narrow();
    // U+1F1F0 + U+1F1F7
    const kr = '\u{1F1F0}\u{1F1F7}';
    const result = c.classifyGrapheme(kr);
    expect(result.grapheme).toBe(kr);
    expect(result.width).toBe('two');
  });

  it('thumbs-up with medium skin tone "👍🏽" → single cluster, width "two"', () => {
    const c = narrow();
    // U+1F44D + U+1F3FD
    const thumb = '\u{1F44D}\u{1F3FD}';
    const result = c.classifyGrapheme(thumb);
    expect(result.grapheme).toBe(thumb);
    expect(result.width).toBe('two');
  });

  it('classifyGrapheme on a multi-grapheme string segments and classifies the FIRST cluster only', () => {
    const c = narrow();
    // "a" followed by "한" — defensive behavior documented in the contract.
    const { grapheme, width } = c.classifyGrapheme('a한');
    expect(grapheme).toBe('a');
    expect(width).toBe('one');
  });
});

describe('DefaultClassifier.classifyGrapheme — ambiguous-width policy', () => {
  it('U+203B REFERENCE MARK is width "one" under narrow policy', () => {
    const c = narrow();
    expect(c.classifyGrapheme('\u203b').width).toBe('one');
  });

  it('U+203B REFERENCE MARK is width "two" under wide policy', () => {
    const c = wide();
    expect(c.classifyGrapheme('\u203b').width).toBe('two');
  });

  it('arrow U+2190 is pinned narrow by overrides regardless of policy', () => {
    // Overrides beat the base-width ambiguous lookup, so 2190 stays 1 even
    // when ambigWide is true.
    expect(narrow().classifyGrapheme('\u2190').width).toBe('one');
    expect(wide().classifyGrapheme('\u2190').width).toBe('one');
  });
});

describe('DefaultClassifier.classifyStr', () => {
  it('segments a mixed string into the correct ordered (grapheme, width) sequence', () => {
    const c = narrow();
    // ASCII + CJK + emoji flag.
    const out = c.classifyStr('a한\u{1F1F0}\u{1F1F7}');
    expect(out).toEqual([
      { grapheme: 'a', width: 'one' },
      { grapheme: '한', width: 'two' },
      { grapheme: '\u{1F1F0}\u{1F1F7}', width: 'two' },
    ]);
  });

  it('empty string yields empty array', () => {
    const c = narrow();
    expect(c.classifyStr('')).toEqual([]);
  });
});

describe('DefaultClassifier.wrapEligible', () => {
  const c = narrow();

  it('1-cell grapheme fits when col < cols', () => {
    expect(c.wrapEligible('one', 'one', 0, 10)).toBe('fits');
    expect(c.wrapEligible('one', 'one', 9, 10)).toBe('fits');
  });

  it('1-cell grapheme at col == cols must wrap', () => {
    expect(c.wrapEligible('one', 'one', 10, 10)).toBe('must_wrap');
  });

  it('2-cell grapheme with exactly 2 remaining fits', () => {
    expect(c.wrapEligible('one', 'two', 8, 10)).toBe('fits');
  });

  it('2-cell grapheme with only 1 remaining column must wrap (no split)', () => {
    // Core 2-cell invariant: a wide char MUST NOT be split across rows.
    expect(c.wrapEligible('one', 'two', 9, 10)).toBe('must_wrap');
  });

  it('2-cell grapheme with 0 remaining must wrap', () => {
    expect(c.wrapEligible('one', 'two', 10, 10)).toBe('must_wrap');
  });

  it('zero-width grapheme returns no_break_hint regardless of remaining space', () => {
    expect(c.wrapEligible('one', 'zero', 0, 10)).toBe('no_break_hint');
    expect(c.wrapEligible('one', 'zero', 10, 10)).toBe('no_break_hint');
  });

  it('negative or overshot col clamps to 0 remaining (must wrap for 1-cell)', () => {
    // Math.max(0, cols - col) — col > cols → remaining = 0 → can't fit 1.
    expect(c.wrapEligible('one', 'one', 15, 10)).toBe('must_wrap');
  });
});

describe('resolveAmbiguousPolicy', () => {
  it('already-resolved "narrow" passes through for every (os, lang) combo', () => {
    expect(resolveAmbiguousPolicy('narrow', 'macos', null)).toBe('narrow');
    expect(resolveAmbiguousPolicy('narrow', 'linux', 'ko_KR.UTF-8')).toBe('narrow');
    expect(resolveAmbiguousPolicy('narrow', 'other_unix', undefined)).toBe('narrow');
  });

  it('already-resolved "wide" passes through for every (os, lang) combo', () => {
    expect(resolveAmbiguousPolicy('wide', 'macos', null)).toBe('wide');
    expect(resolveAmbiguousPolicy('wide', 'windows', 'en_US.UTF-8')).toBe('wide');
  });

  it('auto on macOS resolves to narrow regardless of $LANG', () => {
    expect(resolveAmbiguousPolicy('auto', 'macos', 'ko_KR.UTF-8')).toBe('narrow');
    expect(resolveAmbiguousPolicy('auto', 'macos', 'ja_JP')).toBe('narrow');
    expect(resolveAmbiguousPolicy('auto', 'macos', null)).toBe('narrow');
  });

  it('auto on Windows resolves to narrow regardless of $LANG', () => {
    expect(resolveAmbiguousPolicy('auto', 'windows', 'zh_CN.GB18030')).toBe('narrow');
    expect(resolveAmbiguousPolicy('auto', 'windows', undefined)).toBe('narrow');
  });

  it('auto on Linux with CJK $LANG resolves to wide (ko / ja / zh substrings)', () => {
    expect(resolveAmbiguousPolicy('auto', 'linux', 'ko_KR.UTF-8')).toBe('wide');
    expect(resolveAmbiguousPolicy('auto', 'linux', 'ja_JP.UTF-8')).toBe('wide');
    expect(resolveAmbiguousPolicy('auto', 'linux', 'zh-Hant')).toBe('wide');
  });

  it('auto on Linux without CJK $LANG resolves to narrow', () => {
    expect(resolveAmbiguousPolicy('auto', 'linux', 'en_US.UTF-8')).toBe('narrow');
    expect(resolveAmbiguousPolicy('auto', 'linux', null)).toBe('narrow');
    expect(resolveAmbiguousPolicy('auto', 'linux', undefined)).toBe('narrow');
  });

  it('auto on other_unix honors the CJK $LANG rule', () => {
    expect(resolveAmbiguousPolicy('auto', 'other_unix', 'ja_JP')).toBe('wide');
    expect(resolveAmbiguousPolicy('auto', 'other_unix', 'fr_FR')).toBe('narrow');
  });

  it('CJK detection is case-insensitive (substring match)', () => {
    // Upper-case locale string: "KO_KR" should still match "ko".
    expect(resolveAmbiguousPolicy('auto', 'linux', 'KO_KR.UTF-8')).toBe('wide');
    expect(resolveAmbiguousPolicy('auto', 'linux', 'ZH-HANT')).toBe('wide');
  });
});

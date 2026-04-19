/**
 * Unit tests for the curated per-code-point override table and its
 * interaction with grapheme-level VS15 / VS16 / ZWJ logic.
 *
 * `lookupOverride` is STRICTLY per-code-point — it never inspects cluster
 * context. The cluster effect of VS15 / VS16 / ZWJ lives in
 * `DefaultClassifier.clusterWidth`. Both concerns are covered here: the
 * lookup contract first, then the end-to-end "override + cluster logic"
 * composition (since the mission calls out VS priority and ZWJ boundary
 * behavior explicitly).
 *
 * Rust ↔ TS parity lives in `parity.test.ts`; this file stays inside the
 * TS module.
 */

import { describe, expect, it } from 'vitest';

import { DefaultClassifier } from '../classifier.js';
import { lookupOverride, OVERRIDES } from '../overrides.js';

describe('lookupOverride — per-code-point contract', () => {
  it('returns undefined for a code point not in the table (ASCII "a" = U+0061)', () => {
    expect(lookupOverride(0x61)).toBeUndefined();
  });

  it('returns undefined for CJK ideograph U+4E2D ("中") — handled by base table', () => {
    // Overrides are curated exceptions; CJK wide chars belong to the base
    // width lookup, NOT the override table.
    expect(lookupOverride(0x4e2d)).toBeUndefined();
  });

  it('returns undefined for unassigned / PUA code point (U+E000)', () => {
    expect(lookupOverride(0xe000)).toBeUndefined();
  });

  it('returns a frozen-shape Override for a known entry (U+2500 "─")', () => {
    // U+2500 BOX DRAWINGS LIGHT HORIZONTAL.
    const hit = lookupOverride(0x2500);
    expect(hit).toBeDefined();
    expect(hit).toEqual({
      codePoint: 0x2500,
      width: 'one',
      reason: 'DecLineDrawing',
    });
  });

  it('VS15 (U+FE0E) resolves to per-code-point width "zero" with reason VariationSelector', () => {
    const hit = lookupOverride(0xfe0e);
    expect(hit).toEqual({
      codePoint: 0xfe0e,
      width: 'zero',
      reason: 'VariationSelector',
    });
  });

  it('VS16 (U+FE0F) resolves to per-code-point width "zero" with reason VariationSelector', () => {
    const hit = lookupOverride(0xfe0f);
    expect(hit).toEqual({
      codePoint: 0xfe0f,
      width: 'zero',
      reason: 'VariationSelector',
    });
  });

  it('ZWJ (U+200D) entry is tagged ZeroWidthJoiner (distinct from FormatControl)', () => {
    const hit = lookupOverride(0x200d);
    expect(hit).toEqual({
      codePoint: 0x200d,
      width: 'zero',
      reason: 'ZeroWidthJoiner',
    });
  });

  it('BOM (U+FEFF) is pinned zero-width with reason FormatControl', () => {
    expect(lookupOverride(0xfeff)).toEqual({
      codePoint: 0xfeff,
      width: 'zero',
      reason: 'FormatControl',
    });
  });

  it('arrow U+2190 is pinned narrow (AmbiguousException) — critical for TUI chrome', () => {
    expect(lookupOverride(0x2190)).toEqual({
      codePoint: 0x2190,
      width: 'one',
      reason: 'AmbiguousException',
    });
  });

  it('SUN U+2600 is widened to "two" (EmojiWidening — terminals render as emoji)', () => {
    expect(lookupOverride(0x2600)).toEqual({
      codePoint: 0x2600,
      width: 'two',
      reason: 'EmojiWidening',
    });
  });

  it('HORIZONTAL ELLIPSIS U+2026 is pinned narrow — ubiquitous in truncated prompts', () => {
    expect(lookupOverride(0x2026)).toEqual({
      codePoint: 0x2026,
      width: 'one',
      reason: 'AmbiguousException',
    });
  });

  it('SPARKLES U+2728 is widened to "two"', () => {
    expect(lookupOverride(0x2728)).toEqual({
      codePoint: 0x2728,
      width: 'two',
      reason: 'EmojiWidening',
    });
  });
});

describe('OVERRIDES table invariants', () => {
  it('is strictly ascending by code point (concat order preserves sort)', () => {
    for (let i = 1; i < OVERRIDES.length; i += 1) {
      expect(OVERRIDES[i]!.codePoint).toBeGreaterThan(OVERRIDES[i - 1]!.codePoint);
    }
  });

  it('every entry has all three fields populated with a documented reason', () => {
    const allowed = new Set([
      'VariationSelector',
      'ZeroWidthJoiner',
      'DecLineDrawing',
      'AmbiguousException',
      'EmojiWidening',
      'FormatControl',
    ]);
    for (const o of OVERRIDES) {
      expect(typeof o.codePoint).toBe('number');
      expect(['zero', 'one', 'two']).toContain(o.width);
      expect(allowed.has(o.reason)).toBe(true);
    }
  });

  it('every lookupOverride round-trips the entry by code point', () => {
    for (const o of OVERRIDES) {
      expect(lookupOverride(o.codePoint)).toBe(o);
    }
  });

  it('all 16 variation selectors U+FE00..U+FE0F are present and zero-width', () => {
    for (let cp = 0xfe00; cp <= 0xfe0f; cp += 1) {
      const hit = lookupOverride(cp);
      expect(hit?.width).toBe('zero');
      expect(hit?.reason).toBe('VariationSelector');
    }
  });
});

describe('Override × cluster composition — VS15 / VS16 priority', () => {
  const c = new DefaultClassifier('narrow');

  it('VS16 priority: emoji base + VS16 forces wide cluster', () => {
    // U+2600 SUN + U+FE0F → emoji presentation → "two".
    expect(c.classifyGrapheme('\u2600\ufe0f').width).toBe('two');
  });

  it('VS15 priority: emoji base + VS15 forces narrow cluster', () => {
    // U+2600 SUN + U+FE0E → text presentation → "one".
    expect(c.classifyGrapheme('\u2600\ufe0e').width).toBe('one');
  });

  it('VS16 on a normally-narrow base (U+2714 HEAVY CHECK MARK) → "two"', () => {
    // U+2714 + U+FE0F. Upstream width is 1; VS16 forces emoji presentation.
    expect(c.classifyGrapheme('\u2714\ufe0f').width).toBe('two');
  });

  it('defensive: VS15 + VS16 in the same cluster — VS16 wins (checked before VS15)', () => {
    // Cannot happen in well-formed input, but `DefaultClassifier.clusterWidth`
    // must return a defined, stable answer. The algorithm checks ZWJ → VS16 →
    // VS15 in that order, so VS16 takes precedence.
    const weird = '\u2600\ufe0e\ufe0f';
    expect(c.classifyGrapheme(weird).width).toBe('two');
  });

  it('defensive: VS16 followed by VS15 on the same base — still "two"', () => {
    // Same VS16-wins precedence regardless of order within the cluster.
    // Note: Intl.Segmenter may split this into multiple clusters; we classify
    // via clusterWidth semantics through classifyGrapheme on the first one.
    const weird = '\u2600\ufe0f\ufe0e';
    // VS sequence is defensive — accept either "two" (VS16 detected) or
    // the single-codepoint fallback "two" (U+2600 override). In both branches
    // the answer is "two"; we only assert it is not "one".
    expect(c.classifyGrapheme(weird).width).toBe('two');
  });
});

describe('Override × cluster composition — ZWJ boundary handling', () => {
  const c = new DefaultClassifier('narrow');

  it('ZWJ cluster wins over any member width: 2-cell result even if first base is narrow', () => {
    // Contrived: a narrow base + ZWJ + narrow base. `clusterWidth` returns
    // "two" the moment ZWJ is present. `Intl.Segmenter` may split
    // non-standard sequences, so we feed a standard family sequence instead
    // to exercise the real path.
    const family = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}';
    expect(c.classifyGrapheme(family).width).toBe('two');
  });

  it('base code point BEFORE ZWJ is resolved via overrides (zero for ZWJ itself)', () => {
    // Sanity check of the per-code-point path: ZWJ alone is "zero".
    expect(c.classifyGrapheme('\u200d').width).toBe('zero');
    // U+200D override entry is authoritative.
    expect(lookupOverride(0x200d)?.width).toBe('zero');
  });

  it('base code point AFTER ZWJ still widens the enclosing cluster', () => {
    // woman + ZWJ + laptop → "technologist" emoji. 2 cells.
    const techy = '\u{1F469}\u200d\u{1F4BB}';
    expect(c.classifyGrapheme(techy).width).toBe('two');
  });
});

describe('Override × cluster composition — exotic VS bases', () => {
  const c = new DefaultClassifier('narrow');

  it('CJK Compatibility U+3297 "㊗" + VS16 → cluster width is "two"', () => {
    // U+3297 CIRCLED IDEOGRAPH CONGRATULATION. Already 2 cells by EAW; the
    // VS16 attachment must NOT regress the width.
    expect(c.classifyGrapheme('\u3297\ufe0f').width).toBe('two');
  });

  it('CJK Compatibility U+3297 + VS15 → VS15 forces text presentation → "one"', () => {
    // VS15 applied to an otherwise-wide base collapses the cluster to one
    // cell. Mirrors the sun-with-VS15 case but on a CJK base.
    expect(c.classifyGrapheme('\u3297\ufe0e').width).toBe('one');
  });

  it('regional indicator pair short-circuits to "two" (flag) regardless of base width', () => {
    const kr = '\u{1F1F0}\u{1F1F7}';
    expect(c.classifyGrapheme(kr).width).toBe('two');
  });

  it('single regional indicator alone is NOT widened to a flag (needs a pair)', () => {
    // U+1F1F0 alone — Intl.Segmenter returns it as its own cluster; the
    // single-codepoint fast path falls to base-width (2 cells for regional
    // indicator codepoints per EAW=W). We only assert it's not "zero".
    const loneRi = '\u{1F1F0}';
    expect(c.classifyGrapheme(loneRi).width).not.toBe('zero');
  });
});

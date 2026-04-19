/**
 * TypeScript mirror of `DefaultClassifier` from
 * `crates/quanta-vt-width/src/adapters/default.rs`.
 *
 * Segmentation uses the runtime's built-in `Intl.Segmenter` pinned to
 * `granularity: 'grapheme'`. Per-code-point width comes from `overrides.ts`
 * first, then falls back to the hand-built `base-width-table.ts`.
 *
 * # Contract
 *
 * `classifyGrapheme(s)` MUST agree with the Rust side byte-for-byte on every
 * entry in `width_corpus.txt`. Divergence is a parity-test failure.
 */

import { baseWidthForCodePoint } from './base-width-table.js';
import { lookupOverride } from './overrides.js';
import type { CellWidth, Grapheme, WrapEligibility } from './types.js';

/** Variation Selector 15 — force text-presentation (1 cell) on preceding emoji. */
const VS15 = 0xfe0e;
/** Variation Selector 16 — force emoji-presentation (2 cells) on preceding text. */
const VS16 = 0xfe0f;
/** Zero-Width Joiner — glues emoji into a single cluster. */
const ZWJ = 0x200d;

/** Regional indicator symbols — U+1F1E6 .. U+1F1FF. */
function isRegionalIndicator(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/**
 * Port surface for width classification. The engine and UI talk to
 * width/grapheme via this interface so test doubles can inject a
 * deterministic classifier (e.g. "every grapheme is 1 cell") without
 * touching production code.
 *
 * Mirrors Rust `WidthClassifier` trait.
 */
export interface WidthClassifier {
  /**
   * Classify a single grapheme cluster.
   *
   * `s` SHOULD be exactly one cluster; callers who have a larger string
   * should segment first. Implementations MUST NOT throw on malformed or
   * empty input — they return `{ grapheme: '', width: 'zero' }` as the
   * neutral element.
   */
  classifyGrapheme(s: string): { grapheme: Grapheme; width: CellWidth };

  /**
   * Decide whether `next` can be placed at `col` on a row of width `cols`,
   * given the width of the previous grapheme.
   *
   * Callers pass `prev = 'zero'` at the start of a row.
   */
  wrapEligible(
    prev: CellWidth,
    next: CellWidth,
    col: number,
    cols: number,
  ): WrapEligibility;
}

/**
 * Production classifier. Construct with an already-resolved
 * ambiguous-width policy (`'narrow'` or `'wide'`). The parent caller
 * must resolve `'auto'` via `resolveAmbiguousPolicy` before construction.
 */
export class DefaultClassifier implements WidthClassifier {
  private readonly ambigWide: boolean;
  private readonly segmenter: Intl.Segmenter;

  constructor(policy: 'narrow' | 'wide') {
    this.ambigWide = policy === 'wide';
    this.segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  }

  /**
   * Look up a single code point's width.
   *
   * Lookup order:
   *  1. Curated `overrides` table.
   *  2. Hand-built base-width table (stand-in for `unicode-width`).
   */
  private widthForCodePoint(cp: number): CellWidth {
    const override = lookupOverride(cp);
    if (override !== undefined) return override.width;
    return baseWidthForCodePoint(cp, this.ambigWide);
  }

  /**
   * Cluster-level width: scans the grapheme for VS15/VS16/ZWJ and yields
   * the final cell width. Mirrors Rust `DefaultClassifier::cluster_width`.
   *
   * Algorithm:
   * 1. Empty → `'zero'` (neutral).
   * 2. Single code point → per-code-point width.
   * 3. Multi-code-point cluster:
   *    a. ZWJ present → 2 cells (every ZWJ emoji sequence in UTS #51 has
   *       emoji-presentation members).
   *    b. VS16 present → 2 cells (emoji-presentation override).
   *    c. VS15 present → 1 cell (text-presentation).
   *    d. ≥2 regional indicators → 2 cells (flag).
   *    e. Otherwise: width of the first non-zero-width code point.
   */
  private clusterWidth(cluster: string): CellWidth {
    if (cluster.length === 0) return 'zero';

    // Fast path: single code point cluster. `String.prototype[Symbol.iterator]`
    // iterates by code points; grabbing the first and checking for a second
    // is equivalent to Rust's `chars().next()` + `iter.next().is_none()`.
    const it = cluster[Symbol.iterator]();
    const firstChar = it.next();
    if (firstChar.done === true) return 'zero';
    const secondChar = it.next();

    if (secondChar.done === true) {
      // Lone code point — the override table's zero-widths for VS and ZWJ
      // are authoritative. Do NOT apply cluster-widening rules.
      const firstValue = firstChar.value;
      const cp = firstValue.codePointAt(0);
      if (cp === undefined) return 'zero';
      return this.widthForCodePoint(cp);
    }

    let hasZwj = false;
    let hasVs16 = false;
    let hasVs15 = false;
    let riCount = 0;
    let baseWidth: CellWidth | undefined = undefined;

    for (const ch of cluster) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (cp === ZWJ) hasZwj = true;
      else if (cp === VS15) hasVs15 = true;
      else if (cp === VS16) hasVs16 = true;
      if (isRegionalIndicator(cp)) riCount += 1;
      if (baseWidth === undefined) {
        const w = this.widthForCodePoint(cp);
        if (w !== 'zero') baseWidth = w;
      }
    }

    if (hasZwj) return 'two';
    if (hasVs16) return 'two';
    if (hasVs15) return 'one';
    if (riCount >= 2) return 'two';
    return baseWidth ?? 'zero';
  }

  classifyGrapheme(s: string): { grapheme: Grapheme; width: CellWidth } {
    // Defensive: if callers hand us a multi-grapheme string, segment and
    // classify the FIRST grapheme only. This matches the Rust contract
    // and keeps callers honest during testing.
    if (s.length === 0) return { grapheme: '', width: 'zero' };
    const iter = this.segmenter.segment(s)[Symbol.iterator]();
    const first = iter.next();
    if (first.done === true) return { grapheme: '', width: 'zero' };
    const cluster = first.value.segment;
    const width = this.clusterWidth(cluster);
    return { grapheme: cluster, width };
  }

  /**
   * Segment a string into graphemes, classifying each. Returns an array
   * of `{ grapheme, width }` pairs in order.
   *
   * Mirrors Rust `WidthClassifier::classify_str`.
   */
  classifyStr(s: string): Array<{ grapheme: Grapheme; width: CellWidth }> {
    const out: Array<{ grapheme: Grapheme; width: CellWidth }> = [];
    for (const { segment } of this.segmenter.segment(s)) {
      out.push({ grapheme: segment, width: this.clusterWidth(segment) });
    }
    return out;
  }

  wrapEligible(
    _prev: CellWidth,
    next: CellWidth,
    col: number,
    cols: number,
  ): WrapEligibility {
    // Zero-width attaches to preceding cluster and does not advance.
    if (next === 'zero') return 'no_break_hint';
    const needed = next === 'two' ? 2 : 1;
    const remaining = Math.max(0, cols - col);
    if (needed <= remaining) return 'fits';
    return 'must_wrap';
  }
}

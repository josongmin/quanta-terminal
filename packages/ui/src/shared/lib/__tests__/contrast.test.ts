/**
 * WCAG contrast regression test for shipped token pairs.
 *
 * We assert every text/background pair the UI actually uses meets at least
 * WCAG 2.1 AA (4.5:1 for body, 3:1 for large text / non-text chrome). A bump
 * to AAA is a deliberate choice per pair, documented below.
 *
 * The contrast ratio is computed from the WCAG-defined relative luminance
 * formula — no external dep. Token values are mirrored here from
 * `shared/config/tokens.css`; when a token is changed in CSS, update the
 * value here in the same PR.
 */

import { describe, expect, it } from 'vitest';

/** Relative luminance for an sRGB color per WCAG 2.1. */
function luminance(hex: string): number {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16) / 255;
  const g = parseInt(n.slice(2, 4), 16) / 255;
  const b = parseInt(n.slice(4, 6), 16) / 255;
  const lin = (c: number): number =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two hex colors. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

// Mirror of tokens that end up in text/background roles. Keep in sync with
// packages/ui/src/shared/config/tokens.css.
const TOKENS = {
  bg: '#0B0C10',
  bgElev1: '#111218',
  bgElev2: '#171922',
  fg: '#E6E8EE',
  fgMuted: '#A6ACBA',
  fgFaint: '#747B8D',
  fgOnAccent: '#0B0C10',
  accent: '#5EA0FF',
  success: '#6EE7B7',
  warning: '#F5C451',
  danger: '#FF6B6B',
} as const;

describe('WCAG contrast for shipped token pairs', () => {
  describe('body text (≥ 4.5:1)', () => {
    it('fg on bg', () => {
      expect(contrastRatio(TOKENS.fg, TOKENS.bg)).toBeGreaterThanOrEqual(4.5);
    });
    it('fg on bgElev1', () => {
      expect(contrastRatio(TOKENS.fg, TOKENS.bgElev1)).toBeGreaterThanOrEqual(4.5);
    });
    it('fg on bgElev2', () => {
      expect(contrastRatio(TOKENS.fg, TOKENS.bgElev2)).toBeGreaterThanOrEqual(4.5);
    });
    it('fgMuted on bg', () => {
      expect(contrastRatio(TOKENS.fgMuted, TOKENS.bg)).toBeGreaterThanOrEqual(4.5);
    });
    it('fgMuted on bgElev1', () => {
      expect(contrastRatio(TOKENS.fgMuted, TOKENS.bgElev1)).toBeGreaterThanOrEqual(4.5);
    });
    it('fgFaint on bg meets AA body', () => {
      expect(contrastRatio(TOKENS.fgFaint, TOKENS.bg)).toBeGreaterThanOrEqual(4.5);
    });
  });

  describe('large text / non-text chrome (≥ 3:1)', () => {
    it('accent on bg', () => {
      expect(contrastRatio(TOKENS.accent, TOKENS.bg)).toBeGreaterThanOrEqual(3);
    });
    it('success on bg', () => {
      expect(contrastRatio(TOKENS.success, TOKENS.bg)).toBeGreaterThanOrEqual(3);
    });
    it('warning on bg', () => {
      expect(contrastRatio(TOKENS.warning, TOKENS.bg)).toBeGreaterThanOrEqual(3);
    });
    it('danger on bg', () => {
      expect(contrastRatio(TOKENS.danger, TOKENS.bg)).toBeGreaterThanOrEqual(3);
    });
    it('fgFaint on bgElev1 for hints/labels', () => {
      expect(contrastRatio(TOKENS.fgFaint, TOKENS.bgElev1)).toBeGreaterThanOrEqual(3);
    });
  });

  describe('accent-background surfaces', () => {
    it('fgOnAccent on accent meets AA body (primary button)', () => {
      expect(contrastRatio(TOKENS.fgOnAccent, TOKENS.accent)).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe('contrastRatio()', () => {
  it('computes black/white as 21:1', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
  });
  it('is commutative', () => {
    const a = contrastRatio('#123456', '#ABCDEF');
    const b = contrastRatio('#ABCDEF', '#123456');
    expect(a).toBeCloseTo(b, 5);
  });
  it('returns 1 for identical colors', () => {
    expect(contrastRatio('#555555', '#555555')).toBeCloseTo(1, 5);
  });
});

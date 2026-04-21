/**
 * Font-settings ↔ Canvas2DBackend integration tests.
 *
 * Verifies the backend correctly:
 *   - Honors a family override in the font shorthand (`ctx.font`).
 *   - Uses cell-height from the updated metrics (size changes propagate
 *     through `applyMetrics`).
 *   - Reapplies the shorthand when metrics change so cell dimensions
 *     line up with the new size.
 *
 * We install a fake 2D context because jsdom returns `null` from
 * `getContext('2d')`. The fake records every `font` assignment so we can
 * inspect the exact string the backend produced.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Canvas2DBackend } from '../../../shared/ui/cell-renderer/backend/Canvas2DBackend.js';
import type { CellMetrics } from '../../../shared/ui/cell-renderer/types.js';

const METRICS14: CellMetrics = {
  cellWidthPx: 8,
  cellHeightPx: 16,
  baselineOffsetPx: 12,
  cellWidthCssPx: 8,
  cellHeightCssPx: 16,
};

const METRICS20: CellMetrics = {
  cellWidthPx: 11,
  cellHeightPx: 24,
  baselineOffsetPx: 18,
  cellWidthCssPx: 11,
  cellHeightCssPx: 24,
};

class FakeCtx {
  font = '';
  textBaseline: CanvasTextBaseline = 'alphabetic';
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  fontFeatureSettings = '';
  fillText(): void {}
  clearRect(): void {}
  fillRect(): void {}
}

let origGetContext: typeof HTMLCanvasElement.prototype.getContext;
const ctxs: FakeCtx[] = [];

beforeEach(() => {
  ctxs.length = 0;
  origGetContext = HTMLCanvasElement.prototype.getContext;
  (HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string) => unknown;
  }).getContext = function getContext(id: string) {
    if (id !== '2d') return null;
    const c = new FakeCtx();
    ctxs.push(c);
    return c as unknown as CanvasRenderingContext2D;
  };
});

afterEach(() => {
  (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext =
    origGetContext;
});

describe('Canvas2DBackend font override', () => {
  it('applies the override family in the font shorthand', () => {
    const backend = new Canvas2DBackend();
    const container = document.createElement('div');
    backend.mount({ container, metrics: METRICS14, dpr: 1 });
    // Default: canonical terminal stack, no user-selected family prefix.
    const before = (backend as unknown as { _fontString(): string })._fontString();
    expect(before).toMatch(/JetBrains Mono/);
    // Apply an override — the resulting shorthand must put the user family
    // first, then fall through to the canonical stack for CJK / emoji
    // glyphs that the chosen face is unlikely to cover.
    (
      backend as unknown as {
        _setFontOverride: (o: { family: string | null; features: string | null } | null) => void;
      }
    )._setFontOverride({
      family: "'Fira Code', ui-monospace, monospace",
      features: `'calt' on, 'liga' on`,
    });
    const after = (backend as unknown as { _fontString(): string })._fontString();
    expect(after).toMatch(/'Fira Code'/);
    // Canonical fallback stack still present so wide characters still render.
    expect(after).toMatch(/JetBrains Mono/);
    backend.unmount();
  });

  it('recomputes the font shorthand when metrics change (size update path)', () => {
    const backend = new Canvas2DBackend();
    const container = document.createElement('div');
    backend.mount({ container, metrics: METRICS14, dpr: 1 });
    const fontAt14 = (backend as unknown as { _fontString(): string })._fontString();
    // Canvas font shorthand encodes the glyph size as "${px}px ...".
    // At cell height 16, expected glyph px = round(16 * 0.8) = 13.
    expect(fontAt14).toMatch(/^13px /);
    backend.applyMetrics(METRICS20, 1);
    const fontAt20 = (backend as unknown as { _fontString(): string })._fontString();
    // At cell height 24, expected glyph px = round(24 * 0.8) = 19.
    expect(fontAt20).toMatch(/^19px /);
    expect(fontAt20).not.toEqual(fontAt14);
    backend.unmount();
  });

  it('invalidates the glyph atlas + fires the invalidation hook on override change', () => {
    const backend = new Canvas2DBackend();
    const container = document.createElement('div');
    backend.mount({ container, metrics: METRICS14, dpr: 1 });
    let hookFired = 0;
    (
      backend as unknown as {
        _setInvalidationHook: (hook: (() => void) | null) => void;
      }
    )._setInvalidationHook(() => {
      hookFired += 1;
    });
    (
      backend as unknown as {
        _setFontOverride: (o: { family: string | null; features: string | null } | null) => void;
      }
    )._setFontOverride({
      family: "'Cascadia Code', monospace",
      features: `'calt' off, 'liga' off`,
    });
    expect(hookFired).toBe(1);
    // Repeating the same override is a no-op — the cost of dropping the
    // atlas + scheduling a rAF each time the Zustand store emits (even when
    // the resolved values are unchanged) would show up as per-keystroke
    // jitter, so the backend dedupes.
    (
      backend as unknown as {
        _setFontOverride: (o: { family: string | null; features: string | null } | null) => void;
      }
    )._setFontOverride({
      family: "'Cascadia Code', monospace",
      features: `'calt' off, 'liga' off`,
    });
    expect(hookFired).toBe(1);
    backend.unmount();
  });
});

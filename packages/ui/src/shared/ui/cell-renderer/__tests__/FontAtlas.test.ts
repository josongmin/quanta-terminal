import { describe, it, expect, vi } from 'vitest';
import { FontAtlas, MemoryRasterizer } from '../FontAtlas.js';
import { DEFAULT_METRICS } from '../types.js';

describe('FontAtlas — LRU', () => {
  it('has default capacity 4096', () => {
    const atlas = new FontAtlas(DEFAULT_METRICS);
    expect(atlas.capacity).toBe(4096);
  });

  it('caches a single entry on first get', () => {
    const atlas = new FontAtlas(DEFAULT_METRICS);
    const k = { grapheme: 'A', attrsVariant: 0, dpr: 1 };
    const e = atlas.getOrRaster(k);
    expect(atlas.size()).toBe(1);
    expect(atlas.getOrRaster(k)).toBe(e);
  });

  it('DPR change forces a new entry', () => {
    const atlas = new FontAtlas(DEFAULT_METRICS);
    atlas.getOrRaster({ grapheme: 'A', attrsVariant: 0, dpr: 1 });
    atlas.getOrRaster({ grapheme: 'A', attrsVariant: 0, dpr: 2 });
    expect(atlas.size()).toBe(2);
  });

  it('attr variant change forces a new entry', () => {
    const atlas = new FontAtlas(DEFAULT_METRICS);
    atlas.getOrRaster({ grapheme: 'A', attrsVariant: 0, dpr: 1 });
    atlas.getOrRaster({ grapheme: 'A', attrsVariant: 1, dpr: 1 });
    expect(atlas.size()).toBe(2);
  });

  it('evicts when capacity exceeded (DoD-D-05)', () => {
    const atlas = new FontAtlas(DEFAULT_METRICS, { capacity: 4 });
    for (let i = 0; i < 4; i += 1) {
      atlas.getOrRaster({ grapheme: `g${i}`, attrsVariant: 0, dpr: 1 });
    }
    expect(atlas.size()).toBe(4);
    atlas.getOrRaster({ grapheme: 'g4', attrsVariant: 0, dpr: 1 });
    expect(atlas.size()).toBe(4);
    // Oldest (`g0`) should be evicted.
    expect(atlas.has({ grapheme: 'g0', attrsVariant: 0, dpr: 1 })).toBe(false);
    expect(atlas.has({ grapheme: 'g4', attrsVariant: 0, dpr: 1 })).toBe(true);
  });

  it('LRU touch moves entry to MRU', () => {
    const atlas = new FontAtlas(DEFAULT_METRICS, { capacity: 3 });
    atlas.getOrRaster({ grapheme: 'a', attrsVariant: 0, dpr: 1 });
    atlas.getOrRaster({ grapheme: 'b', attrsVariant: 0, dpr: 1 });
    atlas.getOrRaster({ grapheme: 'c', attrsVariant: 0, dpr: 1 });
    // Touch `a` → b is now oldest.
    atlas.getOrRaster({ grapheme: 'a', attrsVariant: 0, dpr: 1 });
    atlas.getOrRaster({ grapheme: 'd', attrsVariant: 0, dpr: 1 });
    expect(atlas.has({ grapheme: 'b', attrsVariant: 0, dpr: 1 })).toBe(false);
    expect(atlas.has({ grapheme: 'a', attrsVariant: 0, dpr: 1 })).toBe(true);
  });

  it('4097 inserts keep size at 4096', () => {
    const atlas = new FontAtlas(DEFAULT_METRICS);
    for (let i = 0; i < 4097; i += 1) {
      atlas.getOrRaster({ grapheme: `g${i}`, attrsVariant: 0, dpr: 1 });
    }
    expect(atlas.size()).toBe(4096);
    expect(atlas.has({ grapheme: 'g0', attrsVariant: 0, dpr: 1 })).toBe(false);
  });
});

describe('FontAtlas — invalidation hooks', () => {
  it('DPR-change invalidation drops all entries (DoD-D-06)', () => {
    const onInvalidate = vi.fn();
    const atlas = new FontAtlas(DEFAULT_METRICS, { onInvalidate });
    for (let i = 0; i < 10; i += 1) {
      atlas.getOrRaster({ grapheme: `g${i}`, attrsVariant: 0, dpr: 1 });
    }
    atlas.invalidateAll('dpr_change');
    expect(atlas.size()).toBe(0);
    expect(onInvalidate).toHaveBeenCalledWith('dpr_change');
  });

  it('theme-change invalidation triggers callback (DoD-D-07)', () => {
    const onInvalidate = vi.fn();
    const atlas = new FontAtlas(DEFAULT_METRICS, { onInvalidate });
    atlas.getOrRaster({ grapheme: 'A', attrsVariant: 0, dpr: 1 });
    atlas.invalidateAll('theme_change');
    expect(onInvalidate).toHaveBeenCalledWith('theme_change');
    expect(atlas.size()).toBe(0);
  });

  it('font-family-change invalidation (DoD-D-08)', () => {
    const onInvalidate = vi.fn();
    const atlas = new FontAtlas(DEFAULT_METRICS, { onInvalidate });
    atlas.invalidateAll('font_family_change');
    expect(onInvalidate).toHaveBeenCalledWith('font_family_change');
  });

  it('font-load-complete invalidation (DoD-D-09)', () => {
    const onInvalidate = vi.fn();
    const atlas = new FontAtlas(DEFAULT_METRICS, { onInvalidate });
    atlas.getOrRaster({ grapheme: 'A', attrsVariant: 0, dpr: 1 });
    atlas.invalidateAll('font_load_complete');
    expect(onInvalidate).toHaveBeenCalledWith('font_load_complete');
    expect(atlas.size()).toBe(0);
  });

  it('invalidateAll resets the rasterizer cursor', () => {
    const r = new MemoryRasterizer();
    const reset = vi.spyOn(r, 'reset');
    const atlas = new FontAtlas(DEFAULT_METRICS, { rasterizer: r });
    atlas.invalidateAll('dpr_change');
    expect(reset).toHaveBeenCalled();
  });
});

describe('FontAtlas — MemoryRasterizer layout', () => {
  it('wide graphemes produce 2-cell rects', () => {
    const atlas = new FontAtlas(DEFAULT_METRICS);
    const entry = atlas.getOrRaster({ grapheme: '한', attrsVariant: 0, dpr: 1 });
    expect(entry.cellsWide).toBe(2);
    expect(entry.rect.width).toBe(DEFAULT_METRICS.cellWidthPx * 2);
  });

  it('narrow graphemes produce 1-cell rects', () => {
    const atlas = new FontAtlas(DEFAULT_METRICS);
    const entry = atlas.getOrRaster({ grapheme: 'A', attrsVariant: 0, dpr: 1 });
    expect(entry.cellsWide).toBe(1);
  });

  it('applyMetrics does not invalidate', () => {
    const onInvalidate = vi.fn();
    const atlas = new FontAtlas(DEFAULT_METRICS, { onInvalidate });
    atlas.getOrRaster({ grapheme: 'A', attrsVariant: 0, dpr: 1 });
    atlas.applyMetrics({ ...DEFAULT_METRICS, cellWidthPx: 10 });
    expect(onInvalidate).not.toHaveBeenCalled();
    expect(atlas.size()).toBe(1);
  });
});

/**
 * FontAtlas — offscreen glyph rasterizer with LRU eviction and invalidation
 * hooks for DPR / theme / font-family / font-load events.
 *
 * Why an atlas: paint loops want to blit pre-rasterized glyph bitmaps rather
 * than call `ctx.fillText` per cell. The atlas caches a bounded number of
 * (grapheme, attrs_variant, dpr) triples, evicting the least-recently-used
 * entry once capacity is exceeded.
 *
 * jsdom compatibility: the class does not require a real canvas to function;
 * it only pretends to raster (the `rect` returned is computed from the cell
 * metrics + a rolling cursor). That keeps the data-model testable without
 * the `OffscreenCanvas` API. Real rasterization is done via the optional
 * `rasterizer` injected at construction by `Canvas2DBackend`.
 *
 * RFC 0001 §7.5 glyph atlas LRU-cache SHOULD → MUST here (EPIC-D §4.2).
 * Retires RFC §22 #19 (late web-font load → atlas invalidates mid-frame).
 */

import type { CellMetrics, InvalidationReason } from './types.js';

export interface AtlasKey {
  readonly grapheme: string;
  readonly attrsVariant: number;
  readonly dpr: number;
}

export interface AtlasEntry {
  readonly key: AtlasKey;
  /** Rect inside the offscreen surface. */
  readonly rect: { x: number; y: number; width: number; height: number };
  readonly cellsWide: 1 | 2;
  readonly ascent: number;
  readonly descent: number;
  lastAccessTick: number;
}

/**
 * Pluggable rasterizer. The Canvas2DBackend installs a real implementation
 * that draws into an `OffscreenCanvas`; tests inject a no-op rasterizer
 * so the atlas's data model can be exercised without a real canvas.
 */
export interface AtlasRasterizer {
  rasterize(key: AtlasKey, metrics: CellMetrics): {
    rect: { x: number; y: number; width: number; height: number };
    cellsWide: 1 | 2;
    ascent: number;
    descent: number;
  };
  reset(): void;
}

/** Default rasterizer — returns a tiled rect based on a rolling cursor.
 *  Deterministic and dependency-free; used in jsdom and memory-backend. */
export class MemoryRasterizer implements AtlasRasterizer {
  private cursorX = 0;
  private cursorY = 0;
  private rowMax = 0;
  constructor(private readonly sheetWidthPx = 2048) {}

  rasterize(key: AtlasKey, metrics: CellMetrics): {
    rect: { x: number; y: number; width: number; height: number };
    cellsWide: 1 | 2;
    ascent: number;
    descent: number;
  } {
    // Width comes from a cheap heuristic that matches the width SSOT for
    // common ranges. We keep this deliberately conservative — final width
    // is consumed via the wire-side `Cell.cols`, not from the atlas.
    const w = isLikelyWide(key.grapheme) ? 2 : 1;
    const pxW = metrics.cellWidthPx * w;
    const pxH = metrics.cellHeightPx;
    if (this.cursorX + pxW > this.sheetWidthPx) {
      this.cursorX = 0;
      this.cursorY += this.rowMax;
      this.rowMax = 0;
    }
    const rect = { x: this.cursorX, y: this.cursorY, width: pxW, height: pxH };
    this.cursorX += pxW;
    if (pxH > this.rowMax) this.rowMax = pxH;
    return {
      rect,
      cellsWide: w as 1 | 2,
      ascent: metrics.baselineOffsetPx,
      descent: metrics.cellHeightPx - metrics.baselineOffsetPx,
    };
  }

  reset(): void {
    this.cursorX = 0;
    this.cursorY = 0;
    this.rowMax = 0;
  }
}

/** Hand-rolled classifier for the default rasterizer — ONLY for atlas
 *  layout estimation; never consumed by HitTest or Selection. */
function isLikelyWide(g: string): boolean {
  for (const ch of g) {
    const cp = ch.codePointAt(0) ?? 0;
    // CJK ideographs + Hangul + full-width forms + most emoji ranges.
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xa960 && cp <= 0xa97f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1fbff)
    ) {
      return true;
    }
  }
  return false;
}

function atlasKeyHash(k: AtlasKey): string {
  // DPR rounded to 2 decimals so 1.99 vs 2.0 don't keep separate entries.
  return `${k.grapheme}\x00${k.attrsVariant}\x00${k.dpr.toFixed(2)}`;
}

export interface FontAtlasOptions {
  readonly capacity?: number;
  readonly rasterizer?: AtlasRasterizer;
  readonly onInvalidate?: (reason: InvalidationReason) => void;
}

export const DEFAULT_ATLAS_CAPACITY = 4096;

export class FontAtlas {
  readonly capacity: number;
  private readonly rasterizer: AtlasRasterizer;
  private readonly entries = new Map<string, AtlasEntry>();
  private tick = 0;
  private readonly onInvalidate: ((reason: InvalidationReason) => void) | undefined;
  private metrics: CellMetrics;

  constructor(metrics: CellMetrics, opts: FontAtlasOptions = {}) {
    this.metrics = metrics;
    this.capacity = opts.capacity ?? DEFAULT_ATLAS_CAPACITY;
    this.rasterizer = opts.rasterizer ?? new MemoryRasterizer();
    this.onInvalidate = opts.onInvalidate;
  }

  /** Return an existing entry or raster a new one. Always bumps
   *  `lastAccessTick` so repeat gets are MRU. */
  getOrRaster(key: AtlasKey): AtlasEntry {
    this.tick += 1;
    const hash = atlasKeyHash(key);
    const existing = this.entries.get(hash);
    if (existing) {
      existing.lastAccessTick = this.tick;
      // Refresh MRU: Map preserves insertion order, so delete + re-set.
      this.entries.delete(hash);
      this.entries.set(hash, existing);
      return existing;
    }
    const raster = this.rasterizer.rasterize(key, this.metrics);
    const entry: AtlasEntry = {
      key,
      rect: raster.rect,
      cellsWide: raster.cellsWide,
      ascent: raster.ascent,
      descent: raster.descent,
      lastAccessTick: this.tick,
    };
    this.entries.set(hash, entry);
    if (this.entries.size > this.capacity) this.evictOne();
    return entry;
  }

  /** True if key is cached — does not bump MRU. */
  has(key: AtlasKey): boolean {
    return this.entries.has(atlasKeyHash(key));
  }

  /** Number of entries currently cached. */
  size(): number {
    return this.entries.size;
  }

  /** Apply new metrics — does NOT invalidate (DPR change caller should
   *  follow up with `invalidateAll`). */
  applyMetrics(m: CellMetrics): void {
    this.metrics = m;
  }

  /** Drop all entries. Invalidation reason forwarded to listeners + resets
   *  the underlying rasterizer cursor. */
  invalidateAll(reason: InvalidationReason): void {
    this.entries.clear();
    this.rasterizer.reset();
    this.onInvalidate?.(reason);
  }

  /** @internal for tests. */
  oldestKey(): string | null {
    const iter = this.entries.keys().next();
    return iter.done ? null : iter.value;
  }

  private evictOne(): void {
    // The map is MRU-ordered (we re-insert on hit); the oldest key is the
    // first insertion iteration value.
    const oldest = this.entries.keys().next();
    if (!oldest.done) this.entries.delete(oldest.value);
  }
}

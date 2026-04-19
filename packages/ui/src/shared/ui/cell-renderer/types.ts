/**
 * Shared types for the cell-renderer layer (EPIC-D).
 *
 * Every type here is deliberately backend-agnostic: the same shapes feed
 * Canvas2DBackend, MemoryBackend, and any future WebGL/WebGPU backend that
 * ships under RFC 0002. Nothing in this file may assume Canvas2D APIs.
 *
 * RFC 0001 refs:
 *   - §7.5 `cell-renderer (Canvas2D → WebGL)` architecture block.
 *   - §11 selection/copy/search semantics (normalized into `CopyOptions` and
 *     `SelectionAnchor`).
 *   - §12 renderer backend contract (see `backend/BackendContract.ts`).
 *
 * Invariants held here:
 *   - I-3 (Grid is truth): the renderer mirrors state; no semantic types
 *     defined here reinterpret cells. Packed-cell bit layout is a layout
 *     optimization, not a semantic rewrite.
 *   - I-4 (Semantic width wins): rects consumed by `HitTest` honor
 *     `cellsWide` returned from the width SSOT (`@ui/shared/lib/width`);
 *     nothing here re-derives width from code-point ranges.
 */

/** Device-pixel rect. Backend-agnostic. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Cell metrics — authoritative cell dimensions for the current paint. */
export interface CellMetrics {
  /** Device pixels per cell column (accounts for DPR). */
  readonly cellWidthPx: number;
  /** Device pixels per cell row (line-height). */
  readonly cellHeightPx: number;
  /** Baseline offset inside the cell for glyph placement. */
  readonly baselineOffsetPx: number;
  /** CSS pixels per cell column (post-DPR), used by hit-test. */
  readonly cellWidthCssPx: number;
  /** CSS pixels per cell row. */
  readonly cellHeightCssPx: number;
}

/** Default cell metrics for tests / jsdom where font metrics are unavailable. */
export const DEFAULT_METRICS: CellMetrics = Object.freeze({
  cellWidthPx: 8,
  cellHeightPx: 16,
  baselineOffsetPx: 12,
  cellWidthCssPx: 8,
  cellHeightCssPx: 16,
});

/** Result of `HitTest.screenToCell`. Null hyperlink id means "no hyperlink". */
export interface ScreenHit {
  readonly row: number;
  readonly col: number;
  readonly hyperlinkId: number | null;
}

/** IME overlay anchor — consumed by EPIC-E's `PreeditOverlay`. */
export interface IMEOverlayAnchor {
  readonly row: number;
  readonly col: number;
  readonly metrics: CellMetrics;
}

/** Handle returned from `backend.mountOverlay`. Opaque to callers. */
export interface OverlayHandle {
  readonly id: symbol;
}

/** Options controlling `SelectionManager.copy` output shape. ADR 0016 §5. */
export interface CopyOptions {
  /** Preserve trailing whitespace per line (held-Alt power-user knob). */
  readonly preserveTrailingWhitespace: boolean;
  /** Convert tabs to N-char stops. `null` = preserve literal tab character. */
  readonly tabStops: number | null;
}

export const DEFAULT_COPY_OPTIONS: CopyOptions = Object.freeze({
  preserveTrailingWhitespace: false,
  tabStops: null,
});

/** Selection mode — 4 modes per ADR 0016 §4. */
export type SelectionMode = 'char' | 'word' | 'line' | 'block';

/** A cell-grid anchor. Stored as absolute row indices. */
export interface SelectionAnchor {
  readonly row: number;
  readonly col: number;
}

/** Active selection state. ADR 0016 §1. */
export interface SelectionState {
  readonly start: SelectionAnchor;
  readonly end: SelectionAnchor;
  readonly mode: SelectionMode;
}

/** A match returned by `Search.find`. */
export interface SearchMatch {
  readonly anchors: { readonly start: SelectionAnchor; readonly end: SelectionAnchor };
  readonly logicalOffset: number;
  readonly length: number;
}

/** Options for `Search.find`. ADR 0016 §7. */
export interface SearchOptions {
  readonly query: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly respectBufferScope: boolean;
}

/** Unsubscribe thunk returned by observable APIs. */
export type Unsubscribe = () => void;

/** Reason supplied to `FontAtlas.invalidateAll`. */
export type InvalidationReason =
  | 'dpr_change'
  | 'theme_change'
  | 'font_family_change'
  | 'font_load_complete';

/**
 * Platform modifier for block-mode (rectangular) selection. Opt on macOS,
 * Alt elsewhere (ADR 0016 accepted §2).
 */
export type Platform = 'macos' | 'linux' | 'windows' | 'other';

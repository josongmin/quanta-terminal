/**
 * Renderer backend contract — RFC 0001 §12, EPIC-D §4.1.
 *
 * The backend is a replaceable plugin behind this interface. Every renderer
 * backend (`Canvas2DBackend` today; `WebGLBackend` under RFC 0002) MUST
 * implement every method. `MemoryBackend` exists to prove backend-agnosticism
 * in tests.
 *
 * Contract invariants:
 *   - I-3: backends mirror + display; they MUST NOT reinterpret terminal
 *     semantics. `applyMode` is consumed as authoritative.
 *   - I-4: backends consume the grid's width-SSOT width; they MUST NOT
 *     recompute width from code-point ranges (`measureText` uses the
 *     already-classified grapheme stream).
 */

import type {
  CursorState,
  Row,
  TerminalModeState,
} from '../../../lib/grid-mirror/types.js';
import type { DamageSet } from '../DamageSet.js';
import type {
  CellMetrics,
  IMEOverlayAnchor,
  OverlayHandle,
  Rect,
  ScreenHit,
} from '../types.js';

/**
 * Context passed once at mount time. The backend may cache this for the
 * lifetime of the mount; subsequent metric changes arrive via `applyMetrics`.
 */
export interface MountContext {
  /** Host element the backend paints into. Backend MAY add sub-elements; MUST
   *  remove them on `unmount()`. */
  readonly container: HTMLElement;
  /** Cell metrics at mount time. */
  readonly metrics: CellMetrics;
  /** DPR at mount time. */
  readonly dpr: number;
}

/** Result of `measureText`. Matches the width-SSOT cells. */
export interface TextMeasurement {
  readonly widthPx: number;
  readonly cellsWide: number;
}

/**
 * Renderer backend contract. All methods are synchronous unless documented
 * otherwise. Backends MUST NOT retain references to `Row` / `CursorState` /
 * `TerminalModeState` past the call — the mirror is the source of truth.
 */
export interface BackendContract {
  /** Attach to the DOM. Called once per lifecycle. Idempotent if `unmount()`
   *  has been called. */
  mount(ctx: MountContext): void;

  /**
   * Apply a full snapshot. Backend MUST clear any prior paint state and
   * re-raster from scratch. Called on initial mount, reseed, resize, and
   * backend swap.
   */
  applyGridSnapshot(
    rows: readonly Row[],
    cursor: CursorState | null,
    mode: TerminalModeState,
  ): void;

  /**
   * Apply an incremental delta. `dirtyRows` is the set of row indices that
   * changed; backend MUST repaint only those rows.
   */
  applyGridDelta(rows: readonly Row[], dirtyRows: DamageSet): void;

  /** Cursor-only update. No full-row reblit. */
  applyCursor(cursor: CursorState | null): void;

  /** Mode-state update. Used for cursor shape hints; never for semantic
   *  interpretation. */
  applyMode(mode: TerminalModeState): void;

  /** Metrics update. Backend MUST invalidate any caches keyed by metrics. */
  applyMetrics(metrics: CellMetrics, dpr: number): void;

  /** Signal an rAF boundary. Backend may flush pending damage. No-op if
   *  nothing is dirty. */
  requestDamageFlush(): void;

  /**
   * Measure text at current metrics. Width must match the width SSOT. The
   * backend MAY NOT override; it walks the grapheme stream and sums cells.
   */
  measureText(text: string, attrsVariant: number): TextMeasurement;

  /** Mount an IME preedit overlay anchored to a cell. */
  mountOverlay(anchor: IMEOverlayAnchor, text: string): OverlayHandle;

  /** Update the text in an existing overlay. */
  updateOverlay(handle: OverlayHandle, text: string): void;

  /** Remove the overlay. Idempotent. */
  unmountOverlay(handle: OverlayHandle): void;

  /**
   * Reverse-map pixel coordinate to cell. Wide-char right-half maps to the
   * left-half anchor (width SSOT). Returns null for out-of-grid.
   */
  screenToCell(xCssPx: number, yCssPx: number): ScreenHit | null;

  /** Pixel rect of a cell. Inverse of `screenToCell` within ½ cell. */
  cellToScreen(row: number, col: number): Rect;

  /** Detach from the DOM. MUST remove all sub-elements and release
   *  resources. */
  unmount(): void;
}

/**
 * Simple browser/jsdom-style `TextMetrics` shape mirrored for the
 * top-of-file task brief signature. Renderer-internal callers use
 * `TextMeasurement`; this is retained only for API symmetry with the brief.
 */
export type BackendTextMetrics = TextMeasurement;

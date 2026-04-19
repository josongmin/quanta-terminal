# EPIC-D Design — Canvas Renderer + Selection

- **Status**: Design-ahead (Gear 3). Freezes renderer backend contract (RFC 0001 §12) and selection/copy/search semantics (ADR 0016).
- **Date**: 2026-04-19
- **Related**: RFC 0001 §2 (invariants I-3 grid-is-the-truth, I-4 semantic-width-wins, I-5 delta-from-day-one, I-8 no-black-screen), §3.4 (paint truth), §7.5 (architecture overview), §11 (selection/copy/search), §12 (renderer backend contract), §13.8 (selection/copy acceptance), §13.11 (side-by-side diff — consumed by EPIC-H), §13.13 (performance budget decomposition), §13.14 (telemetry counters), §14.1 (SHOULD renderer items), §22 #19 (web-font late load), §22 #20 (wrap-row selection copy), ADR 0015 (width SSOT — consumed), ADR 0016 (selection/search/copy — moved to Accepted by this epic), ADR 0017 (reducer ordering — consumed via EPIC-C `GridMirror`), ADR 0018 (IME state machine — overlay slot consumed by EPIC-E), EPIC-A (TS width mirror), EPIC-C (`GridMirror` API §4.1), EPIC-E (`PreeditOverlay` consumer), EPIC-J (telemetry counter schema), EPIC-K (`check-paint-no-width-override` grep rule).
- **Blocks**: `packages/ui/src/shared/ui/cell-renderer/**` and `packages/ui/src/widgets/terminal-canvas/**` implementation agents (Phase 2).

One-paragraph read: EPIC-C gives us an authoritative `GridMirror` with dirty-row deltas. EPIC-D turns that into pixels on a canvas, hit-testable mouse coordinates, selection highlights, copy-to-clipboard that round-trips grapheme-safe, and in-viewport search — all behind a **backend-agnostic renderer contract** so WebGL (RFC 0002) can drop in without a UX rewrite. The data model is Canvas2D-driven but never Canvas2D-coupled; every data-affecting operation (hit-test, selection, copy, search) lives in a layer that doesn't touch a `CanvasRenderingContext2D`. IME overlay is a painting primitive exposed for EPIC-E's state machine to consume. This document freezes the types + files + tests the implementation agent follows.

---

## 1. Summary

- **Goal**: Ship the Canvas2D cell renderer + hit-test / selection / search / copy per ADR 0016, behind the renderer-backend contract (RFC §12). De-risk the data model before WebGL (RFC 0002) lands.
- **Phase**: 2 (per RFC §17 migration plan, per EPIC plan README).
- **Duration**: 2 weeks.
- **Dependencies**: EPIC-C (wire protocol + `GridMirror` frozen API) must ship spec-freeze before EPIC-D code starts. EPIC-A (TS width mirror) must be green on parity corpus so hit-test + selection use the single width source of truth.
- **Owner**: Renderer / UX squad.

### 1.1 Contracts frozen by this epic

- `BackendContract` interface (§4.1) — the full set of methods a renderer backend MUST implement. Locks the Canvas2D path and the WebGL follow-up (RFC 0002) to the same surface.
- `SelectionAnchor` / `Selection` TS shape — matches ADR 0016 §1. No wire footprint; this is UI-local.
- Copy-normalization rules — locked per ADR 0016 §5 (wrap-joined continuation, grapheme safety, trailing-half-cell strip).
- Hit-test return shape: `ScreenHit { row, col, hyperlink_id? } | null`.
- Search result shape: `Match { anchors: SelectionAnchor[]; logicalOffset: number }`.
- IME overlay slot contract (consumed by EPIC-E `PreeditOverlay`).

### 1.2 Contracts consumed (not frozen here)

- EPIC-A `CellWidth`, `Grapheme`, `wrap_eligible` (TS mirror).
- EPIC-C `GridMirror` public API (§4.1 of EPIC-C design): `applySnapshot`, `applyDelta`, `applyCursor`, `applyMode`, `apply`, `getRow`, `getCursor`, `getMode`, `snapshotMode`, `getDimensions`, `getAppliedSequence`, `getAppliedEpoch`, `onChange`.
- EPIC-C `GridMirrorOptions.onChange` observer semantics (fires once per synchronized-update window, or once per delta outside windows).
- ADR 0016 §7 search contract (regex toggle, continuation-aware, alt-buffer scoping).

---

## 2. Background

### 2.1 Why Canvas2D first

Canvas2D lets us validate the data model (atlas keying, damage coalescing, hit-test inverse, selection normalization, copy-wrap-join, search logical-view construction) on a stable, debuggable substrate before moving to WebGL. A WebGL path committed first would bury bugs in GPU state and make selection / copy / search regressions look like shader issues.

### 2.2 What RFC §7.5 commits to

> "`cell-renderer (Canvas2D → WebGL)` — backend-agnostic contract."

The backend is a replaceable plugin behind a single interface. Everything else — `CellBuffer`, `FontAtlas`, `Renderer`, `HitTest`, `Selection`, `Search` — is backend-independent. The Canvas2D implementation is a reference implementation proving the contract.

### 2.3 What RFC §11 commits to

Selection anchors are cell-based (never DOM-ranges), grapheme-safe, wide-char-half-normalized. Search operates on a logical text view that joins continuation rows. Hyperlinks are first-class via OSC 8 (id-addressed in the wire; resolved via `HyperlinkTable` from EPIC-C).

### 2.4 What RFC §12 commits to

Renderer consumes only mirrored cell state, damage metadata, and cursor/overlay events — it MAY NOT own semantic terminal state. Switching backends MUST NOT change selection/copy/search semantics. A second backend stub exists in tests to prove the contract boundary.

### 2.5 What RFC §13.11 commits to

Side-by-side (`data-renderer="canvas"|"xterm"`) is implemented in EPIC-H. EPIC-D's job is to **ship a Canvas2D path that matches the xterm path cell-for-cell under identical PTY streams.** The diff surface is EPIC-H's concern; EPIC-D supplies the canvas half and a `MemoryBackend` that trivially matches (no-op paint) for regression triage.

---

## 3. Scope

### 3.1 Files

All new unless marked `updated`. Tests live alongside their subject in `__tests__/`.

| File | Purpose |
|------|---------|
| `packages/ui/src/shared/ui/cell-renderer/CellBuffer.ts` | Subscribes to `GridMirror.onChange`. Holds a packed `Uint32Array` of cell tuples. Exposes row iteration for the `Renderer` and cell lookup for `HitTest`. |
| `packages/ui/src/shared/ui/cell-renderer/FontAtlas.ts` | Offscreen-canvas glyph rasterizer. LRU capacity 4096 keyed by `(grapheme, attrs_variant, dpr)`. Invalidation triggers in §4.2. |
| `packages/ui/src/shared/ui/cell-renderer/Renderer.ts` | rAF loop. Reads `DamageSet`, composes 3 layers (grid cells, cursor, overlay). Calls into the active `BackendContract` implementation. |
| `packages/ui/src/shared/ui/cell-renderer/DamageSet.ts` | Sparse row/col set with coalescing. Multiple `GridDelta`s within one rAF merge into a single paint pass. |
| `packages/ui/src/shared/ui/cell-renderer/HitTest.ts` | `screenToCell(x, y)` + `cellToScreen(row, col)`. Honors width SSOT for wide chars (left + right halves map to left anchor). |
| `packages/ui/src/shared/ui/cell-renderer/Selection.ts` | `SelectionAnchor`, mode (`char`/`word`/`line`/`block`), extend API, normalization, copy rendering per ADR 0016 §5. |
| `packages/ui/src/shared/ui/cell-renderer/Search.ts` | Logical-text-view construction (wrap-joined), substring + regex match, result cycling, viewport scroll helpers. |
| `packages/ui/src/shared/ui/cell-renderer/backend/BackendContract.ts` | Interface defining the full set of methods any renderer backend implements. §4.1. |
| `packages/ui/src/shared/ui/cell-renderer/backend/Canvas2DBackend.ts` | Canvas2D implementation. |
| `packages/ui/src/shared/ui/cell-renderer/backend/MemoryBackend.ts` | No-op backend used by the contract parity suite. Proves backend-agnosticism. |
| `packages/ui/src/shared/ui/cell-renderer/types.ts` | Shared types (`PackedCell`, `Rect`, `ScreenHit`, `CopyOptions`, `SearchMatch`, `SearchOptions`, `IMEOverlayAnchor`). |
| `packages/ui/src/shared/ui/cell-renderer/index.ts` | Barrel export. |
| `packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx` | React hosting widget. Mounts the backend + binds lifecycle. Props: `mirror: GridMirror`, `backend: 'canvas' \| 'memory'`, `onHyperlinkClick`, `onCopyRequest`. |
| `packages/ui/src/widgets/terminal-canvas/terminal-canvas.module.css` | Layout: canvas layer, cursor layer, overlay layer (IME + selection highlight), block-chrome attachment points. |
| `packages/ui/src/widgets/terminal-canvas/index.ts` | Barrel export. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/TerminalCanvas.mount.test.tsx` | Mount + unmount + leak test. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/backend-contract.test.ts` | Parity suite run against both `Canvas2DBackend` and `MemoryBackend`. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/font-atlas.test.ts` | LRU + invalidation tests. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/cell-buffer.test.ts` | Pack/unpack roundtrip + `onChange` subscription leak test. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/damage-set.test.ts` | Coalescing within a rAF; dirty flush invariants. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/hit-test.test.ts` | `screenToCell` ∘ `cellToScreen` identity property tests; wide-char half-mapping. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/selection.test.ts` | 20+ scenarios across 4 modes. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/copy-normalization.test.ts` | 15+ scenarios: wide chars, ZWJ, wrap, tabs, trailing spaces. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/search.test.ts` | Substring + regex, wrap-aware, highlight lifecycle, cycling. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/hyperlink-click.test.ts` | Cmd+click → `onHyperlinkClick` fires with resolved id + URI. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/renderer-rAF.test.ts` | rAF-driven paint; damage coalescing; no paint when no damage. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/visual-regression.test.ts` | Fixed snapshot + delta stream → pixel-perfect PNG comparison. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/ime-overlay.test.ts` | Mount/update/unmount the overlay slot. |
| `packages/ui/src/widgets/terminal-canvas/__tests__/perf-budget.test.ts` | Per-stage budget harness (raster / hit-test / copy). |
| `packages/ui/src/widgets/terminal-canvas/__tests__/fixtures/**` | Golden PNGs, golden PTY-derived snapshots + delta streams, selection+copy expected-strings JSON. |
| `docs/adr/0016-selection-search-copy-semantics.md` | **Updated**: skeleton → Accepted. Resolve Open Questions per §4.5 here. |

### 3.2 Out of scope

- **WebGL / WebGPU backend** — RFC 0002 follow-up. EPIC-D proves the contract so RFC 0002 is a drop-in.
- **Input handling** — EPIC-E. `TerminalCanvas` exposes `onKeyDown`, `onPointerEvent`, `onCompositionEvent` props but does NOT implement encoders or the IME state machine. The `PreeditOverlay` component that renders composition text is owned by EPIC-E; this epic only exposes the overlay **slot** (z-layer + anchor API).
- **Alt-screen chrome swap UX** — EPIC-H. `TerminalCanvas` surfaces `onBufferKindChange(kind)` so block chrome can collapse/expand, but the animation + layout choreography belong to `BlockList` / `BlockCard`.
- **xterm removal** — EPIC-I.
- **Persistent scrollback beyond mirror state** — out of v1 per RFC §15.

---

## 4. Design

### 4.1 Backend contract (RFC §12)

Full TS interface. Every backend MUST implement every method. Both `Canvas2DBackend` and `MemoryBackend` are exercised by the same parity suite.

```ts
// packages/ui/src/shared/ui/cell-renderer/backend/BackendContract.ts

import type { Cursor, Row, TerminalModeState } from '@quanta/grid-mirror';
import type { DamageSet } from '../DamageSet';
import type { IMEOverlayAnchor, ScreenHit, Rect } from '../types';

/**
 * Mount context passed once at construction time.
 * The backend is free to cache this; it is valid until `unmount()` returns.
 */
export interface MountContext {
  /** Host DOM element the backend paints into. Backend may add sub-elements but MUST remove them on unmount. */
  container: HTMLElement;
  /** Logical cell metrics. Updated via applyMetrics() when DPR/font changes. */
  metrics: CellMetrics;
  /** DPR at mount time. Backend listens for changes via applyMetrics(). */
  dpr: number;
}

/**
 * Cell metrics — computed from font metrics + width SSOT (EPIC-A).
 * Backend MAY NOT recompute; it consumes this as authoritative.
 */
export interface CellMetrics {
  /** Device pixels per cell column (accounts for DPR). */
  cellWidthPx: number;
  /** Device pixels per cell row. */
  cellHeightPx: number;
  /** Baseline offset inside the cell, for glyph placement. */
  baselineOffsetPx: number;
  /** CSS pixels per cell (post-DPR division), used by hit-test. */
  cellWidthCssPx: number;
  cellHeightCssPx: number;
}

/**
 * Renderer backend contract. All methods are synchronous unless documented otherwise.
 * Backends MUST NOT retain references to `Row` / `Cursor` / `TerminalModeState` objects
 * past the call; the GridMirror state is the only source of truth.
 */
export interface BackendContract {
  /** Attach to the DOM. Called once per backend lifecycle. */
  mount(ctx: MountContext): void;

  /**
   * Apply a full snapshot. Backend MUST clear any prior paint state and
   * re-raster from scratch. Called on initial mount, reseed, resize, and
   * backend swap.
   */
  applyGridSnapshot(rows: readonly Row[], cursor: Cursor | null, mode: TerminalModeState): void;

  /**
   * Apply an incremental delta. `dirtyRows` is the set of row indices
   * that changed; backend MUST repaint only those rows (plus any
   * decoration overlap — selection, cursor).
   */
  applyGridDelta(rows: readonly Row[], dirtyRows: DamageSet): void;

  /**
   * Apply a cursor update. Backend repaints the cursor layer only
   * (no full-row reblit).
   */
  applyCursor(cursor: Cursor | null): void;

  /**
   * Apply a mode-state update. Backend uses this for: buffer-kind
   * coloring hint, block/bar cursor shape, cursor-blink enable.
   * Backend MAY NOT derive terminal semantics from this.
   */
  applyMode(mode: TerminalModeState): void;

  /**
   * Apply new metrics (DPR change, font-load completion, theme swap).
   * Backend MUST invalidate any caches keyed by metrics.
   */
  applyMetrics(metrics: CellMetrics, dpr: number): void;

  /**
   * Signal that an rAF tick occurred and the backend may flush damage.
   * Renderer calls once per frame. If no dirty state, backend is a no-op.
   */
  requestDamageFlush(): void;

  /**
   * Measure a text string at current metrics. Used for layout decisions
   * (hyperlink hit-test, IME overlay width). Must match the width SSOT
   * via grapheme segmentation; backend MAY NOT override.
   */
  measureText(text: string, attrsVariant: number): { widthPx: number; cellsWide: number };

  /**
   * Mount an IME preedit overlay anchored to a cell. Returns a handle
   * the caller uses for update/unmount. Consumed by EPIC-E's PreeditOverlay.
   */
  mountOverlay(anchor: IMEOverlayAnchor, text: string): OverlayHandle;

  /** Update the text in an existing overlay without re-anchoring. */
  updateOverlay(handle: OverlayHandle, text: string): void;

  /** Remove the overlay. Idempotent. */
  unmountOverlay(handle: OverlayHandle): void;

  /**
   * Return the cell at a screen coordinate, or null if outside the grid.
   * Wide-char halves MAP TO THE LEFT-HALF anchor (width SSOT rule).
   * Returns hyperlink_id if the cell references a hyperlink.
   */
  screenToCell(xCssPx: number, yCssPx: number): ScreenHit | null;

  /** Return the pixel rect of a cell. Inverse of screenToCell within half a cell. */
  cellToScreen(row: number, col: number): Rect;

  /** Detach from the DOM. Backend MUST remove all sub-elements and release resources. */
  unmount(): void;
}

export interface OverlayHandle {
  readonly id: symbol;
}
```

**Parity suite**: `backend-contract.test.ts` defines ~40 invariant cases and runs them against each backend instance. Canvas2DBackend must pass all; MemoryBackend passes all (its paint methods are no-ops but hit-test / measure / overlay all return correct data).

### 4.2 FontAtlas

```ts
// packages/ui/src/shared/ui/cell-renderer/FontAtlas.ts

export interface AtlasKey {
  /** Full grapheme cluster as UTF-8 string; may be multi-codepoint (ZWJ, VS16). */
  grapheme: string;
  /**
   * Packed attrs variant. Bits: bold, italic, underline, strike, fg-palette-kind, bg-palette-kind.
   * Same variant produces the same raster; variant changes force re-raster.
   */
  attrsVariant: number;
  /** Device pixel ratio rounded to 2 decimals. DPR change → full atlas invalidation. */
  dpr: number;
}

export interface AtlasEntry {
  /** Sub-rect inside the offscreen canvas holding the rasterized glyph. */
  rect: Rect;
  /** Width in cells (1 or 2). From EPIC-A width SSOT — the atlas does NOT measure width. */
  cellsWide: 1 | 2;
  /** Ascent/descent offsets for positioning inside the cell box. */
  ascent: number;
  descent: number;
  /** Access-time for LRU eviction. */
  lastAccessTick: number;
}

export class FontAtlas {
  /** Hard cap. Beyond this, LRU eviction runs. */
  readonly capacity = 4096;

  constructor(private readonly metrics: CellMetrics, private readonly fontFamily: string) {}

  /** Returns an existing entry or rasters + inserts a new one. */
  getOrRaster(key: AtlasKey): AtlasEntry;

  /**
   * Invalidate the whole atlas. Called on:
   *   - DPR change (window.devicePixelRatio listener)
   *   - Theme change (color palette affects palette8/256 pre-multiplied rasters)
   *   - Font-family change (user setting)
   *   - `document.fonts.ready` resolves with a newly-loaded face (web-font late load — RFC §22 #19)
   */
  invalidateAll(reason: InvalidationReason): void;

  /** LRU eviction — called internally when capacity is exceeded. */
  private evictOne(): void;

  /** Exposed for tests. */
  size(): number;
  has(key: AtlasKey): boolean;
}

export type InvalidationReason = 'dpr_change' | 'theme_change' | 'font_family_change' | 'font_load_complete';
```

**Storage**: one offscreen `OffscreenCanvas` (or `<canvas>` pre-DOM-attach fallback for environments without `OffscreenCanvas`). Glyphs tile left-to-right, top-to-bottom; rect indexed by a hash of `AtlasKey` into a `Map<number, AtlasEntry>`. When capacity exceeded, evict the entry with the smallest `lastAccessTick` and reclaim its rect for the next raster.

**Rasterization**: `ctx.fillText(grapheme, x, y + baselineOffset)` with pre-computed font shorthand `${italic?'italic ':''}${bold?'bold ':''}${px}px ${family}`. Bold/italic/underline are **synthesized** when the font face lacks the variant (per CSS standard `font-synthesis`). Underline and strikethrough are separate stroke-draws composited on top of the glyph.

### 4.3 CellBuffer

```ts
// packages/ui/src/shared/ui/cell-renderer/CellBuffer.ts

/**
 * PackedCell u32 layout (MSB-first):
 *  bit 31..24 (8 bits) — attrs bitflags (bold, italic, underline, blink, inverse, strike, faint, double-under)
 *  bit 23..18 (6 bits) — fg palette index OR top-6 bits of truecolor RGB565 approximation
 *  bit 17..12 (6 bits) — bg palette index OR top-6 bits of truecolor RGB565 approximation
 *  bit 11..10 (2 bits) — fg color kind (0 default, 1 p8, 2 p256, 3 truecolor)
 *  bit  9..8  (2 bits) — bg color kind
 *  bit  7..0  (8 bits) — grapheme-table id (index into CellBuffer.graphemeTable)
 *
 * Truecolor RGB is stored in a side-table keyed by (row, col) when kind==3;
 * the top-6 bits are an approximation for fast equality check.
 * This packing covers 99% of cells in one u32; the rest live in a sparse
 * `trueColorMap: Map<cellIndex, {fg:u32, bg:u32}>` and an
 * `extMap: Map<cellIndex, {hyperlinkId:number, underlineColor?:number}>`.
 */
export type PackedCell = number; // u32

export class CellBuffer {
  private buf: Uint32Array;
  private graphemeTable: string[]; // id → grapheme cluster; id 0 = " " blank
  private graphemeIndex: Map<string, number>; // grapheme → id
  private trueColorMap: Map<number, { fg: number; bg: number }>;
  private extMap: Map<number, { hyperlinkId?: number; underlineColor?: number }>;
  private dirtyRows: DamageSet;
  private rows: number;
  private cols: number;
  private subscription?: () => void;

  /** Mount a mirror subscription. Auto-unsubscribes when dispose() is called. */
  constructor(mirror: GridMirror) {
    this.subscription = mirror.onChange(this.handleMirrorChange);
  }

  /** Handler for GridMirror.onChange. Extracts dirty rows + updates packed store. */
  private handleMirrorChange = (event: { dirtyRows: number[]; rows: Row[] }) => { /* ... */ };

  /** Return a read-only view into a row's packed cells. Used by Renderer. */
  getRowCells(row: number): { packed: Uint32Array; trueColors: Map<number, TrueColor>; ext: Map<number, CellExt> };

  /** Read a single cell, fully unpacked. Used by HitTest + copy. */
  getCell(row: number, col: number): { grapheme: string; width: CellWidth; fg: Color; bg: Color; attrs: AttrFlags; hyperlink?: HyperlinkRef };

  /** Drain dirty rows, returning the damage set. Called by Renderer each rAF. */
  drainDamage(): DamageSet;

  /** Unsubscribe; release memory. Called on unmount. */
  dispose(): void;
}
```

**Why packed**: 1 u32 per cell × 120×40 cells = 19 200 B contiguous. Row iteration walks cache-friendly memory. Paint loops do 1 `Map.get(id)` per unique grapheme id, not per cell.

**Subscribes** to `GridMirror.onChange` once at construction; stores unsubscribe thunk; `dispose()` calls it. Leak test asserts zero residual subscribers after unmount.

### 4.4 Renderer

```ts
// packages/ui/src/shared/ui/cell-renderer/Renderer.ts

export class Renderer {
  private rafHandle: number | null = null;
  private damage: DamageSet;
  private frozen = false;

  constructor(
    private readonly backend: BackendContract,
    private readonly cellBuffer: CellBuffer,
    private readonly mirror: GridMirror,
  ) {}

  start(): void {
    this.tick();
    this.mirror.onChange(this.scheduleFrame);
  }

  stop(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }

  /** Freeze → no more paint. Used for degraded-mode read-only display. */
  freeze(): void { this.frozen = true; }

  private scheduleFrame = () => {
    if (this.rafHandle !== null || this.frozen) return;
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  private tick = () => {
    this.rafHandle = null;
    const dirty = this.cellBuffer.drainDamage();
    if (dirty.isEmpty() && !this.damage.cursorDirty && !this.damage.overlayDirty) return;

    // Three-layer paint:
    // 1. Grid cells (only dirty rows).
    const rows = dirty.rows().map(r => this.mirror.getRow(r)).filter(Boolean);
    if (rows.length > 0) this.backend.applyGridDelta(rows, dirty);

    // 2. Cursor (separate z-layer; no full-row reblit on blink).
    if (this.damage.cursorDirty) this.backend.applyCursor(this.mirror.getCursor());

    // 3. Overlay (IME + selection highlight composited by the Selection + IME owners).
    this.backend.requestDamageFlush();

    this.damage.reset();
  };
}
```

Three layers:

1. **Grid cells** — paint dirty rows only. In Canvas2DBackend: clear row rect, redraw spans left-to-right using atlas blits.
2. **Cursor** — a separate `<canvas>` overlaid via CSS stacking. Blink timer is backend-internal; does NOT trigger `GridMirror` change events.
3. **Overlay** — IME preedit (EPIC-E) + selection highlight (this epic). Same DOM layer; z-index above cursor per ADR 0018 §7 layering.

**Damage coalescing**: multiple `GridMirror.onChange` events within a single rAF window merge into one `DamageSet` union. `scheduleFrame` is idempotent — if a frame is already queued, the second call is a no-op.

### 4.5 Hit-test + Selection (ADR 0016)

#### 4.5.1 HitTest

```ts
// packages/ui/src/shared/ui/cell-renderer/HitTest.ts

export class HitTest {
  constructor(private readonly metrics: CellMetrics, private readonly buffer: CellBuffer) {}

  /**
   * Inverse of cell layout. Honors width SSOT:
   *   - x inside the right half of a wide-char cell maps to the LEFT-HALF anchor.
   *   - x past the last cell returns `col = cols` (used by Selection for end-of-line).
   *   - x before col 0 returns null.
   *   - y outside grid returns null.
   *
   * Property: screenToCell(cellToScreen(r, c).midpoint()) === { row: r, col: c } for any r, c.
   * Verified by property test with ≥ 10 000 random cells.
   */
  screenToCell(xCssPx: number, yCssPx: number): ScreenHit | null;

  /** Pixel rect of a cell. Accounts for wide-char span. */
  cellToScreen(row: number, col: number): Rect;
}

export interface ScreenHit {
  row: number;
  col: number;
  /** Hyperlink id if the cell references one. Null if the cell has no hyperlink. */
  hyperlinkId: number | null;
}
```

The property test asserts `screenToCell(cellToScreen(r, c).midpoint()) === { row: r, col: c, hyperlinkId: ... }` for every cell in a 120×40 grid. A separate test asserts that for wide-char cells at col=K, `screenToCell(rightHalfMidpoint) === { row: r, col: K, ... }` (not K+1).

#### 4.5.2 Selection

```ts
// packages/ui/src/shared/ui/cell-renderer/Selection.ts

export type SelectionMode = 'char' | 'word' | 'line' | 'block';

export interface SelectionAnchor {
  row: number;
  col: number;
}

export interface Selection {
  start: SelectionAnchor;
  end: SelectionAnchor;
  mode: SelectionMode;
}

export class SelectionManager {
  private current: Selection | null = null;

  /** Begin a selection at cell. Mode determines behavior. */
  begin(anchor: SelectionAnchor, mode: SelectionMode): void;

  /** Extend the selection. Called on drag. */
  extend(anchor: SelectionAnchor): void;

  /** Finalize. Triggers onSelectionChange event. */
  end(): Selection | null;

  /** Cancel the in-progress selection. */
  cancel(): void;

  /** Normalized form (top-to-bottom, left-to-right) of current. */
  normalized(): Selection | null;

  /**
   * Copy the current selection to a UTF-8 string per ADR 0016 §5.
   * Options control trailing-whitespace policy (Alt-held = preserve).
   */
  copy(options: CopyOptions): string;

  /** Double-click expand: char → word boundary (Unicode word-break). */
  expandToWord(anchor: SelectionAnchor): Selection;

  /** Triple-click expand: word → line, including continuation join. */
  expandToLine(anchor: SelectionAnchor): Selection;

  /** Alt-drag toggle: switches mode to 'block'. */
  setBlockMode(blockMode: boolean): void;

  /** Observable — fires on end(). */
  onSelectionChange(cb: (sel: Selection | null) => void): Unsubscribe;
}

export interface CopyOptions {
  /** Preserve trailing whitespace per row (Alt/Opt held). */
  preserveTrailingWhitespace: boolean;
  /** Convert tabs to spaces with N-char tab stops (null = preserve literal tab). */
  tabStops: number | null;
}
```

**Copy normalization** (ADR 0016 §5 — implemented here, test-enforced):

- Continuation-row rejoin: rows with `continuation: true` are joined with **no separator** (wrap was soft).
- Non-continuation rows join with `\n`.
- Block mode: each visual row becomes its own line; short rows padded with spaces up to the rectangular column range.
- Trailing whitespace per line stripped unless `preserveTrailingWhitespace`.
- SGR attributes stripped (HTML-copy deferred per ADR 0016 §5).
- Grapheme safety: the renderer walks `GridMirror.getRow(r).cells` and concatenates `cell.grapheme`; it NEVER splits on code-point boundaries.
- Trailing half-cell strip: if the last cell in the selection is the right-half of a wide char, it is dropped (the preceding left-half already contributes the full grapheme).

### 4.6 Search

```ts
// packages/ui/src/shared/ui/cell-renderer/Search.ts

export interface SearchOptions {
  query: string;
  /** If true, interpret `query` as a JS RegExp source. */
  regex: boolean;
  caseSensitive: boolean;
  /** Search current alt-screen buffer only when alt-screen is active, else main+scrollback. */
  respectBufferScope: boolean;
}

export interface SearchMatch {
  /** Anchors on the visual grid. A single match may span continuation rows. */
  anchors: { start: SelectionAnchor; end: SelectionAnchor };
  /** Offset into the logical text view. */
  logicalOffset: number;
  /** Length in grapheme clusters. */
  length: number;
}

export class Search {
  constructor(private readonly mirror: GridMirror, private readonly buffer: CellBuffer) {}

  /**
   * Build the logical-text view: concat all row cells grapheme-wise;
   * continuation-tagged rows join without `\n`. Each logical offset has
   * a reverse-map to (row, col) anchors.
   */
  private buildLogicalView(): { text: string; anchorAt: (offset: number) => SelectionAnchor };

  /**
   * Find all matches. Returns [] if query is empty. Regex errors surface
   * as SearchError.
   */
  find(opts: SearchOptions): SearchMatch[];

  /** Cycle forward through matches; returns the newly-active match index. */
  next(): number;

  /** Cycle backward. */
  prev(): number;

  /** Scroll viewport to the active match. Consumed by TerminalCanvas. */
  scrollIntoView(match: SearchMatch): void;

  /** Clear search state; highlights removed. */
  clear(): void;

  /** Observable: re-runs search when mirror emits change (scrollback growth). */
  onResultsChanged(cb: (results: SearchMatch[]) => void): Unsubscribe;
}
```

`Cmd+G` / `Ctrl+G` is wired in `TerminalCanvas.tsx` via keyboard listeners that call `search.next()`. The handler scrolls via `cellToScreen` + container scroll. Match highlights are a separate selection-like overlay painted in the overlay layer.

### 4.7 IME overlay layer (consumed by EPIC-E)

The IME overlay is a **painting primitive**. EPIC-E owns the state machine and decides when to mount / update / unmount. EPIC-D exposes three methods on the backend + a TS anchor type; EPIC-E consumes them.

```ts
// packages/ui/src/shared/ui/cell-renderer/types.ts

export interface IMEOverlayAnchor {
  /** Cell where the overlay begins. */
  row: number;
  col: number;
  /** Font metrics at the anchor time (for sizing). */
  metrics: CellMetrics;
}
```

**Z-layering** (ADR 0018 §7 layering — confirmed here):

- Layer 1 (bottom): grid cells (backend paint).
- Layer 2: cursor (backend paint, separate canvas).
- Layer 3: IME overlay (mounted via `backend.mountOverlay`).
- Layer 4 (top): selection highlight (drawn in the overlay layer, but visually drawn LAST so selection over IME is legible).

Resize during composition: EPIC-E calls `backend.updateOverlay(handle, text)` with the new text; the anchor is unchanged (EPIC-E re-anchors if needed). EPIC-D does NOT commit preedit to the grid on resize.

---

## 5. Definition of Done (DoD)

Every item is a binary, testable predicate. ≥ 35 items required; 42 below satisfy.

### 5.1 Backend contract

- **DoD-D-01** — `BackendContract` interface is declared with every method from §4.1; `tsc --strict` passes; `tsc --emitDeclarationOnly` produces a `.d.ts` matching the committed fixture.
- **DoD-D-02** — `Canvas2DBackend` implements every method; `backend-contract.test.ts` exercises each and passes.
- **DoD-D-03** — `MemoryBackend` implements every method (paints no-op, hit-test/measure return correct data); same parity suite passes.
- **DoD-D-04** — Contract boundary proof: a third "fake" backend registered only in tests (returns fixed hit-test answers) passes the same suite. Any future backend (WebGL) proves conformance by passing this file unchanged.

### 5.2 FontAtlas

- **DoD-D-05** — LRU evicts beyond 4096 entries; inserting the 4097th entry causes the LRU-selected entry to be removed. Test asserts via `atlas.size() === 4096` after 4097 inserts and `atlas.has(firstKey) === false`.
- **DoD-D-06** — DPR change triggers `invalidateAll('dpr_change')`; atlas size drops to 0 after invalidation. Tested via `Object.defineProperty(window, 'devicePixelRatio', ...)` + `matchMedia` event.
- **DoD-D-07** — Theme change triggers invalidation. Test fires the theme-change event and asserts `invalidateAll('theme_change')` called.
- **DoD-D-08** — Font-family change triggers invalidation. Test mutates the font setting and asserts.
- **DoD-D-09** — `document.fonts.ready` late-load triggers invalidation with reason `font_load_complete`. Test simulates via `FontFaceObserver` mock.
- **DoD-D-10** — Bold/italic/underline are synthesized when the font face lacks the variant; rasterized output includes the synthesized styles. Visual-regression fixture covers this.

### 5.3 CellBuffer

- **DoD-D-11** — `CellBuffer` subscribes to `GridMirror.onChange` at construction; `dispose()` unsubscribes. Leak test: mount → dispose → mirror.emit → subscriber count === 0.
- **DoD-D-12** — PackedCell round-trip: for every cell shape in the v1 corpus (default, palette8, palette256, truecolor, with/without attrs, with hyperlink), `pack → unpack` yields the original shape. Property test with 10 000 random cells.
- **DoD-D-13** — `getRowCells(row)` returns read-only views; mutation attempts throw in strict mode. Test asserts `Object.isFrozen` on the returned rows.
- **DoD-D-14** — `drainDamage()` returns the dirty set and resets the internal tracker; next call returns empty until a new mirror change lands.

### 5.4 Renderer

- **DoD-D-15** — Renderer runs via `requestAnimationFrame`; a single rAF tick flushes at most one paint regardless of how many mirror changes queued during the frame. Test with fake rAF + 50 enqueued changes → 1 paint.
- **DoD-D-16** — No paint occurs when `DamageSet` is empty. Test spies on `backend.applyGridDelta` and asserts zero calls after `scheduleFrame()` on a clean buffer.
- **DoD-D-17** — Three-layer independence: cursor blink (mock `applyCursor` calls) does NOT trigger `applyGridDelta`. Test: invoke cursor blink 1000 times, assert 0 grid-delta paints.
- **DoD-D-18** — `freeze()` stops all subsequent paints until `stop()` + new `Renderer`. Used for degraded mode.
- **DoD-D-19** — Perf baseline: 60 fps steady-state on 120×40 × 1 MB/s synthetic stream, measured via `PerformanceObserver` (`longtask` + `measure` entries). Test asserts p95 frame time ≤ 16.6ms and zero `longtask` entries > 16ms.

### 5.5 Hit-test

- **DoD-D-20** — `screenToCell ∘ cellToScreen` identity within ½ cell, verified by property test with ≥ 10 000 random `(row, col)` inputs on a 120×40 grid.
- **DoD-D-21** — Wide-char half-mapping: for every 2-col cell at `(r, k)`, `screenToCell(rightHalfMidpoint)` returns `{ row: r, col: k }` (not `k+1`). Tested for Korean, Japanese, Chinese, emoji, ZWJ emoji.
- **DoD-D-22** — Out-of-grid screen coords return `null`. Covered for negative x/y and x/y beyond grid dimensions.
- **DoD-D-23** — Hyperlink hit-test returns the `hyperlinkId` on a cell with an active hyperlink. Tested via fixture.

### 5.6 Selection

- **DoD-D-24** — `char` mode: drag from `(r1, c1)` to `(r2, c2)` produces a normalized selection with those anchors. ≥ 5 scenarios covering top-down, bottom-up, single-row, across-rows, with wide chars.
- **DoD-D-25** — `word` mode (double-click): extends to Unicode word boundaries. ≥ 5 scenarios: ASCII word, CJK word (each character is its own "word"), emoji cluster (treated as a single word), mixed script, punctuation boundaries.
- **DoD-D-26** — `line` mode (triple-click): extends to the full logical line, including continuation-joined rows. ≥ 5 scenarios: single row, 2-row wrap, 4-row wrap, ends-with-hard-newline, ends-with-soft-wrap.
- **DoD-D-27** — `block` mode (Alt+drag): rectangular region. ≥ 5 scenarios: short rows padded, wide chars straddling the right edge, mixed row widths, crossing the continuation boundary, block on alt-screen.
- **DoD-D-28** — Selection modes total: 4 × ≥ 5 = **≥ 20** distinct scenario tests in `selection.test.ts`.

### 5.7 Copy normalization

- **DoD-D-29** — Copy scenario 1 — basic ASCII line: copy yields exact line text with trailing whitespace stripped.
- **DoD-D-30** — Copy scenario 2 — wrap-joined: 3-line wrapped command copies as a single line with no newlines.
- **DoD-D-31** — Copy scenario 3 — hard newline preserved: selection crossing `\n`-terminated rows emits `\n` between them.
- **DoD-D-32** — Copy scenario 4 — Korean line (`한글 테스트`): copy yields exactly `"한글 테스트"` as 5 graphemes; no trailing half-cell emitted.
- **DoD-D-33** — Copy scenario 5 — ZWJ family emoji (`👨‍👩‍👧‍👦`): single grapheme copied as 25 UTF-8 bytes; NOT split into 4 separate emoji.
- **DoD-D-34** — Copy scenario 6 — combining mark (`é` = `e` + `U+0301`): copy yields 3 UTF-8 bytes; no split at the combining boundary.
- **DoD-D-35** — Copy scenario 7 — VS16 (`❤️`): copies as `❤` + VS16 (6 bytes); not stripped.
- **DoD-D-36** — Copy scenario 8 — tabs preserved with `tabStops: null`; tabs converted to spaces with `tabStops: 8`.
- **DoD-D-37** — Copy scenario 9 — block mode padding: short rows padded with spaces up to the rectangle's rightmost column.
- **DoD-D-38** — Copy scenario 10 — trailing spaces stripped by default.
- **DoD-D-39** — Copy scenario 11 — trailing spaces preserved with `preserveTrailingWhitespace: true`.
- **DoD-D-40** — Copy scenario 12 — right-half of wide char at selection end is stripped (no half-cell emitted).
- **DoD-D-41** — Copy scenario 13 — SGR stripped: bold/underlined text copies as plain UTF-8 (no ANSI, no HTML).
- **DoD-D-42** — Copy scenario 14 — cross-buffer blocked: selection starting on scrollback cannot extend into alt-screen; attempting clears selection (per ADR 0016 §6).
- **DoD-D-43** — Copy scenario 15 — empty selection yields empty string.

**Copy total: 15 scenarios** in `copy-normalization.test.ts` — DoD bar "15+ scenarios" met.

### 5.8 Search

- **DoD-D-44** — Substring search across scrollback: query finds matches spanning continuation rows.
- **DoD-D-45** — Regex search honors JS RegExp source; invalid regex surfaces as `SearchError` (not a silent zero-result).
- **DoD-D-46** — Case sensitivity toggle works; `/Abc/i` matches `abc`.
- **DoD-D-47** — Cmd+G (macOS) / Ctrl+G cycles forward; Shift+Cmd+G cycles backward; both wrap at ends.
- **DoD-D-48** — Highlight lifecycle: match highlights appear in the overlay layer; `search.clear()` removes them. No residual paint after clear.
- **DoD-D-49** — Viewport scroll: active-match `cellToScreen` rect is brought into view on cycle.

### 5.9 Hyperlinks

- **DoD-D-50** — Cmd+click (macOS) / Ctrl+click on a hyperlinked cell fires `onHyperlinkClick(id, uri)` prop. Test uses React Testing Library synthetic events.
- **DoD-D-51** — Plain click does NOT fire `onHyperlinkClick`; it begins a selection per `char` mode.
- **DoD-D-52** — Hyperlink hover (`pointermove` on a hyperlinked cell) exposes the URI via a `onHyperlinkHover(uri | null)` callback so the host can show a tooltip.

### 5.10 Widget lifecycle

- **DoD-D-53** — `TerminalCanvas` mounts with a `GridSnapshot` → visible cell grid within 1 rAF frame. Test: mount with fixture snapshot, wait one frame, snapshot the canvas pixels, compare to golden.
- **DoD-D-54** — `TerminalCanvas` unmount removes all DOM sub-elements; backend's `unmount()` called; `CellBuffer.dispose()` called; `GridMirror.onChange` subscriber count back to pre-mount. Leak test asserts all four.
- **DoD-D-55** — Backend swap at runtime (`backend` prop flips from `canvas` → `memory`): new backend mounts, old unmounts cleanly; observable behavior (selection/copy/search outputs) unchanged.

### 5.11 ADR closure + process gates

- **DoD-D-56** — ADR 0016 status updated from Proposed → Accepted. Open Questions resolved in `## Resolved` section with decisions committed: (a) Cmd-click multi-select over Shift-click extension; (b) "Find in block" separate from "Find in grid"; (c) JS `RegExp` for search (Rust `regex` reserved for scrollback > 100k rows, deferred); (d) Cmd+C default, copy-on-select setting available.
- **DoD-D-57** — `pnpm --filter @quanta/ui test` green (all `__tests__/` files pass).
- **DoD-D-58** — `pnpm typecheck` clean (no `any`, no `@ts-expect-error` outside documented exception lines).
- **DoD-D-59** — Visual-regression baseline committed: `fixtures/visual-regression/golden-120x40.png` + `golden-120x40.delta-stream.json`. Pixel-perfect match ±1 px tolerance via `pixelmatch`.
- **DoD-D-60** — Per-stage perf budget hit. Stages from RFC §13.13: **layout / hit-test ≤ 1 ms p95**, **raster ≤ 5 ms p95**, **cursor/overlay ≤ 1 ms p95**, **atlas-miss recovery ≤ 3 ms p95**. Measured on baseline (M-series macOS in CI).
- **DoD-D-61** — EPIC-K grep rule `check-paint-no-width-override` green: no direct `unicode-width` / `wcwidth` imports in `packages/ui/src/shared/ui/cell-renderer/**` (width access goes through EPIC-A `@quanta/width` TS mirror only).
- **DoD-D-62** — Schema-parity with ADR 0016 test: the `SelectionAnchor` TS interface shape matches the ADR document fixture (committed at `docs/adr/0016-selection-search-copy-semantics.md`).

**Total: 62 DoD items** (≥ 35 bar met).

---

## 6. Quality Gates

Gates are CI-enforceable. Per-gate failure-behavior described.

| # | Gate | Enforced by | Failure behavior |
|---|------|-------------|------------------|
| QG-D-1 | **Backend parity suite** | `pnpm --filter @quanta/ui test -- backend-contract` | Red check; prints per-backend diff. Covers DoD-D-02, -03, -04. |
| QG-D-2 | **FontAtlas LRU + invalidation** | `pnpm --filter @quanta/ui test -- font-atlas` | Red check; `size()` or invalidation reason mismatch in stacktrace. |
| QG-D-3 | **CellBuffer leak test** | `pnpm --filter @quanta/ui test -- cell-buffer` | Red check; subscriber count diff shown. |
| QG-D-4 | **Hit-test property test** | `pnpm --filter @quanta/ui test -- hit-test` (fast-check prop tests) | Red check; prints the failing `(row, col)` + seed. |
| QG-D-5 | **Selection + copy normalization** | `pnpm --filter @quanta/ui test -- selection copy-normalization` | Red check; prints expected vs actual copy string (UTF-8 byte array). |
| QG-D-6 | **Search correctness** | `pnpm --filter @quanta/ui test -- search` | Red check; prints expected matches vs actual. |
| QG-D-7 | **Visual regression** | `pnpm --filter @quanta/ui test -- visual-regression` | Red check; uploads diff PNG + exact pixel-delta count. Threshold 1 px per channel. |
| QG-D-8 | **Perf harness** | `pnpm --filter @quanta/ui test -- perf-budget` (extended run) | Red check; per-stage p95 + budget in comment. Non-regression threshold: 10% over baseline. |
| QG-D-9 | **EPIC-K grep: `check-paint-no-width-override`** | `.github/workflows/grep-rules.yml` | Red check; prints the offending import line + file path. |
| QG-D-10 | **Typecheck + ESLint** | `pnpm typecheck` + `pnpm lint --filter @quanta/ui` | Red check; standard TS/ESLint diagnostics. |
| QG-D-11 | **Hyperlink hit-test + click** | `pnpm --filter @quanta/ui test -- hyperlink-click` | Red check; RTL event trace. |
| QG-D-12 | **IME overlay slot contract** | `pnpm --filter @quanta/ui test -- ime-overlay` | Red check; asserts mount/update/unmount idempotency + z-layer order. |

All 12 must be green for EPIC-D merge. No waivers.

---

## 7. End-to-end scenarios

Each scenario is a standalone integration test with step-by-step actor/action/assertion. Location given per test.

### 7.1 E2E-D1 — Mount & first-frame snapshot

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/TerminalCanvas.mount.e2e.test.tsx`.

**Steps**:
1. Create a `GridMirror` instance; apply a fixture `GridSnapshot` (2×4 grid, ASCII "abcd" on row 0 and blanks on row 1).
2. Render `<TerminalCanvas mirror={mirror} backend="canvas" />` via RTL.
3. Wait one rAF tick (`await new Promise(r => requestAnimationFrame(r))`).
4. Capture canvas pixels via `ctx.getImageData`.

**Assertions**:
- Pixel buffer matches `fixtures/visual-regression/mount-2x4-ascii.png` within 1 px.
- No `backend.applyGridDelta` calls before the snapshot apply (first paint is from `applyGridSnapshot`).
- `CellBuffer.size()` exposes 2 rows × 4 cols.

---

### 7.2 E2E-D2 — 1000-delta stream at 60 fps

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/stream-60fps.e2e.test.tsx`.

**Steps**:
1. Render `<TerminalCanvas ... />` with a 120×40 fixture snapshot.
2. Fire 1000 `GridDelta` envelopes into the mirror at 60 Hz (measured-time-driven; not all at once).
3. Hook `PerformanceObserver` to `longtask` + `measure` entries.

**Assertions**:
- 0 `longtask` entries > 16 ms.
- p95 paint-duration ≤ 16.6 ms.
- p99 ≤ 33 ms.
- Final `CellBuffer` state matches a clean full-replay.
- `backend.applyGridDelta` call count ≤ 1000 (damage coalescing within rAF drops to as low as 16 in bursts).

---

### 7.3 E2E-D3 — DPR switch

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/dpr-switch.e2e.test.tsx`.

**Steps**:
1. Mount `TerminalCanvas` with DPR=1.0 (mocked via `Object.defineProperty(window, 'devicePixelRatio', { value: 1.0 })` + `matchMedia` fake).
2. Apply a snapshot with Korean text on row 5.
3. Fire a DPR change event (mock `matchMedia('(resolution: 2dppx)')` → matches).
4. Wait one rAF tick.

**Assertions**:
- `FontAtlas.invalidateAll('dpr_change')` called exactly once.
- Atlas size drops to 0, then refills during next paint.
- Row 5 re-rasters with correctly-sized Korean glyphs (visual-regression vs `golden-dpr2.png`).
- Total DPR-swap-to-first-correct-paint ≤ 50 ms.

---

### 7.4 E2E-D4 — Late web-font load

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/late-font-load.e2e.test.tsx`.

**Steps**:
1. Mount `TerminalCanvas`; font family is "Fira Code" but the face hasn't loaded yet; raster uses fallback (system mono).
2. Apply a snapshot with mixed ASCII + Korean.
3. Resolve `document.fonts.ready`: "Fira Code" ttf loads.
4. Wait two rAF ticks.

**Assertions**:
- Frame 1 (before font load): glyphs render in fallback font — visual diff `font-fallback.png`.
- `FontAtlas.invalidateAll('font_load_complete')` called exactly once after font-load event.
- Frame 2 (after font load): glyphs render in Fira Code — visual diff `font-fira-code.png`.
- No intermediate partial-paint corruption (both frames internally consistent).
- Retires RFC §22 #19 (late font invalidates mid-frame).

---

### 7.5 E2E-D5 — Drag-select Korean line

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/drag-select-korean.e2e.test.tsx`.

**Steps**:
1. Mount `TerminalCanvas`; row 10 contains "한글 테스트" (5 graphemes = 9 cells: 2+2+1+2+2).
2. Simulate `pointerdown` at the midpoint of col 0 (left half of `한`).
3. Simulate `pointermove` through the line to col 8 (right half of `트`).
4. Simulate `pointerup`.
5. Call `selection.copy({ preserveTrailingWhitespace: false, tabStops: null })`.

**Assertions**:
- Selection anchors: `start={row:10, col:0}, end={row:10, col:7}` (col 7 is the left-half of `트`, because width SSOT normalizes right halves to left).
- Copy output === `"한글 테스트"` (4 graphemes + space = 5 elements, 14 UTF-8 bytes).
- No trailing half-cell emitted.
- Retires RFC §22 #20 (wrap-row / wide-char selection copy wrong).

---

### 7.6 E2E-D6 — Triple-click on wrapped row

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/triple-click-wrap.e2e.test.tsx`.

**Steps**:
1. Mount with a fixture where a single logical line wraps across rows 20, 21, 22 (rows 21 and 22 have `continuation: true`).
2. Simulate triple-click on any cell in row 21.
3. Call `selection.copy(...)`.

**Assertions**:
- Selection starts at `{row:20, col:0}` and ends at the last non-blank cell of row 22.
- Copy output is the joined string (no `\n` between the 3 rows) — per ADR 0016 §5 continuation rejoin.
- Partially retires RFC §22 #20.

---

### 7.7 E2E-D7 — Alt+drag rectangular selection

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/alt-drag-block.e2e.test.tsx`.

**Steps**:
1. Mount with 5 rows of variable content (row 0 length=20, row 1 length=5, row 2 length=15, row 3 length=2, row 4 length=10).
2. Hold Alt (or Opt on macOS); `pointerdown` at `(row:0, col:3)`; drag to `(row:4, col:8)`.
3. `pointerup`.
4. Copy.

**Assertions**:
- Selection mode === `'block'`.
- Copy yields 5 lines joined by `\n`; each line is exactly the cells from col 3..8 of its row; short rows are padded with spaces.
- Row 3 (2 cells) produces exactly "  " + "      " = 6 spaces in the selected range.

---

### 7.8 E2E-D8 — Search Korean across scrollback

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/search-korean.e2e.test.tsx`.

**Steps**:
1. Mount with a snapshot containing 100 rows of scrollback, 3 of which contain "한글" (rows 14, 47, 89).
2. Call `search.find({ query: "한글", regex: false, caseSensitive: true, respectBufferScope: true })`.
3. Call `search.next()` 4 times.

**Assertions**:
- `find` returns exactly 3 `SearchMatch` objects with anchors on rows 14, 47, 89.
- Each `match.length === 2` (2 graphemes).
- `search.next()` cycles: match 0 → 1 → 2 → 0 (wrap).
- Each `next()` call triggers `scrollIntoView`; the viewport scroll target is within the cell-rect of the active match.
- Highlights paint in the overlay layer for all 3 matches.

---

### 7.9 E2E-D9 — Hyperlink Cmd+click

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/hyperlink-click.e2e.test.tsx`.

**Steps**:
1. Apply a `HyperlinkAdded { id: 1, uri: "https://example.com/a", params: null }` to the mirror.
2. Apply a `GridDelta` with a span on row 5 cols 10..18 referencing `hyperlink_id: 1`.
3. Mount `TerminalCanvas` with an `onHyperlinkClick` spy.
4. Simulate `pointerdown` with `metaKey: true` (Cmd) at the midpoint of row 5, col 14.

**Assertions**:
- `onHyperlinkClick` called once with `(1, "https://example.com/a")`.
- No selection started (Cmd+click is hyperlink-click, not selection-begin).

---

### 7.10 E2E-D10 — Backend swap mid-session

**Fixture**: `packages/ui/src/widgets/terminal-canvas/__tests__/backend-swap.e2e.test.tsx`.

**Steps**:
1. Mount `<TerminalCanvas backend="canvas" ... />`.
2. Apply a snapshot and 100 deltas; establish a selection; call `selection.copy()` → capture string S1.
3. Re-render with `<TerminalCanvas backend="memory" ... />` (prop swap).
4. Re-run the same selection sequence; call `selection.copy()` → capture S2.
5. Run `search.find({ query: "foo", ... })` on both backends.

**Assertions**:
- Canvas2D `unmount()` called; MemoryBackend `mount()` called; both called exactly once during the swap.
- S1 === S2 (selection/copy is backend-independent per RFC §12 acceptance).
- Search results identical between the two backends.
- No canvas DOM residue after swap (`querySelectorAll('canvas')` count === 0 for the MemoryBackend path).

---

**Total: 10 E2E scenarios** (≥ 10 bar met).

---

## 8. Test deliverables

Files, case counts, and fixture formats.

| File | Case count (≥) | Notes |
|------|---------------|-------|
| `__tests__/backend-contract.test.ts` | 40 | Parity cases run against Canvas2DBackend + MemoryBackend |
| `__tests__/font-atlas.test.ts` | 15 | LRU, DPR, theme, font-family, font-load, bold/italic synth |
| `__tests__/cell-buffer.test.ts` | 12 | Pack/unpack + leak test + subscription |
| `__tests__/damage-set.test.ts` | 10 | Coalescing, drain, union |
| `__tests__/hit-test.test.ts` | 8 + property | Inverse identity + wide-char half + out-of-grid |
| `__tests__/selection.test.ts` | 20 | 4 modes × ≥ 5 scenarios each |
| `__tests__/copy-normalization.test.ts` | 15 | Per DoD-D-29..43 |
| `__tests__/search.test.ts` | 12 | Substring, regex, cycling, wrap-aware, alt-buffer scope |
| `__tests__/hyperlink-click.test.ts` | 5 | Cmd/Ctrl+click, plain click, hover, missing-id fallback |
| `__tests__/renderer-rAF.test.ts` | 8 | Damage coalescing, no-paint-when-clean, freeze, stop |
| `__tests__/TerminalCanvas.mount.test.tsx` | 6 | Mount/unmount/backend-swap/leak/props/children |
| `__tests__/ime-overlay.test.ts` | 8 | mount/update/unmount, z-layer, re-anchor |
| `__tests__/visual-regression.test.ts` | 10 | ASCII, Korean, emoji, truecolor, wrap, alt-screen, cursor, IME, selection, hyperlink-underline |
| `__tests__/perf-budget.test.ts` | 6 | Per-stage p95 budgets (raster, hit-test, copy, search, overlay, atlas-miss) |
| **Total tests: ≥ 175** | | |

### 8.1 Visual-regression fixture format

Each visual-regression case is a pair:

```
fixtures/visual-regression/
├── case-korean-line.png              # golden screenshot (PNG, 24-bit RGB)
└── case-korean-line.description.json # deterministic description
```

`.description.json` shape:

```json
{
  "name": "korean-line",
  "dimensions": { "rows": 40, "cols": 120 },
  "dpr": 2.0,
  "theme": "dark",
  "fontFamily": "Fira Code",
  "fontSizePx": 14,
  "snapshot": { "kind": "grid_snapshot", "...": "..." },
  "deltas": [
    { "kind": "grid_delta", "...": "..." }
  ],
  "cursor": { "row": 0, "col": 0, "visible": true, "shape": "block", "blinking": false },
  "selection": null,
  "imeOverlay": null,
  "postApplyRAFTicks": 2,
  "toleranceAbsPx": 1
}
```

Tests load the `.description.json`, drive the mirror + widget per description, render at given DPR, capture pixels, run `pixelmatch(actual, golden, { threshold: toleranceAbsPx })`, assert diff count === 0.

### 8.2 Perf harness fixture format

```
fixtures/perf/
├── stream-120x40-1mbps.ndjson   # 60 seconds of synthetic deltas
└── stream-120x40-1mbps.manifest.json
```

Manifest declares per-stage budgets + baseline on the CI machine class. Harness reports each stage via `performance.measure` and fails if p95 exceeds budget.

---

## 9. Failure modes retired

EPIC-D explicitly retires two of the 20 failure modes enumerated in RFC §22. Each is both _tested_ in this epic and _CI-enforced_ by the test file listed.

- **§22 #19 — web font late load → atlas invalidates mid-frame → flash.** Retired by `FontAtlas.invalidateAll('font_load_complete')` (§4.2) + E2E-D4. The atlas invalidates at rAF boundaries, never mid-paint; first frame after font-load re-rasters all glyphs in the new face.
- **§22 #20 — selection across wrapped row → copy joined-wrong → paste wrong text.** Retired by `Selection.ts` copy normalization (§4.5.2) + E2E-D5, E2E-D6. Continuation-row rejoin is the copy-default; grapheme safety + trailing-half-cell strip keep Korean/emoji selections intact.

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Canvas2D perf insufficient on low-end laptops (RFC §22 #15 rhymes). | Medium | High | RFC 0002 WebGL follow-up. Backend contract is the entire point of §4.1: WebGL drops in behind the same interface, no UX rewrite. Perf harness fail triggers an accelerated RFC 0002 timeline, not a redesign. |
| Text shaping differences between Safari and Chrome (glyph metrics, sub-pixel positioning). | High | Medium | EPIC-K platform matrix tracks per-browser visual-regression goldens. Tolerance is 1 px; systematic differences become platform-specific goldens, not single goldens. |
| IME overlay z-fighting with cursor. | Medium | Medium | ADR 0018 §7 + §4.7 layering: overlay z above cursor, below selection. Covered by `ime-overlay.test.ts` z-layer assertion. |
| `document.fonts.ready` fires inconsistently across browsers on cached fonts. | Medium | Low | Use `FontFaceObserver` polyfill path; retire race by always invalidating atlas at the first paint after `fonts.ready` resolves, even if already-loaded. |
| Selection over very long scrollback (> 10k rows) freezes UI at copy time (single-pass O(n) string build). | Low | Medium | `selection.copy()` uses an incremental `string[]` builder + single `.join('')`. Budget check on perf harness. If still slow, move copy-building to a worker. |
| Users expect macOS-style copy-on-select. | Medium | Low | ADR 0016 decides Cmd+C default; copy-on-select is a per-user setting. Documented in ADR 0016 Accepted section. |
| `OffscreenCanvas` unavailable in older Electron / Tauri WebViews. | Low | Medium | Fallback to a hidden `<canvas>` DOM node for atlas; branch in `FontAtlas` constructor. Test covers both paths. |

---

## 11. Rollback

The backend contract IS the rollback plan. If Canvas2D perf is insufficient:

1. WebGL / WebGPU backend drops in as a new `BackendContract` implementation with no other changes.
2. `TerminalCanvas` prop flips from `backend="canvas"` to `backend="webgl"`.
3. All of Selection / Search / Copy / HitTest code runs unchanged — they operate on `GridMirror` data, not on paint output.

If the entire renderer is non-viable: `MemoryBackend` + `data-renderer="xterm"` (EPIC-H side-by-side flag) keeps xterm as the default. EPIC-I does not proceed.

---

## 12. Cross-references

- **RFC 0001 §2** invariants I-3 (Grid is truth), I-4 (semantic width wins), I-5 (delta from day one), I-8 (no black screen).
- **RFC 0001 §3.4** paint truth boundary.
- **RFC 0001 §7.5** architecture overview (the `cell-renderer (Canvas2D → WebGL)` block is this epic).
- **RFC 0001 §11** selection/copy/search semantics authority.
- **RFC 0001 §12** renderer backend contract.
- **RFC 0001 §13.8** copy/selection acceptance.
- **RFC 0001 §13.11** side-by-side diff (consumed by EPIC-H).
- **RFC 0001 §13.13** per-stage perf budgets.
- **RFC 0001 §14.1** SHOULD renderer items (glyph atlas LRU, damage-based redraw, cursor separate layer, IME overlay own layer — all MUST here).
- **RFC 0001 §22 #19, #20** failure modes retired (§9).
- **ADR 0015** width SSOT (consumed by `HitTest` + `Selection`).
- **ADR 0016** selection/search/copy (moved to Accepted by this epic).
- **ADR 0017** reducer ordering (consumed via EPIC-C `GridMirror`).
- **ADR 0018** IME state machine (overlay slot consumed by EPIC-E).
- **EPIC-A** `@quanta/width` TS mirror (consumed by `HitTest`, `Selection.expandToWord`).
- **EPIC-C** `GridMirror` (§4.1 of its design) — `onChange`, `getRow`, `getCursor`, `getMode`, `snapshotMode`, `getAppliedEpoch`, `getAppliedSequence`.
- **EPIC-E** `PreeditOverlay` — consumes `backend.mountOverlay` / `updateOverlay` / `unmountOverlay` + `IMEOverlayAnchor` type.
- **EPIC-H** side-by-side harness — consumes `TerminalCanvas`'s prop-driven backend swap.
- **EPIC-J** telemetry — atlas-miss counter, paint-duration histogram, hit-test latency histogram registered here.
- **EPIC-K** `check-paint-no-width-override` grep rule — enforced in `cell-renderer/**`.

---

## 13. Work breakdown (days)

Two-week calendar. Each day ships a testable artifact.

### Week 1

- **Day 1** — `BackendContract.ts` interface + types.ts + barrel. Skeleton `Canvas2DBackend.ts` (stubs). Skeleton `MemoryBackend.ts` (stubs). `backend-contract.test.ts` with first 10 parity cases. Both backends pass the first 10.
- **Day 2** — `Canvas2DBackend.mount/unmount/applyMetrics/measureText`. `MemoryBackend` equivalents. 20 more parity cases green.
- **Day 3** — `FontAtlas.ts`: constructor, `getOrRaster`, LRU, `invalidateAll`. `font-atlas.test.ts` all cases (DoD-D-05..10).
- **Day 4** — `CellBuffer.ts`: PackedCell pack/unpack, mirror subscription, dispose. `cell-buffer.test.ts` all cases. `DamageSet.ts` + `damage-set.test.ts`.
- **Day 5** — `Renderer.ts`: rAF loop, three-layer paint, damage coalescing. `renderer-rAF.test.ts` all cases. Visual-regression baseline committed: ASCII + blank + cursor-only fixtures produce golden PNGs.

### Week 2

- **Day 6** — `HitTest.ts`: `screenToCell`, `cellToScreen`, wide-char half-mapping. `hit-test.test.ts` all cases (DoD-D-20..23).
- **Day 7** — `Selection.ts`: 4 modes (`char`, `word`, `line`, `block`), normalization, copy. `selection.test.ts` (20 cases) + `copy-normalization.test.ts` (15 cases) — DoD-D-24..43.
- **Day 8** — `Search.ts` + `hyperlink-click.test.ts`. `search.test.ts` (12 cases) + hyperlink cases (5).
- **Day 9** — `MemoryBackend.ts` fully implemented (hit-test, measure, overlay). Parity suite run against both backends fully green (40+ cases). Backend-swap E2E green.
- **Day 10** — Perf harness wire-in (`perf-budget.test.ts`). Budget baselines committed. Visual-regression suite complete (10 cases). **ADR 0016 status flipped to Accepted** with Open Questions resolved. All 62 DoD items green. PR opened.

**Total: 10 working days = 2 calendar weeks.** Day-level artifacts make slippage detectable within 1 day.

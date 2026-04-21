/**
 * Canvas2DBackend — reference `BackendContract` implementation.
 *
 * Draws the grid into a stack of three canvases layered via absolute
 * positioning:
 *   - cell canvas (grid rows, most writes).
 *   - cursor canvas (cursor shape; blink).
 *   - overlay canvas / DOM (IME preedit + selection highlight).
 *
 * jsdom compatibility: jsdom returns `null` from `canvas.getContext('2d')`
 * unless explicit polyfills are installed. We guard all real-canvas calls
 * behind `ctx != null`; when the ctx is missing, the backend records what
 * WOULD have been painted (see `_paintLog`) so the parity suite can still
 * verify the sequence of applyGridDelta / applyCursor / applyMode calls.
 *
 * Font-resilience (tab-switch bug — see §Font Resilience below):
 *   Canvas2D's default `ctx.font` is "10px sans-serif". The backend SHOULD
 *   apply the terminal font stack on every paint entry so that:
 *     1. First paint renders in the mono stack (not sans-serif).
 *     2. Context state resets (Chromium occasionally discards some paint
 *        state when a canvas is backgrounded + refocused under Tauri WebView)
 *        cannot leave the terminal looking like sans-serif.
 *   We also listen for `document.fonts.ready` once and for `visibilitychange`
 *   for the lifetime of the mount: when web fonts arrive after first paint,
 *   we invalidate the atlas and signal the renderer to reblit; when the tab
 *   becomes visible again we do the same so any context-state drift is
 *   healed on the next rAF tick.
 */

import { DefaultClassifier, resolveAmbiguousPolicy } from '../../../lib/width/index.js';
import type {
  CursorState,
  Row,
  TerminalModeState,
} from '../../../lib/grid-mirror/types.js';
import type { DamageSet } from '../DamageSet.js';
import { FontAtlas, MemoryRasterizer } from '../FontAtlas.js';
import type {
  CellMetrics,
  IMEOverlayAnchor,
  OverlayHandle,
  Rect,
  ScreenHit,
} from '../types.js';
import type { SearchHighlight } from '../CellBuffer.js';
import type {
  BackendContract,
  MountContext,
  TextMeasurement,
} from './BackendContract.js';

interface PaintEvent {
  readonly kind:
    | 'mount'
    | 'unmount'
    | 'snapshot'
    | 'delta'
    | 'cursor'
    | 'mode'
    | 'metrics'
    | 'overlay_mount'
    | 'overlay_update'
    | 'overlay_unmount'
    | 'flush'
    | 'fonts_ready'
    | 'visibility_refresh'
    | 'search_highlights';
  readonly rows?: number;
  readonly cursorVisible?: boolean;
  readonly highlightCount?: number;
}

/**
 * Canonical terminal monospace stack. Mirrors `--q-font-mono` in
 * shared/config/tokens.css (source of truth for CSS consumers). The
 * Canvas2D context does not read CSS variables — the string must be
 * synthesized JS-side. Keep this in lockstep with tokens.css.
 */
const TERMINAL_FONT_STACK =
  "'JetBrains Mono', 'Noto Sans Mono CJK JP', 'Noto Sans Mono CJK SC', " +
  "'PingFang SC', 'Hiragino Sans', 'Microsoft YaHei', 'Apple Color Emoji', " +
  "'Segoe UI Emoji', 'Noto Color Emoji', ui-monospace, 'SF Mono', Menlo, " +
  'Consolas, monospace';

/** Optional user-selected font family string. When non-null, `buildFontString`
 *  uses it instead of `TERMINAL_FONT_STACK`. Set by the font-settings feature
 *  via `_setFontOverride`. */
interface FontOverride {
  readonly family: string | null;
  /** Feature string forwarded to `ctx.fontFeatureSettings` when the platform
   *  supports it. 2D context feature-settings is Chromium-only for now;
   *  non-supporting browsers ignore the assignment. */
  readonly features: string | null;
}

/** The `font` shorthand string applied to `ctx.font` for the given cell
 *  height. Canvas2D honors the same syntax as CSS `font`. */
function buildFontString(cellHeightPx: number, override: FontOverride | null): string {
  // Pick a glyph size that sits comfortably within the cell. 0.80 of the
  // cell height matches what the metrics derivation targets and keeps the
  // baseline offset (`metrics.baselineOffsetPx`) stable.
  const px = Math.max(1, Math.round(cellHeightPx * 0.8));
  const family =
    override && override.family ? override.family + ', ' + TERMINAL_FONT_STACK : TERMINAL_FONT_STACK;
  return `${px}px ${family}`;
}

export class Canvas2DBackend implements BackendContract {
  private container: HTMLElement | null = null;
  private cellCanvas: HTMLCanvasElement | null = null;
  private cursorCanvas: HTMLCanvasElement | null = null;
  private overlayLayer: HTMLDivElement | null = null;
  private cellCtx: CanvasRenderingContext2D | null = null;
  private cursorCtx: CanvasRenderingContext2D | null = null;
  private atlas: FontAtlas | null = null;
  private metrics: CellMetrics = {
    cellWidthPx: 8,
    cellHeightPx: 16,
    baselineOffsetPx: 12,
    cellWidthCssPx: 8,
    cellHeightCssPx: 16,
  };
  private dpr = 1;
  private mode: TerminalModeState = {};
  private readonly classifier = new DefaultClassifier(
    resolveAmbiguousPolicy('auto', 'macos', null),
  );
  private readonly overlays = new Map<symbol, { anchor: IMEOverlayAnchor; el: HTMLSpanElement }>();
  private readonly paintLog: PaintEvent[] = [];
  private gridRows = 0;
  private gridCols = 0;
  /** Cached font shorthand — recomputed when metrics change. */
  private fontString = '';
  /** Teardown thunks collected by `mount`, flushed by `unmount`. */
  private disposers: Array<() => void> = [];
  /**
   * Invalidation callback — fires when we need to force a re-raster + atlas
   * drop (font load completion, tab refocus). The Renderer subscribes to
   * its MirrorSource; this backend does not hold that subscription handle
   * directly, so instead we invalidate the atlas and rely on the next rAF
   * tick to reblit. Tests inject a spy via `_setInvalidationHook`.
   */
  private invalidationHook: (() => void) | null = null;
  /** User-selected font override (family + feature-settings). Set from the
   *  font-settings feature via `_setFontOverride`; affects the font
   *  shorthand and is re-applied on every paint entry. */
  private fontOverride: FontOverride | null = null;

  mount(ctx: MountContext): void {
    this.container = ctx.container;
    this.metrics = ctx.metrics;
    this.dpr = ctx.dpr;

    // Create layered canvases.
    this.cellCanvas = document.createElement('canvas');
    this.cellCanvas.className = 'quanta-cell-canvas';
    this.cellCanvas.setAttribute('data-layer', 'cells');
    Object.assign(this.cellCanvas.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '1',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);

    this.cursorCanvas = document.createElement('canvas');
    this.cursorCanvas.className = 'quanta-cursor-canvas';
    this.cursorCanvas.setAttribute('data-layer', 'cursor');
    Object.assign(this.cursorCanvas.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '2',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);

    this.overlayLayer = document.createElement('div');
    this.overlayLayer.className = 'quanta-overlay-layer';
    this.overlayLayer.setAttribute('data-layer', 'overlay');
    Object.assign(this.overlayLayer.style, {
      position: 'absolute',
      inset: '0',
      zIndex: '3',
      pointerEvents: 'none',
    } as CSSStyleDeclaration);

    ctx.container.appendChild(this.cellCanvas);
    ctx.container.appendChild(this.cursorCanvas);
    ctx.container.appendChild(this.overlayLayer);

    // jsdom returns null from getContext('2d'); swallow the "Not implemented"
    // warning so test stderr stays legible.
    try {
      this.cellCtx = this.cellCanvas.getContext('2d');
      this.cursorCtx = this.cursorCanvas.getContext('2d');
    } catch {
      this.cellCtx = null;
      this.cursorCtx = null;
    }
    this.atlas = new FontAtlas(this.metrics, { rasterizer: new MemoryRasterizer() });
    this.fontString = buildFontString(this.metrics.cellHeightPx, this.fontOverride);
    this.applyContextState();
    this.wireFontAndVisibilityListeners();
    this.paintLog.push({ kind: 'mount' });
  }

  /**
   * Apply font family, baseline, and fill state to both canvas contexts.
   * Safe to call repeatedly: it overrides whatever the context inherited.
   * Called on mount, on every paint entry (paintRows), on metrics change,
   * and when fonts-ready or visibilitychange fires.
   */
  private applyContextState(): void {
    const features = this.fontOverride?.features ?? null;
    if (this.cellCtx) {
      this.cellCtx.font = this.fontString;
      this.cellCtx.textBaseline = 'alphabetic';
      // Chromium exposes `fontFeatureSettings` on 2D contexts so programming
      // ligatures (calt/liga) can be toggled JS-side. Non-supporting browsers
      // silently accept/ignore the assignment; guard with a feature sniff
      // so we don't poison the fallback path.
      if (features !== null) {
        const ctxRec = this.cellCtx as unknown as { fontFeatureSettings?: string };
        if ('fontFeatureSettings' in this.cellCtx) {
          try {
            ctxRec.fontFeatureSettings = features;
          } catch {
            // noop — older browsers
          }
        }
      }
      // `fillStyle` defaults to "#000" on a fresh context which is invisible
      // on dark themes. The CSS var cannot be read from a canvas, so fall
      // back to the terminal foreground token's dark-theme default. A future
      // pass will plumb the resolved `--q-fg` through mount context.
      if (!this.cellCtx.fillStyle || this.cellCtx.fillStyle === '#000000') {
        this.cellCtx.fillStyle = '#E6E8EE';
      }
    }
    if (this.cursorCtx) {
      this.cursorCtx.font = this.fontString;
      this.cursorCtx.textBaseline = 'alphabetic';
    }
  }

  /**
   * Attach one-shot `document.fonts.ready` + long-lived `visibilitychange`
   * listeners. Both flows converge on `refreshFontState` which drops the
   * atlas and rewrites `ctx.font` so the next paint renders with the mono
   * stack instead of the Canvas2D default sans-serif.
   *
   * This path covers the tab-switch repro: web fonts that loaded while the
   * tab was backgrounded never triggered a re-raster, so the first frame
   * after refocus displayed in the fallback font until user input nudged
   * the renderer again.
   */
  private wireFontAndVisibilityListeners(): void {
    if (typeof document === 'undefined') return;
    // Fonts-ready — one-shot promise resolved once the browser has loaded
    // every font the document references. We explicitly probe `JetBrains
    // Mono` via `document.fonts.load` since `.ready` resolves even if
    // individual faces 404.
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts) {
      const probeAndRefresh = () => this.refreshFontState('fonts_ready');
      try {
        // Probe the primary face at the current cell size. `load()` returns
        // a Promise that rejects if the font is unavailable; we still
        // refresh on rejection because metrics may have changed and we want
        // the context state reapplied.
        void fonts
          .load(`12px 'JetBrains Mono'`)
          .then(probeAndRefresh, probeAndRefresh);
      } catch {
        // Legacy browsers w/o FontFaceSet.load — skip the probe, still rely
        // on `.ready`.
      }
      if (fonts.ready && typeof fonts.ready.then === 'function') {
        fonts.ready.then(probeAndRefresh, probeAndRefresh);
      }
    }
    // Visibility — fires on tab blur/focus. Chromium under Tauri sometimes
    // resets paint state on refocus; even when it doesn't, rAF is throttled
    // while hidden so a pending invalidation may have stalled. Force a
    // refresh on return.
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        this.refreshFontState('visibility_refresh');
      }
    };
    document.addEventListener('visibilitychange', onVis);
    this.disposers.push(() => {
      document.removeEventListener('visibilitychange', onVis);
    });
  }

  /**
   * Drop the atlas, reapply context font state, and trigger the upstream
   * invalidation hook so the Renderer schedules a full re-raster on the
   * next rAF. Idempotent.
   */
  private refreshFontState(reason: 'fonts_ready' | 'visibility_refresh'): void {
    this.fontString = buildFontString(this.metrics.cellHeightPx, this.fontOverride);
    this.applyContextState();
    this.atlas?.invalidateAll('font_load_complete');
    this.invalidationHook?.();
    this.paintLog.push({ kind: reason });
  }

  /**
   * Update the user-selected font family + feature string. Called by the
   * font-settings feature whenever the store changes. Invalidates the glyph
   * atlas so the next paint re-rasters every cell with the new face, and
   * fires the upstream invalidation hook so the Renderer schedules a frame.
   *
   * A `null` override clears any prior selection and falls back to the
   * canonical `TERMINAL_FONT_STACK`. Passing the same override as before is
   * a cheap no-op so repeated notifications don't flood the render loop.
   */
  _setFontOverride(override: FontOverride | null): void {
    const prev = this.fontOverride;
    if (prev && override && prev.family === override.family && prev.features === override.features) {
      return;
    }
    if (!prev && !override) return;
    this.fontOverride = override;
    this.fontString = buildFontString(this.metrics.cellHeightPx, this.fontOverride);
    this.applyContextState();
    this.atlas?.invalidateAll('font_load_complete');
    this.invalidationHook?.();
  }

  /** @internal Test-only accessor for the synthesized font shorthand. */
  _fontString(): string {
    return this.fontString;
  }

  applyGridSnapshot(rows: readonly Row[], cursor: CursorState | null, mode: TerminalModeState): void {
    this.gridRows = rows.length;
    this.gridCols = rows[0]?.cells.length ?? 0;
    this.mode = mode;
    if (this.cellCtx && this.cellCanvas) {
      this.cellCtx.clearRect(0, 0, this.cellCanvas.width, this.cellCanvas.height);
      // A full snapshot re-rasters every row (same path as applyGridDelta
      // without the dirty-row restriction).
      this.paintRows(rows);
    }
    if (cursor) this.applyCursor(cursor);
    this.paintLog.push({ kind: 'snapshot', rows: rows.length });
  }

  applyGridDelta(rows: readonly Row[], _dirtyRows: DamageSet): void {
    if (this.cellCtx) this.paintRows(rows);
    this.paintLog.push({ kind: 'delta', rows: rows.length });
  }

  applyCursor(cursor: CursorState | null): void {
    if (this.cursorCtx && this.cursorCanvas) {
      this.cursorCtx.clearRect(0, 0, this.cursorCanvas.width, this.cursorCanvas.height);
      if (cursor && cursor.visible) {
        const { cellWidthPx, cellHeightPx } = this.metrics;
        this.cursorCtx.fillStyle = this.cursorCtx.fillStyle || '#ffffff';
        this.cursorCtx.fillRect(
          cursor.col * cellWidthPx,
          cursor.row * cellHeightPx,
          cellWidthPx,
          cellHeightPx,
        );
      }
    }
    this.paintLog.push({ kind: 'cursor', cursorVisible: cursor?.visible ?? false });
  }

  applyMode(mode: TerminalModeState): void {
    this.mode = mode;
    this.paintLog.push({ kind: 'mode' });
  }

  applyMetrics(metrics: CellMetrics, dpr: number): void {
    this.metrics = metrics;
    this.dpr = dpr;
    this.atlas?.invalidateAll('dpr_change');
    this.atlas?.applyMetrics(metrics);
    // Metrics drive font size. Recompute the shorthand and reapply so
    // subsequent fillText calls honor the new cell height.
    this.fontString = buildFontString(metrics.cellHeightPx, this.fontOverride);
    this.applyContextState();
    this.paintLog.push({ kind: 'metrics' });
  }

  requestDamageFlush(): void {
    this.paintLog.push({ kind: 'flush' });
  }

  applySearchHighlights(
    highlights: readonly SearchHighlight[],
    scrollbackTop: number,
  ): void {
    // Paint into the overlay layer (DOM-based) rather than a dedicated
    // canvas. The overlay layer is already positioned absolute over the
    // grid; we reuse the existing `quanta-search-hit` span pattern so
    // there is no third canvas to manage. For the Canvas2D prototype an
    // absolute-positioned div per match is fine — hit counts are bounded
    // by `DEFAULT_MAX_RESULTS` and interactive search typically yields a
    // few hundred rectangles at most.
    //
    // Clear any previous highlight nodes first (we tag them with a
    // data-attr so the selector is narrow — IME overlays use a different
    // class and stay put).
    if (this.overlayLayer) {
      const existing = this.overlayLayer.querySelectorAll<HTMLElement>(
        '[data-search-highlight="true"]',
      );
      for (let i = 0; i < existing.length; i += 1) {
        const el = existing.item(i);
        el?.parentElement?.removeChild(el);
      }
      const { cellWidthCssPx: cw, cellHeightCssPx: ch } = this.metrics;
      for (const hit of highlights) {
        const viewportRow = hit.rowId - scrollbackTop;
        if (viewportRow < 0 || viewportRow >= this.gridRows) continue;
        const span = document.createElement('span');
        span.setAttribute('data-search-highlight', 'true');
        if (hit.current) span.setAttribute('data-current', 'true');
        const widthCells = Math.max(1, hit.endColExclusive - hit.startCol);
        Object.assign(span.style, {
          position: 'absolute',
          left: `${hit.startCol * cw}px`,
          top: `${viewportRow * ch}px`,
          width: `${widthCells * cw}px`,
          height: `${ch}px`,
          pointerEvents: 'none',
          background: hit.current
            ? 'rgba(255, 176, 0, 0.55)'
            : 'rgba(255, 236, 120, 0.35)',
          boxShadow: hit.current ? '0 0 0 1px rgba(255, 176, 0, 0.9)' : 'none',
          borderRadius: '1px',
        } as CSSStyleDeclaration);
        this.overlayLayer.appendChild(span);
      }
    }
    this.paintLog.push({ kind: 'search_highlights', highlightCount: highlights.length });
  }

  measureText(text: string, attrsVariant: number): TextMeasurement {
    // Width via SSOT — sum the width of each grapheme cluster.
    const classified = this.classifier.classifyStr(text);
    let cells = 0;
    for (const c of classified) {
      cells += c.width === 'zero' ? 0 : c.width === 'two' ? 2 : 1;
    }
    void attrsVariant;
    return { widthPx: cells * this.metrics.cellWidthPx, cellsWide: cells };
  }

  mountOverlay(anchor: IMEOverlayAnchor, text: string): OverlayHandle {
    const handle = { id: Symbol('overlay') };
    if (this.overlayLayer) {
      const el = document.createElement('span');
      el.className = 'quanta-ime-overlay';
      el.textContent = text;
      Object.assign(el.style, {
        position: 'absolute',
        left: `${anchor.col * anchor.metrics.cellWidthCssPx}px`,
        top: `${anchor.row * anchor.metrics.cellHeightCssPx}px`,
        textDecoration: 'underline',
        pointerEvents: 'none',
      } as CSSStyleDeclaration);
      this.overlayLayer.appendChild(el);
      this.overlays.set(handle.id, { anchor, el });
    } else {
      this.overlays.set(handle.id, {
        anchor,
        el: document.createElement('span'),
      });
    }
    this.paintLog.push({ kind: 'overlay_mount' });
    return handle;
  }

  updateOverlay(handle: OverlayHandle, text: string): void {
    const entry = this.overlays.get(handle.id);
    if (!entry) return;
    entry.el.textContent = text;
    this.paintLog.push({ kind: 'overlay_update' });
  }

  unmountOverlay(handle: OverlayHandle): void {
    const entry = this.overlays.get(handle.id);
    if (!entry) return;
    entry.el.parentElement?.removeChild(entry.el);
    this.overlays.delete(handle.id);
    this.paintLog.push({ kind: 'overlay_unmount' });
  }

  screenToCell(xCssPx: number, yCssPx: number): ScreenHit | null {
    if (xCssPx < 0 || yCssPx < 0) return null;
    const { cellWidthCssPx: cw, cellHeightCssPx: ch } = this.metrics;
    const row = Math.floor(yCssPx / ch);
    const col = Math.floor(xCssPx / cw);
    if (row >= this.gridRows || col >= this.gridCols) return null;
    return { row, col, hyperlinkId: null };
  }

  cellToScreen(row: number, col: number): Rect {
    const { cellWidthCssPx: cw, cellHeightCssPx: ch } = this.metrics;
    return { x: col * cw, y: row * ch, width: cw, height: ch };
  }

  unmount(): void {
    for (const { el } of this.overlays.values()) {
      el.parentElement?.removeChild(el);
    }
    this.overlays.clear();
    // Flush font / visibility disposers.
    for (const d of this.disposers) {
      try {
        d();
      } catch {
        // Swallow — DOM may already be torn down.
      }
    }
    this.disposers = [];
    if (this.container) {
      if (this.cellCanvas && this.cellCanvas.parentElement === this.container) {
        this.container.removeChild(this.cellCanvas);
      }
      if (this.cursorCanvas && this.cursorCanvas.parentElement === this.container) {
        this.container.removeChild(this.cursorCanvas);
      }
      if (this.overlayLayer && this.overlayLayer.parentElement === this.container) {
        this.container.removeChild(this.overlayLayer);
      }
    }
    this.cellCanvas = null;
    this.cursorCanvas = null;
    this.overlayLayer = null;
    this.cellCtx = null;
    this.cursorCtx = null;
    this.atlas = null;
    this.container = null;
    this.invalidationHook = null;
    this.paintLog.push({ kind: 'unmount' });
  }

  /**
   * Register an invalidation hook. Called by the renderer wiring so that a
   * late font-load or tab-refocus can request a fresh rAF tick. Safe to
   * call more than once; the latest hook wins. The hook is cleared on
   * unmount.
   */
  _setInvalidationHook(hook: (() => void) | null): void {
    this.invalidationHook = hook;
  }

  /** @internal Test-only: the ordered record of backend operations. */
  _paintLog(): readonly PaintEvent[] {
    return this.paintLog;
  }

  /** @internal Test-only: last DPR applied. */
  _dpr(): number {
    return this.dpr;
  }

  /** @internal Test-only: last mode snapshot held. */
  _mode(): TerminalModeState {
    return this.mode;
  }

  private paintRows(rows: readonly Row[]): void {
    const ctx = this.cellCtx;
    if (!ctx) return;
    // Defensive: re-apply font state every paint. The cost (a single
    // property write) is negligible next to the per-glyph `fillText` cost,
    // and it immunizes the paint loop against state drift — e.g., a
    // resize of canvas.width which resets ctx state, or a Chromium/Tauri
    // WebView edge case after visibilitychange.
    if (ctx.font !== this.fontString) {
      ctx.font = this.fontString;
      ctx.textBaseline = 'alphabetic';
    }
    const { cellWidthPx, cellHeightPx } = this.metrics;
    for (const row of rows) {
      if (!row) continue;
      const rowIndex = rows.indexOf(row); // snapshot-order fallback
      const y = rowIndex * cellHeightPx;
      ctx.clearRect(0, y, cellWidthPx * (row.cells.length || 0), cellHeightPx);
      let x = 0;
      for (const cell of row.cells) {
        if (cell.grapheme) {
          if (ctx.fillText) ctx.fillText(cell.grapheme, x, y + this.metrics.baselineOffsetPx);
        }
        x += cellWidthPx;
      }
    }
  }
}

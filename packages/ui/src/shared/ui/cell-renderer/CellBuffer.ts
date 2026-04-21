/**
 * CellBuffer — the renderer's local, cache-friendly mirror of the grid.
 *
 * Responsibilities:
 *   - Subscribe to a `MirrorSource` (backed by `GridMirror.onChange`) and
 *     translate dirty-row signals into local `DamageSet` updates.
 *   - Store cells in a packed `Uint32Array` for fast row iteration.
 *   - Expose `getCell(row, col)` for unpacked random access (`HitTest`,
 *     `Selection.copy`).
 *   - Resource hygiene: `dispose()` tears down the subscription so there
 *     are no dangling handlers at widget unmount. Verified by
 *     `CellBuffer.test.ts` leak test (DoD-D-11).
 *
 * Invariants:
 *   - I-3: the buffer mirrors the grid. Any derived state (attrsVariant)
 *     is a layout optimization — callers that care about semantics go
 *     to the underlying `Cell` via `getCell`.
 *   - I-4: widths for cells come from `Cell.cols` (set by the reducer from
 *     the wire, which is itself the width-SSOT output). The buffer never
 *     re-derives width from code points.
 *
 * PackedCell u32 layout (MSB-first):
 *   bit 31..24 (8 bits) — attrs bitflags
 *     bit 7 bold, bit 6 italic, bit 5 underline, bit 4 blink, bit 3 inverse,
 *     bit 2 strike, bit 1 faint, bit 0 double-underline
 *   bit 23..18 (6 bits) — fg palette idx or top-6 bits of RGB approximation
 *   bit 17..12 (6 bits) — bg palette idx or top-6 bits of RGB approximation
 *   bit 11..10 (2 bits) — fg color kind (0 default, 1 p8, 2 p256, 3 truecolor)
 *   bit  9..8  (2 bits) — bg color kind
 *   bit  7..0  (8 bits) — grapheme-table id (0 = blank, 255 reserved for
 *                         "lookup in extended grapheme table")
 *
 * Precise truecolor RGB lives in `trueColorMap: Map<cellIndex, {fg, bg}>`;
 * hyperlink id + underline color live in `extMap`.
 */

import type { Row } from '../../lib/grid-mirror/types.js';
import { DamageSet } from './DamageSet.js';
import type { MirrorSource } from './MirrorSource.js';

/** Reserved grapheme-table id for the blank cell. */
const BLANK_ID = 0;
/** Sentinel id escape → the real id lives in `extGraphemes`. Keeps the
 *  8-bit grapheme field viable for the hot path while supporting very
 *  large distinct-grapheme counts. */
const EXT_GRAPHEME_ID = 0xff;

export type PackedCell = number;

export interface AttrFlags {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly blink: boolean;
  readonly inverse: boolean;
  readonly strike: boolean;
  readonly faint: boolean;
  readonly doubleUnderline: boolean;
}

export const DEFAULT_ATTRS: AttrFlags = Object.freeze({
  bold: false,
  italic: false,
  underline: false,
  blink: false,
  inverse: false,
  strike: false,
  faint: false,
  doubleUnderline: false,
});

/** Bit positions for attr flags within the top byte of the packed cell. */
export const ATTR_BIT = Object.freeze({
  bold: 7,
  italic: 6,
  underline: 5,
  blink: 4,
  inverse: 3,
  strike: 2,
  faint: 1,
  doubleUnderline: 0,
});

export type ColorKind = 'default' | 'palette8' | 'palette256' | 'truecolor';

export interface Color {
  readonly kind: ColorKind;
  /** Palette index (0..255 for p256, 0..15 for p8) or 0 for default/truecolor. */
  readonly palette: number;
  /** 24-bit RGB value for `kind === 'truecolor'`; 0 otherwise. */
  readonly rgb: number;
}

export const DEFAULT_COLOR: Color = Object.freeze({ kind: 'default', palette: 0, rgb: 0 });

export interface UnpackedCell {
  readonly grapheme: string;
  readonly cols: 1 | 2;
  readonly fg: Color;
  readonly bg: Color;
  readonly attrs: AttrFlags;
  readonly hyperlinkId: number | null;
}

/** Encode attr flags into the top byte. */
export function encodeAttrs(a: AttrFlags): number {
  let v = 0;
  if (a.bold) v |= 1 << ATTR_BIT.bold;
  if (a.italic) v |= 1 << ATTR_BIT.italic;
  if (a.underline) v |= 1 << ATTR_BIT.underline;
  if (a.blink) v |= 1 << ATTR_BIT.blink;
  if (a.inverse) v |= 1 << ATTR_BIT.inverse;
  if (a.strike) v |= 1 << ATTR_BIT.strike;
  if (a.faint) v |= 1 << ATTR_BIT.faint;
  if (a.doubleUnderline) v |= 1 << ATTR_BIT.doubleUnderline;
  return v & 0xff;
}

/** Decode attr flags from the top byte. */
export function decodeAttrs(byte: number): AttrFlags {
  return {
    bold: (byte & (1 << ATTR_BIT.bold)) !== 0,
    italic: (byte & (1 << ATTR_BIT.italic)) !== 0,
    underline: (byte & (1 << ATTR_BIT.underline)) !== 0,
    blink: (byte & (1 << ATTR_BIT.blink)) !== 0,
    inverse: (byte & (1 << ATTR_BIT.inverse)) !== 0,
    strike: (byte & (1 << ATTR_BIT.strike)) !== 0,
    faint: (byte & (1 << ATTR_BIT.faint)) !== 0,
    doubleUnderline: (byte & (1 << ATTR_BIT.doubleUnderline)) !== 0,
  };
}

function colorKindCode(kind: ColorKind): number {
  switch (kind) {
    case 'default':
      return 0;
    case 'palette8':
      return 1;
    case 'palette256':
      return 2;
    case 'truecolor':
      return 3;
  }
}

function codeToColorKind(code: number): ColorKind {
  switch (code & 0b11) {
    case 0:
      return 'default';
    case 1:
      return 'palette8';
    case 2:
      return 'palette256';
    default:
      return 'truecolor';
  }
}

/** Parse the `sgr` hex string ("0x000000000000002F" etc.) into fg/bg/attrs.
 *  The upstream engine encodes SGR into a u64; we consume the top-level
 *  attrs byte + two 16-bit color halves. Exact layout is defined in
 *  `crates/quanta-block/src/domain/reducer.rs`. We keep the parser
 *  tolerant: unknown bits are ignored, zero-length hex is treated as
 *  default attrs. */
export function parseSgr(sgr: string): { attrs: AttrFlags; fg: Color; bg: Color } {
  if (!sgr || sgr.length < 2) return { attrs: DEFAULT_ATTRS, fg: DEFAULT_COLOR, bg: DEFAULT_COLOR };
  const hex = sgr.startsWith('0x') || sgr.startsWith('0X') ? sgr.slice(2) : sgr;
  // Left-pad to 16 chars for consistent bit slicing.
  const padded = hex.padStart(16, '0');
  // Top byte → attrs. Middle 16 bits each → fg/bg.
  const attrsByte = parseInt(padded.slice(0, 2), 16) || 0;
  const fgKindBits = (parseInt(padded.slice(2, 4), 16) >>> 6) & 0b11;
  const bgKindBits = (parseInt(padded.slice(2, 4), 16) >>> 4) & 0b11;
  const fgPalette = parseInt(padded.slice(4, 6), 16) || 0;
  const bgPalette = parseInt(padded.slice(6, 8), 16) || 0;
  const fgRgb = parseInt(padded.slice(8, 14), 16) || 0;
  const bgRgb = parseInt(padded.slice(10, 16), 16) || 0;
  const fg: Color = {
    kind: codeToColorKind(fgKindBits),
    palette: fgPalette & 0xff,
    rgb: fgRgb & 0xffffff,
  };
  const bg: Color = {
    kind: codeToColorKind(bgKindBits),
    palette: bgPalette & 0xff,
    rgb: bgRgb & 0xffffff,
  };
  return { attrs: decodeAttrs(attrsByte), fg, bg };
}

/** Reverse of `parseSgr` — builds the deterministic hex string for tests. */
export function formatSgr(attrs: AttrFlags, fg: Color, bg: Color): string {
  const attrsByte = encodeAttrs(attrs);
  const kindByte = ((colorKindCode(fg.kind) & 0b11) << 6) | ((colorKindCode(bg.kind) & 0b11) << 4);
  const fgPal = fg.palette & 0xff;
  const bgPal = bg.palette & 0xff;
  const fgRgb = fg.rgb & 0xffffff;
  const bgRgb = bg.rgb & 0xffffff;
  // Concatenate: attrsByte|kindByte|fgPal|bgPal|fgRgb(3B)|bgRgb(3B trimmed to 2)
  // The exact layout reserves 2 bytes for bgRgb; our parse uses slice(10,16).
  const hex =
    attrsByte.toString(16).padStart(2, '0') +
    kindByte.toString(16).padStart(2, '0') +
    fgPal.toString(16).padStart(2, '0') +
    bgPal.toString(16).padStart(2, '0') +
    fgRgb.toString(16).padStart(6, '0') +
    (bgRgb & 0xffff).toString(16).padStart(4, '0');
  return `0x${hex.padEnd(16, '0').slice(0, 16).toUpperCase()}`;
}

/**
 * A grid-space search highlight, as emitted by
 * `features/output-search/scrollback-search.searchGrid`.
 *
 * `rowId` is the absolute scrollback/viewport row id. The CellBuffer's own
 * internal rows address the live viewport only (0..rows_-1) — the
 * translation from an absolute `rowId` to a viewport-local `row` is the
 * responsibility of the Renderer / consumer; the buffer just holds on to
 * the raw list so a single source of truth drives paint.
 */
export interface SearchHighlight {
  readonly rowId: number;
  readonly startCol: number;
  readonly endColExclusive: number;
  /** Set on the single hit that is the user's "current" selection so the
   *  Renderer can paint it with emphasis (orange vs. yellow underlay). */
  readonly current?: boolean;
}

export class CellBuffer {
  private buf = new Uint32Array(0);
  private rows_ = 0;
  private cols_ = 0;
  /**
   * Grid-space search highlights pushed in from the FindPanel widget.
   * Stored verbatim — no viewport translation here; the Renderer handles
   * that on paint. Empty when no search is active. The reference itself
   * is swapped on each `setSearchHighlights` call so consumers can use
   * identity equality to short-circuit redundant repaints.
   */
  private searchHighlights_: readonly SearchHighlight[] = [];
  /**
   * Absolute rowId of the first row in the live viewport. The Renderer reads
   * this when forwarding highlights to the backend so the backend can
   * translate `highlight.rowId` → viewport-local row in O(1). Defaults to
   * 0; the FindPanel wiring writes `scrollback.baseRowId + scrollback.rows.length`
   * whenever it pushes fresh highlights, and the VtEmulator's scroll
   * events drive updates while a search is active.
   */
  private scrollbackTop_ = 0;

  /** Grapheme interning — maps string → id (0..253). id 254 reserved. id 255 = EXT escape. */
  private readonly graphemeIndex = new Map<string, number>();
  private readonly graphemeTable: string[] = [''];
  /** Overflow graphemes stored by cellIndex when the hot-path id space is exhausted. */
  private readonly extGraphemes = new Map<number, string>();

  /** Sparse truecolor storage keyed by cellIndex. */
  private readonly trueColorMap = new Map<number, { fg: number; bg: number }>();
  /** Per-cell ext map: hyperlink id, underline color. */
  private readonly extMap = new Map<
    number,
    { hyperlinkId?: number; underlineColor?: number; cols?: number }
  >();
  /** Per-row `continuation` flag. */
  private readonly continuation: boolean[] = [];
  /** Per-row frozen marker (scrollback — no further writes once frozen). */
  private readonly frozenRows = new Set<number>();
  /** Dirty-row damage; drained by the renderer each rAF. */
  private readonly damage = new DamageSet();

  private subscription: (() => void) | null;

  constructor(source: MirrorSource, initial?: { rows: number; cols: number }) {
    this.subscription = source.subscribe(this.onMirrorChange);
    if (initial) this.resize(initial.rows, initial.cols);
  }

  /** Current dimensions. */
  dimensions(): { rows: number; cols: number } {
    return { rows: this.rows_, cols: this.cols_ };
  }

  /** Resize the buffer. Preserves existing cells in the common rows×cols
   *  range; grows or trims otherwise. Clears all damage. */
  resize(rows: number, cols: number): void {
    if (rows === this.rows_ && cols === this.cols_) return;
    const next = new Uint32Array(rows * cols);
    // Keep overlap in the top-left.
    const copyRows = Math.min(rows, this.rows_);
    const copyCols = Math.min(cols, this.cols_);
    for (let r = 0; r < copyRows; r += 1) {
      for (let c = 0; c < copyCols; c += 1) {
        next[r * cols + c] = this.buf[r * this.cols_ + c] ?? 0;
      }
    }
    // Extend continuation flags.
    while (this.continuation.length < rows) this.continuation.push(false);
    this.continuation.length = rows;
    // Dropped-row side-tables cleanup.
    if (rows < this.rows_ || cols < this.cols_) {
      const maxIndex = rows * cols;
      for (const k of [...this.trueColorMap.keys()]) {
        if (k >= maxIndex) this.trueColorMap.delete(k);
      }
      for (const k of [...this.extMap.keys()]) {
        if (k >= maxIndex) this.extMap.delete(k);
      }
      for (const k of [...this.extGraphemes.keys()]) {
        if (k >= maxIndex) this.extGraphemes.delete(k);
      }
      for (const r of [...this.frozenRows]) {
        if (r >= rows) this.frozenRows.delete(r);
      }
    }
    this.buf = next;
    this.rows_ = rows;
    this.cols_ = cols;
    this.damage.reset();
    for (let r = 0; r < rows; r += 1) this.damage.addRow(r);
  }

  /** Freeze a row — subsequent writes to it are ignored. Used for scrollback
   *  after the row has been displaced off the main grid. */
  freezeRow(row: number): void {
    this.frozenRows.add(row);
  }

  /** Is a row currently frozen? */
  isFrozen(row: number): boolean {
    return this.frozenRows.has(row);
  }

  /** Write a `Row` into the buffer at `row`. No-op when frozen. */
  writeRow(row: number, src: Row): void {
    if (row < 0 || row >= this.rows_) return;
    if (this.frozenRows.has(row)) return;
    const cols = this.cols_;
    for (let c = 0; c < cols; c += 1) {
      const cell = src.cells[c];
      const idx = row * cols + c;
      if (!cell) {
        this.buf[idx] = 0;
        this.clearExt(idx);
        continue;
      }
      const { attrs, fg, bg } = parseSgr(cell.sgr);
      const gid = this.internGrapheme(idx, cell.grapheme);
      const attrsByte = encodeAttrs(attrs);
      const fgKind = colorKindCode(fg.kind) & 0b11;
      const bgKind = colorKindCode(bg.kind) & 0b11;
      // 6-bit palette / rgb-high approximation.
      const fgHigh6 =
        fg.kind === 'truecolor' ? (fg.rgb >>> 18) & 0b111111 : fg.palette & 0b111111;
      const bgHigh6 =
        bg.kind === 'truecolor' ? (bg.rgb >>> 18) & 0b111111 : bg.palette & 0b111111;
      const packed =
        ((attrsByte & 0xff) << 24) |
        ((fgHigh6 & 0b111111) << 18) |
        ((bgHigh6 & 0b111111) << 12) |
        ((fgKind & 0b11) << 10) |
        ((bgKind & 0b11) << 8) |
        (gid & 0xff);
      // Store packed value as unsigned.
      this.buf[idx] = packed >>> 0;

      // Side-tables.
      if (fg.kind === 'truecolor' || bg.kind === 'truecolor') {
        this.trueColorMap.set(idx, { fg: fg.rgb, bg: bg.rgb });
      } else if (this.trueColorMap.has(idx)) {
        this.trueColorMap.delete(idx);
      }
      const hyperlinkId = cell.hyperlink_id && cell.hyperlink_id > 0 ? cell.hyperlink_id : undefined;
      const underlineColor = cell.ext?.underline_color ?? undefined;
      const needsExt =
        hyperlinkId !== undefined || underlineColor !== undefined || cell.cols !== 1;
      if (needsExt) {
        const extEntry: { hyperlinkId?: number; underlineColor?: number; cols?: number } = {
          cols: cell.cols,
        };
        if (hyperlinkId !== undefined) extEntry.hyperlinkId = hyperlinkId;
        if (underlineColor !== undefined && underlineColor !== null) {
          extEntry.underlineColor = underlineColor;
        }
        this.extMap.set(idx, extEntry);
      } else if (this.extMap.has(idx)) {
        this.extMap.delete(idx);
      }
    }
    this.continuation[row] = src.continuation;
    this.damage.addRow(row);
  }

  /** Apply a full row array (snapshot).
   *
   * The snapshot is authoritative for both dimensions: a shrink in either
   * axis must take effect so the buffer and the upstream `GridMirror` stay
   * in lock-step (otherwise `getCell` out-of-bounds guards diverge and the
   * renderer can paint residue beyond the new cols). Column count is
   * derived from the first row's `cells.length`; if that is `0` (a stray
   * empty row carried by a corner-case snapshot) we fall back to the
   * existing column count to avoid wiping the buffer. */
  writeSnapshot(rows: readonly Row[]): void {
    const nextRows = rows.length;
    const observedCols = rows[0]?.cells.length ?? 0;
    // If rows is non-empty, trust the row's own cols as the authoritative
    // column count (including shrinks). If rows is empty, keep the existing
    // cols so we don't blow away the width on a no-op snapshot.
    const nextCols = nextRows > 0 ? observedCols : this.cols_;
    if (nextRows !== this.rows_ || nextCols !== this.cols_) {
      this.resize(nextRows, nextCols);
    }
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r];
      if (row) this.writeRow(r, row);
    }
  }

  /** Access a row's packed view. */
  getRowCells(row: number): { packed: Uint32Array; continuation: boolean } {
    if (row < 0 || row >= this.rows_) {
      return { packed: new Uint32Array(0), continuation: false };
    }
    const start = row * this.cols_;
    return {
      packed: this.buf.subarray(start, start + this.cols_),
      continuation: this.continuation[row] ?? false,
    };
  }

  /** Fully unpacked cell — hot path for hit-test, copy, search. */
  getCell(row: number, col: number): UnpackedCell | null {
    if (row < 0 || row >= this.rows_ || col < 0 || col >= this.cols_) return null;
    const idx = row * this.cols_ + col;
    const packed = this.buf[idx] ?? 0;
    const attrsByte = (packed >>> 24) & 0xff;
    const fgKind = codeToColorKind((packed >>> 10) & 0b11);
    const bgKind = codeToColorKind((packed >>> 8) & 0b11);
    const fgHigh6 = (packed >>> 18) & 0b111111;
    const bgHigh6 = (packed >>> 12) & 0b111111;
    const gid = packed & 0xff;
    const grapheme = gid === EXT_GRAPHEME_ID
      ? this.extGraphemes.get(idx) ?? ''
      : this.graphemeTable[gid] ?? '';
    const trueColor = this.trueColorMap.get(idx);
    const fg: Color = {
      kind: fgKind,
      palette: fgHigh6 & 0xff,
      rgb: fgKind === 'truecolor' ? trueColor?.fg ?? ((fgHigh6 << 18) & 0xffffff) : 0,
    };
    const bg: Color = {
      kind: bgKind,
      palette: bgHigh6 & 0xff,
      rgb: bgKind === 'truecolor' ? trueColor?.bg ?? ((bgHigh6 << 18) & 0xffffff) : 0,
    };
    const ext = this.extMap.get(idx);
    const cols: 1 | 2 = ext?.cols === 2 ? 2 : 1;
    return {
      grapheme,
      cols,
      fg,
      bg,
      attrs: decodeAttrs(attrsByte),
      hyperlinkId: ext?.hyperlinkId ?? null,
    };
  }

  /** Is the row tagged continuation? */
  isContinuation(row: number): boolean {
    if (row < 0 || row >= this.rows_) return false;
    return this.continuation[row] ?? false;
  }

  /**
   * Publish the latest grid-space search highlights. Replaces the entire
   * list; empty clears. Marks the overlay dirty so the Renderer repaints
   * on the next rAF tick. The list is stored by reference — callers MUST
   * NOT mutate `highlights` after handing it off.
   */
  setSearchHighlights(highlights: readonly SearchHighlight[]): void {
    if (highlights === this.searchHighlights_) return;
    this.searchHighlights_ = highlights;
    this.damage.markOverlayDirty();
  }

  /** Current grid-space search highlights (empty when no search is active). */
  getSearchHighlights(): readonly SearchHighlight[] {
    return this.searchHighlights_;
  }

  /**
   * Set the absolute `rowId` of the first live-viewport row. Paired with
   * `setSearchHighlights`; backends translate each highlight's absolute
   * rowId to a viewport-local row using this anchor. Does not mark the
   * overlay dirty on its own — we treat scrollback growth as a signal
   * carried by the next highlight push.
   */
  setScrollbackTop(rowId: number): void {
    this.scrollbackTop_ = rowId;
  }

  /** Current scrollback-top anchor (see `setScrollbackTop`). */
  getScrollbackTop(): number {
    return this.scrollbackTop_;
  }

  /** Drain damage — called by the Renderer on each rAF tick. */
  drainDamage(): DamageSet {
    const drained = new DamageSet();
    for (const r of this.damage.rowArray()) drained.addRow(r);
    if (this.damage.cursorDirty) drained.markCursorDirty();
    if (this.damage.overlayDirty) drained.markOverlayDirty();
    this.damage.reset();
    return drained;
  }

  /** Read the current damage without resetting. */
  peekDamage(): DamageSet {
    return this.damage;
  }

  /** Release subscription. Idempotent. */
  dispose(): void {
    if (this.subscription) {
      this.subscription();
      this.subscription = null;
    }
    this.buf = new Uint32Array(0);
    this.trueColorMap.clear();
    this.extMap.clear();
    this.extGraphemes.clear();
    this.continuation.length = 0;
    this.frozenRows.clear();
    this.graphemeIndex.clear();
    this.graphemeTable.length = 1; // keep blank
    this.searchHighlights_ = [];
    this.scrollbackTop_ = 0;
  }

  /** @internal Test-only: how many unique graphemes are interned? */
  graphemeTableSize(): number {
    return this.graphemeTable.length;
  }

  private readonly onMirrorChange = (dirty: ReadonlySet<number>): void => {
    for (const r of dirty) this.damage.addRow(r);
  };

  private internGrapheme(cellIdx: number, g: string): number {
    if (!g) {
      this.extGraphemes.delete(cellIdx);
      return BLANK_ID;
    }
    const existing = this.graphemeIndex.get(g);
    if (existing !== undefined) {
      this.extGraphemes.delete(cellIdx);
      return existing;
    }
    if (this.graphemeTable.length < EXT_GRAPHEME_ID) {
      const id = this.graphemeTable.length;
      this.graphemeTable.push(g);
      this.graphemeIndex.set(g, id);
      this.extGraphemes.delete(cellIdx);
      return id;
    }
    // Overflow — stash in extGraphemes keyed by cellIndex.
    this.extGraphemes.set(cellIdx, g);
    return EXT_GRAPHEME_ID;
  }

  private clearExt(idx: number): void {
    if (this.trueColorMap.has(idx)) this.trueColorMap.delete(idx);
    if (this.extMap.has(idx)) this.extMap.delete(idx);
    if (this.extGraphemes.has(idx)) this.extGraphemes.delete(idx);
  }
}

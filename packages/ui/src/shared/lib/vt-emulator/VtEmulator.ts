/**
 * `VtEmulator` — byte-level VT100/xterm subset emulator that maintains a
 * 2D cell grid and emits `GridEventEnvelope<GridPayload>` updates shaped
 * for `GridMirror`.
 *
 * Why a second parser (alongside `shared/lib/ansi-parser`)?
 *
 *   - `ansi-parser` produces a *linear span stream* — every character is
 *     appended to a growing text buffer. That's correct for scroll-back
 *     logs but fails the moment an app does cursor addressing: `vim` erasing
 *     a line (`\x1b[K`) or `htop` re-drawing in place looks like noise.
 *   - `VtEmulator` keeps a real rows×cols grid, applies CSI ops to the grid,
 *     then diffs each feed against the previous state to produce `RowDelta`s
 *     and cursor moves. That gives us byte-exact correctness for full-screen
 *     TUI apps.
 *
 * Scope intentionally matches the *mission CSI matrix*; everything outside
 * that set is either no-op'd (alt-screen flip, DECSCUSR soft-cursor, etc.)
 * or silently dropped with state stable. DCS / APC / PM payloads are
 * swallowed to their ST terminator. See the README comment for the gap list.
 *
 * Stream robustness:
 *   - UTF-8 multi-byte split across `feed()` calls uses `TextDecoder` with
 *     `{ stream: true }` — identical approach to `AnsiParser`.
 *   - Invalid CSI (stray `;`, unknown final byte) is dropped; the FSM returns
 *     to `Ground` with the pending param list discarded. Real terminals do
 *     the same.
 *
 * Envelope emit:
 *   - Initial construction and `resize()` emit `grid_snapshot` (single row_deltas
 *     array covering every row).
 *   - Every `feed()` batch computes a *dirty-row set*; if non-empty, a
 *     `grid_delta` envelope with only the changed rows is emitted. Cursor-only
 *     feeds emit `cursor_moved`.
 *   - `sequence_no` is monotonic per instance and reset on `reset()`.
 *   - `resize_generation` bumps per `resize()`.
 *
 * The emulator does NOT own scrollback, hyperlinks, clipboard, title, or
 * bell events. Those layers are separate; here we only model the screen
 * + cursor + SGR state so `GridMirror` + `CellBuffer` render correctly.
 */

import type { AnsiColor } from '../../ui/ansi-output/types.js';
import { DefaultClassifier } from '../width/classifier.js';
import type {
  CellSpan,
  CursorState,
  GridDeltaPayload,
  GridEventEnvelope,
  GridPayload,
  GridSnapshotPayload,
  CursorMovedPayload,
  RowDelta,
  TerminalModeState,
} from '../grid-mirror/types.js';
import {
  blankCell,
  blankCellWithSgr,
  defaultSgr,
  type InternalCell,
  type InternalCursor,
  type InternalSavedState,
  type InternalScrollRegion,
  type InternalSgrStyle,
} from './types.js';

export interface VtEmulatorOptions {
  readonly sessionId?: string;
  readonly rows?: number;
  readonly cols?: number;
  readonly onEnvelope: (env: GridEventEnvelope<GridPayload>) => void;
}

type FsmState =
  | 'Ground'
  | 'Escape'
  | 'Csi'
  | 'Osc'
  | 'IgnoreUntilSt';

const ESC = 0x1b;
const BEL = 0x07;
const BS = 0x08;
const HT = 0x09;
const LF = 0x0a;
const VT = 0x0b;
const FF = 0x0c;
const CR = 0x0d;

const DEFAULT_ROWS = 24;
const DEFAULT_COLS = 80;

export class VtEmulator {
  private readonly sessionId: string;
  private readonly onEnvelope: (env: GridEventEnvelope<GridPayload>) => void;
  private readonly classifier = new DefaultClassifier('narrow');

  private rows_: number;
  private cols_: number;

  /** 2D cell grid. `grid[row][col]` is the canonical cell. */
  private grid: InternalCell[][] = [];
  /** Per-row revision counter (wraps at 2^32 — same as GridMirror wire). */
  private rowRevisions: Uint32Array = new Uint32Array(0);

  private cursor: InternalCursor = {
    row: 0,
    col: 0,
    visible: true,
    shape: 'block',
    blinking: true,
    pendingWrap: false,
  };
  /** Cursor position snapshot at the start of the current feed() call, used
   *  to detect whether a cursor_moved envelope is needed when no cells changed. */
  private cursorAtFeedStart: InternalCursor = { ...this.cursor };

  private sgr: InternalSgrStyle = defaultSgr();

  private scrollRegion: InternalScrollRegion = { top: 0, bottom: 0 };
  /** Top-left saved state via DECSC. Defaults to origin / default SGR. */
  private savedState: InternalSavedState | null = null;

  /** DECAWM — auto-wrap at right margin. Default on. */
  private autoWrap = true;

  /** Emitted envelope counter (strictly ascending). */
  private sequenceNo = 0;
  /** Bumped per `resize()`. */
  private resizeGeneration = 0;
  /** Monotonic within the process; never reset by `reset()`. */
  private epoch = 1;

  /** FSM state. */
  private state: FsmState = 'Ground';
  /** Partial-UTF-8 / text decoder — streamed across feed() calls. */
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });
  /** CSI parameter accumulator — ASCII so a string is fine. */
  private seqBuf = '';
  /** CSI private-mode intro byte (`?`, `>`, `!`, `=`) or ''. */
  private csiPrivate = '';
  /** CSI intermediate bytes between params and final (e.g. `!`, ` `). */
  private csiIntermediate = '';
  /** `ESC` seen inside Osc / IgnoreUntilSt; next `\\` terminates. */
  private oscEscPending = false;

  /** Rows touched during the current feed() batch. */
  private dirtyRows = new Set<number>();

  constructor(opts: VtEmulatorOptions) {
    this.sessionId = opts.sessionId ?? 'tui-local';
    this.onEnvelope = opts.onEnvelope;
    this.rows_ = Math.max(1, opts.rows ?? DEFAULT_ROWS);
    this.cols_ = Math.max(1, opts.cols ?? DEFAULT_COLS);
    this.allocateGrid(this.rows_, this.cols_);
    this.scrollRegion = { top: 0, bottom: this.rows_ - 1 };
    this.cursorAtFeedStart = { ...this.cursor };
    // Emit initial snapshot so downstream mirror is seeded.
    this.emitSnapshot();
  }

  /** Public dimensions getter — handy for tests. */
  getDimensions(): { rows: number; cols: number } {
    return { rows: this.rows_, cols: this.cols_ };
  }

  /** @internal test-only */
  _getCell(row: number, col: number): InternalCell | undefined {
    return this.grid[row]?.[col];
  }

  /** @internal test-only */
  _getCursor(): Readonly<InternalCursor> {
    return this.cursor;
  }

  /** @internal test-only */
  _getScrollRegion(): Readonly<InternalScrollRegion> {
    return this.scrollRegion;
  }

  feed(bytes: Uint8Array): void {
    this.cursorAtFeedStart = { ...this.cursor };
    this.dirtyRows.clear();
    // Collected decoded text segments so we can feed the grid without
    // jumping into `TextDecoder` per byte — a 10-100x speedup on long
    // plain-text runs.
    let textChunk: number[] = [];
    const flushText = (): void => {
      if (textChunk.length === 0) return;
      const decoded = this.decoder.decode(new Uint8Array(textChunk), { stream: true });
      textChunk = [];
      if (decoded.length === 0) return;
      for (const { segment } of new Intl.Segmenter(undefined, {
        granularity: 'grapheme',
      }).segment(decoded)) {
        this.printGrapheme(segment);
      }
    };

    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i]!;
      if (this.state === 'Ground') {
        // Fast path for printable ASCII / UTF-8 continuation bytes.
        if (b >= 0x20 && b !== 0x7f) {
          textChunk.push(b);
          continue;
        }
        if (b >= 0x80) {
          textChunk.push(b);
          continue;
        }
        // Control byte — flush pending text, then dispatch.
        flushText();
      }
      this.step(b);
    }
    // End of chunk: flush any buffered text (but keep decoder in stream mode
    // so the next feed() can continue a split UTF-8 codepoint).
    flushText();

    this.emitDirty();
  }

  resize(rows: number, cols: number): void {
    const newRows = Math.max(1, rows | 0);
    const newCols = Math.max(1, cols | 0);
    if (newRows === this.rows_ && newCols === this.cols_) {
      // No-op resize still emits a snapshot per contract.
      this.emitSnapshot();
      return;
    }
    const oldRows = this.rows_;
    const oldCols = this.cols_;
    const oldGrid = this.grid;
    this.rows_ = newRows;
    this.cols_ = newCols;
    this.allocateGrid(newRows, newCols);
    const copyRows = Math.min(oldRows, newRows);
    const copyCols = Math.min(oldCols, newCols);
    for (let r = 0; r < copyRows; r += 1) {
      const src = oldGrid[r]!;
      const dst = this.grid[r]!;
      for (let c = 0; c < copyCols; c += 1) {
        dst[c] = { ...(src[c] ?? blankCell()) };
      }
    }
    // Cursor clamp.
    this.cursor.row = Math.min(this.cursor.row, newRows - 1);
    this.cursor.col = Math.min(this.cursor.col, newCols - 1);
    this.cursor.pendingWrap = false;
    // Scroll region clamp.
    this.scrollRegion = { top: 0, bottom: newRows - 1 };
    this.resizeGeneration += 1;
    this.emitSnapshot();
  }

  snapshot(): void {
    this.emitSnapshot();
  }

  reset(): void {
    this.sgr = defaultSgr();
    this.cursor = {
      row: 0,
      col: 0,
      visible: true,
      shape: 'block',
      blinking: true,
      pendingWrap: false,
    };
    this.allocateGrid(this.rows_, this.cols_);
    this.scrollRegion = { top: 0, bottom: this.rows_ - 1 };
    this.savedState = null;
    this.autoWrap = true;
    this.state = 'Ground';
    this.seqBuf = '';
    this.csiPrivate = '';
    this.csiIntermediate = '';
    this.oscEscPending = false;
    this.cursorAtFeedStart = { ...this.cursor };
    this.dirtyRows.clear();
    this.emitSnapshot();
  }

  /* ------------------------- FSM ------------------------- */

  private step(b: number): void {
    switch (this.state) {
      case 'Ground':
        this.stepGround(b);
        return;
      case 'Escape':
        this.stepEscape(b);
        return;
      case 'Csi':
        this.stepCsi(b);
        return;
      case 'Osc':
        this.stepOsc(b);
        return;
      case 'IgnoreUntilSt':
        this.stepIgnore(b);
        return;
    }
  }

  private stepGround(b: number): void {
    switch (b) {
      case ESC:
        this.state = 'Escape';
        return;
      case BEL:
        // no-op (BEL is a no-op for the grid; upstream may surface via telemetry)
        return;
      case BS:
        this.executeBackspace();
        return;
      case HT:
        this.executeTab();
        return;
      case LF:
      case VT:
      case FF:
        this.executeLineFeed();
        return;
      case CR:
        this.executeCarriageReturn();
        return;
      default:
        // Other C0 controls (SO/SI/SUB/CAN/etc.) are ignored for our scope.
        return;
    }
  }

  private stepEscape(b: number): void {
    if (b === 0x5b /* '[' */) {
      this.state = 'Csi';
      this.seqBuf = '';
      this.csiPrivate = '';
      this.csiIntermediate = '';
      return;
    }
    if (b === 0x5d /* ']' */) {
      this.state = 'Osc';
      this.seqBuf = '';
      this.oscEscPending = false;
      return;
    }
    if (b === 0x50 /* 'P' DCS */ ||
        b === 0x5f /* '_' APC */ ||
        b === 0x5e /* '^' PM */) {
      this.state = 'IgnoreUntilSt';
      this.oscEscPending = false;
      return;
    }
    if (b === 0x5c /* '\\' ST alone — harmless */) {
      this.state = 'Ground';
      return;
    }
    if (b === 0x37 /* '7' DECSC */) {
      this.executeSave();
      this.state = 'Ground';
      return;
    }
    if (b === 0x38 /* '8' DECRC */) {
      this.executeRestore();
      this.state = 'Ground';
      return;
    }
    if (b === 0x63 /* 'c' RIS */) {
      this.reset();
      this.state = 'Ground';
      return;
    }
    if (b === 0x44 /* 'D' IND */) {
      // Index — move cursor down, scroll if at bottom.
      this.lineFeedInRegion();
      this.state = 'Ground';
      return;
    }
    if (b === 0x45 /* 'E' NEL */) {
      this.cursor.col = 0;
      this.cursor.pendingWrap = false;
      this.lineFeedInRegion();
      this.state = 'Ground';
      return;
    }
    if (b === 0x4d /* 'M' RI */) {
      // Reverse index — move up, scroll down if at top.
      this.reverseIndexInRegion();
      this.state = 'Ground';
      return;
    }
    // Charset designator `( ) * +` take one more byte.
    if (b === 0x28 || b === 0x29 || b === 0x2a || b === 0x2b) {
      // Consume one more byte in IgnoreUntilSt-lite: we use a tiny inline
      // state instead so this isn't conflated with DCS.
      this.state = 'Ground';
      // Set a single-byte skipper: emulate by pushing to seqBuf and entering
      // `Escape` again. Simpler: route through a dedicated micro-state.
      this.pendingCharsetSkip = true;
      return;
    }
    // Unknown ESC dispatch — silently drop.
    this.state = 'Ground';
  }

  private pendingCharsetSkip = false;

  private stepCsi(b: number): void {
    // Intro private byte first (only at the start of the parameter list).
    if (this.seqBuf.length === 0 &&
        this.csiPrivate === '' &&
        (b === 0x3c || b === 0x3d || b === 0x3e || b === 0x3f)) {
      this.csiPrivate = String.fromCharCode(b);
      return;
    }
    // Intermediate bytes 0x20-0x2f.
    if (b >= 0x20 && b <= 0x2f) {
      this.csiIntermediate += String.fromCharCode(b);
      return;
    }
    // Parameter bytes: digits, `;`, `:` (subparam separator — we treat as ;).
    if ((b >= 0x30 && b <= 0x39) || b === 0x3b || b === 0x3a) {
      this.seqBuf += b === 0x3a ? ';' : String.fromCharCode(b);
      return;
    }
    // Final byte 0x40-0x7e → dispatch.
    if (b >= 0x40 && b <= 0x7e) {
      const final = String.fromCharCode(b);
      const params = this.parseCsiParams(this.seqBuf);
      this.dispatchCsi(this.csiPrivate, final, params, this.csiIntermediate);
      this.state = 'Ground';
      this.seqBuf = '';
      this.csiPrivate = '';
      this.csiIntermediate = '';
      return;
    }
    // Garbage — drop the CSI and return to Ground.
    this.state = 'Ground';
    this.seqBuf = '';
    this.csiPrivate = '';
    this.csiIntermediate = '';
  }

  private stepOsc(b: number): void {
    if (this.oscEscPending) {
      if (b === 0x5c) {
        // ESC \ terminator. We don't act on OSC in this scope.
        this.oscEscPending = false;
        this.state = 'Ground';
        this.seqBuf = '';
        return;
      }
      // Lone ESC in payload — stash and keep accumulating (defensive).
      this.oscEscPending = false;
      this.seqBuf += '\x1b';
    }
    if (b === BEL) {
      this.state = 'Ground';
      this.seqBuf = '';
      return;
    }
    if (b === ESC) {
      this.oscEscPending = true;
      return;
    }
    // Cap OSC buffer to avoid unbounded growth on malicious streams.
    if (this.seqBuf.length < 4096) {
      this.seqBuf += String.fromCharCode(b);
    }
  }

  private stepIgnore(b: number): void {
    if (this.oscEscPending) {
      if (b === 0x5c) {
        this.oscEscPending = false;
        this.state = 'Ground';
        return;
      }
      this.oscEscPending = false;
    }
    if (b === BEL) {
      this.state = 'Ground';
      return;
    }
    if (b === ESC) this.oscEscPending = true;
  }

  /* ------------------------- CSI dispatch ------------------------- */

  private parseCsiParams(buf: string): number[] {
    if (buf.length === 0) return [];
    const parts = buf.split(';');
    const out: number[] = [];
    for (const p of parts) {
      if (p === '') {
        out.push(0);
      } else {
        const n = parseInt(p, 10);
        out.push(Number.isFinite(n) ? n : 0);
      }
    }
    return out;
  }

  private paramOr(params: readonly number[], idx: number, fallback: number): number {
    const v = params[idx];
    if (v === undefined || v === 0) return fallback;
    return v;
  }

  private dispatchCsi(
    priv: string,
    final: string,
    params: readonly number[],
    _intermediate: string,
  ): void {
    if (priv === '?') {
      if (final === 'h') this.executeDecSet(params, true);
      else if (final === 'l') this.executeDecSet(params, false);
      // Unknown DEC private command → drop.
      return;
    }
    switch (final) {
      case '@':
        this.executeIch(this.paramOr(params, 0, 1));
        return;
      case 'A':
        this.executeCursorUp(this.paramOr(params, 0, 1));
        return;
      case 'B':
        this.executeCursorDown(this.paramOr(params, 0, 1));
        return;
      case 'C':
        this.executeCursorForward(this.paramOr(params, 0, 1));
        return;
      case 'D':
        this.executeCursorBack(this.paramOr(params, 0, 1));
        return;
      case 'E':
        this.executeCursorNextLine(this.paramOr(params, 0, 1));
        return;
      case 'F':
        this.executeCursorPrevLine(this.paramOr(params, 0, 1));
        return;
      case 'G':
      case '`':
        this.executeCha(this.paramOr(params, 0, 1));
        return;
      case 'H':
      case 'f':
        this.executeCup(
          this.paramOr(params, 0, 1),
          this.paramOr(params, 1, 1),
        );
        return;
      case 'J':
        this.executeEd(params[0] ?? 0);
        return;
      case 'K':
        this.executeEl(params[0] ?? 0);
        return;
      case 'L':
        this.executeIl(this.paramOr(params, 0, 1));
        return;
      case 'M':
        this.executeDl(this.paramOr(params, 0, 1));
        return;
      case 'P':
        this.executeDch(this.paramOr(params, 0, 1));
        return;
      case 'S':
        this.executeScrollUp(this.paramOr(params, 0, 1));
        return;
      case 'T':
        this.executeScrollDown(this.paramOr(params, 0, 1));
        return;
      case 'X':
        this.executeEch(this.paramOr(params, 0, 1));
        return;
      case 'd':
        this.executeVpa(this.paramOr(params, 0, 1));
        return;
      case 'm':
        this.applySgr(params.length === 0 ? [0] : params);
        return;
      case 'r':
        this.executeDecstbm(params[0], params[1]);
        return;
      case 's':
        this.executeSave();
        return;
      case 'u':
        this.executeRestore();
        return;
      case 'n':
        // Device status report — we don't write back to PTY, so no-op.
        return;
      case 'c':
        // Device attributes — no reply surface.
        return;
      default:
        // Unknown / out-of-scope — silently drop.
        return;
    }
  }

  /* ------------------------- Control byte ops ------------------------- */

  private executeBackspace(): void {
    this.cursor.pendingWrap = false;
    if (this.cursor.col > 0) this.cursor.col -= 1;
  }

  private executeTab(): void {
    this.cursor.pendingWrap = false;
    const next = (Math.floor(this.cursor.col / 8) + 1) * 8;
    this.cursor.col = Math.min(next, this.cols_ - 1);
  }

  private executeLineFeed(): void {
    this.cursor.pendingWrap = false;
    this.lineFeedInRegion();
  }

  private executeCarriageReturn(): void {
    this.cursor.pendingWrap = false;
    this.cursor.col = 0;
  }

  /** LF inside the current scroll region; scrolls up at `region.bottom`. */
  private lineFeedInRegion(): void {
    if (this.cursor.row === this.scrollRegion.bottom) {
      this.scrollUpRegion(1);
      return;
    }
    if (this.cursor.row < this.rows_ - 1) {
      this.cursor.row += 1;
    }
  }

  /** Reverse index — opposite of LF. */
  private reverseIndexInRegion(): void {
    if (this.cursor.row === this.scrollRegion.top) {
      this.scrollDownRegion(1);
      return;
    }
    if (this.cursor.row > 0) {
      this.cursor.row -= 1;
    }
  }

  /* ------------------------- Text printing ------------------------- */

  private printGrapheme(g: string): void {
    if (this.pendingCharsetSkip) {
      // Consume exactly one byte/grapheme as the charset designator arg.
      this.pendingCharsetSkip = false;
      return;
    }
    const { grapheme, width } = this.classifier.classifyGrapheme(g);
    if (width === 'zero' || grapheme === '') {
      // Combine with preceding cell (best-effort: append to grapheme text).
      const col = Math.max(0, this.cursor.col - 1);
      const row = this.cursor.row;
      const cell = this.grid[row]?.[col];
      if (cell !== undefined) {
        cell.grapheme += grapheme;
        this.markDirty(row);
      }
      return;
    }
    const cellWidth: 1 | 2 = width === 'two' ? 2 : 1;

    // DECAWM wrap handling — if pendingWrap, we've already written to the
    // last column; the *next* printable triggers a wrap to the next row.
    if (this.cursor.pendingWrap && this.autoWrap) {
      this.cursor.pendingWrap = false;
      this.cursor.col = 0;
      if (this.cursor.row === this.scrollRegion.bottom) {
        this.scrollUpRegion(1);
      } else if (this.cursor.row < this.rows_ - 1) {
        this.cursor.row += 1;
      }
    }

    // Check if the grapheme fits on the current row.
    if (this.cursor.col + cellWidth > this.cols_) {
      if (this.autoWrap) {
        // Wide char doesn't fit — wrap first, then write.
        this.cursor.col = 0;
        if (this.cursor.row === this.scrollRegion.bottom) {
          this.scrollUpRegion(1);
        } else if (this.cursor.row < this.rows_ - 1) {
          this.cursor.row += 1;
        }
      } else {
        // DECAWM off — overwrite the last column with the new grapheme.
        this.cursor.col = this.cols_ - cellWidth;
      }
    }

    const row = this.cursor.row;
    const col = this.cursor.col;
    this.writeCell(row, col, grapheme, cellWidth);
    this.cursor.col += cellWidth;
    if (this.cursor.col >= this.cols_) {
      this.cursor.col = this.cols_ - 1;
      this.cursor.pendingWrap = this.autoWrap;
    }
  }

  private writeCell(row: number, col: number, grapheme: string, width: 1 | 2): void {
    const rowArr = this.grid[row];
    if (!rowArr) return;
    const cell = rowArr[col];
    if (!cell) return;
    cell.grapheme = grapheme;
    cell.width = width;
    cell.fg = this.sgr.fg;
    cell.bg = this.sgr.bg;
    cell.bold = this.sgr.bold;
    cell.italic = this.sgr.italic;
    cell.underline = this.sgr.underline;
    cell.inverse = this.sgr.inverse;
    cell.strike = this.sgr.strike;
    cell.dim = this.sgr.dim;
    cell.hidden = this.sgr.hidden;
    cell.blink = this.sgr.blink;
    if (width === 2) {
      const next = rowArr[col + 1];
      if (next) {
        next.grapheme = '';
        next.width = 0;
        next.fg = this.sgr.fg;
        next.bg = this.sgr.bg;
        next.bold = this.sgr.bold;
        next.italic = this.sgr.italic;
        next.underline = this.sgr.underline;
        next.inverse = this.sgr.inverse;
        next.strike = this.sgr.strike;
        next.dim = this.sgr.dim;
        next.hidden = this.sgr.hidden;
        next.blink = this.sgr.blink;
      }
    }
    this.markDirty(row);
  }

  /* ------------------------- Cursor movement ops ------------------------- */

  private executeCursorUp(n: number): void {
    this.cursor.row = Math.max(this.scrollRegion.top, this.cursor.row - n);
    this.cursor.pendingWrap = false;
  }

  private executeCursorDown(n: number): void {
    this.cursor.row = Math.min(this.scrollRegion.bottom, this.cursor.row + n);
    this.cursor.pendingWrap = false;
  }

  private executeCursorForward(n: number): void {
    this.cursor.col = Math.min(this.cols_ - 1, this.cursor.col + n);
    this.cursor.pendingWrap = false;
  }

  private executeCursorBack(n: number): void {
    this.cursor.col = Math.max(0, this.cursor.col - n);
    this.cursor.pendingWrap = false;
  }

  private executeCursorNextLine(n: number): void {
    this.cursor.row = Math.min(this.rows_ - 1, this.cursor.row + n);
    this.cursor.col = 0;
    this.cursor.pendingWrap = false;
  }

  private executeCursorPrevLine(n: number): void {
    this.cursor.row = Math.max(0, this.cursor.row - n);
    this.cursor.col = 0;
    this.cursor.pendingWrap = false;
  }

  private executeCha(n: number): void {
    // 1-indexed wire → 0-indexed internal.
    this.cursor.col = Math.max(0, Math.min(this.cols_ - 1, n - 1));
    this.cursor.pendingWrap = false;
  }

  private executeCup(row: number, col: number): void {
    // 1-indexed wire → 0-indexed internal.
    this.cursor.row = Math.max(0, Math.min(this.rows_ - 1, row - 1));
    this.cursor.col = Math.max(0, Math.min(this.cols_ - 1, col - 1));
    this.cursor.pendingWrap = false;
  }

  private executeVpa(row: number): void {
    this.cursor.row = Math.max(0, Math.min(this.rows_ - 1, row - 1));
    this.cursor.pendingWrap = false;
  }

  /* ------------------------- Erase ops ------------------------- */

  private executeEd(mode: number): void {
    const { row, col } = this.cursor;
    switch (mode) {
      case 0: {
        // Cursor → end of screen.
        this.eraseRowRange(row, col, this.cols_ - 1);
        for (let r = row + 1; r < this.rows_; r += 1) {
          this.eraseRowRange(r, 0, this.cols_ - 1);
        }
        break;
      }
      case 1: {
        // Start → cursor (inclusive).
        for (let r = 0; r < row; r += 1) {
          this.eraseRowRange(r, 0, this.cols_ - 1);
        }
        this.eraseRowRange(row, 0, col);
        break;
      }
      case 2: {
        // All.
        for (let r = 0; r < this.rows_; r += 1) {
          this.eraseRowRange(r, 0, this.cols_ - 1);
        }
        break;
      }
      case 3: {
        // Erase scrollback — no-op in our grid-only model.
        break;
      }
      default:
        break;
    }
    this.cursor.pendingWrap = false;
  }

  private executeEl(mode: number): void {
    const { row, col } = this.cursor;
    switch (mode) {
      case 0:
        this.eraseRowRange(row, col, this.cols_ - 1);
        break;
      case 1:
        this.eraseRowRange(row, 0, col);
        break;
      case 2:
        this.eraseRowRange(row, 0, this.cols_ - 1);
        break;
      default:
        break;
    }
    this.cursor.pendingWrap = false;
  }

  private eraseRowRange(row: number, fromCol: number, toCol: number): void {
    const rowArr = this.grid[row];
    if (!rowArr) return;
    const start = Math.max(0, fromCol);
    const end = Math.min(this.cols_ - 1, toCol);
    for (let c = start; c <= end; c += 1) {
      rowArr[c] = blankCellWithSgr(this.sgr);
    }
    this.markDirty(row);
  }

  /* ------------------------- Insert / delete ops ------------------------- */

  private executeIch(n: number): void {
    const rowArr = this.grid[this.cursor.row];
    if (!rowArr) return;
    const count = Math.max(1, Math.min(n, this.cols_ - this.cursor.col));
    // Shift cells right from cursor.col.
    for (let c = this.cols_ - 1; c >= this.cursor.col + count; c -= 1) {
      rowArr[c] = rowArr[c - count] ?? blankCellWithSgr(this.sgr);
    }
    for (let c = this.cursor.col; c < this.cursor.col + count; c += 1) {
      rowArr[c] = blankCellWithSgr(this.sgr);
    }
    this.markDirty(this.cursor.row);
    this.cursor.pendingWrap = false;
  }

  private executeDch(n: number): void {
    const rowArr = this.grid[this.cursor.row];
    if (!rowArr) return;
    const count = Math.max(1, Math.min(n, this.cols_ - this.cursor.col));
    for (let c = this.cursor.col; c < this.cols_ - count; c += 1) {
      rowArr[c] = rowArr[c + count] ?? blankCellWithSgr(this.sgr);
    }
    for (let c = this.cols_ - count; c < this.cols_; c += 1) {
      rowArr[c] = blankCellWithSgr(this.sgr);
    }
    this.markDirty(this.cursor.row);
    this.cursor.pendingWrap = false;
  }

  private executeEch(n: number): void {
    const rowArr = this.grid[this.cursor.row];
    if (!rowArr) return;
    const count = Math.max(1, Math.min(n, this.cols_ - this.cursor.col));
    for (let c = this.cursor.col; c < this.cursor.col + count; c += 1) {
      rowArr[c] = blankCellWithSgr(this.sgr);
    }
    this.markDirty(this.cursor.row);
    this.cursor.pendingWrap = false;
  }

  private executeIl(n: number): void {
    // Insert N blank lines at cursor row, scroll rest of region down.
    if (
      this.cursor.row < this.scrollRegion.top ||
      this.cursor.row > this.scrollRegion.bottom
    ) {
      return;
    }
    const count = Math.max(1, Math.min(n, this.scrollRegion.bottom - this.cursor.row + 1));
    // Shift rows [cursor.row, region.bottom - count] down by count.
    for (let r = this.scrollRegion.bottom; r >= this.cursor.row + count; r -= 1) {
      const src = this.grid[r - count];
      if (src !== undefined) this.grid[r] = src.map((c) => ({ ...c }));
      this.markDirty(r);
    }
    for (let r = this.cursor.row; r < this.cursor.row + count; r += 1) {
      this.grid[r] = this.blankRow();
      this.markDirty(r);
    }
    this.cursor.pendingWrap = false;
    this.cursor.col = 0;
  }

  private executeDl(n: number): void {
    if (
      this.cursor.row < this.scrollRegion.top ||
      this.cursor.row > this.scrollRegion.bottom
    ) {
      return;
    }
    const count = Math.max(1, Math.min(n, this.scrollRegion.bottom - this.cursor.row + 1));
    // Shift rows [cursor.row + count, region.bottom] up by count.
    for (let r = this.cursor.row; r + count <= this.scrollRegion.bottom; r += 1) {
      const src = this.grid[r + count];
      if (src !== undefined) this.grid[r] = src.map((c) => ({ ...c }));
      this.markDirty(r);
    }
    for (let r = this.scrollRegion.bottom - count + 1; r <= this.scrollRegion.bottom; r += 1) {
      this.grid[r] = this.blankRow();
      this.markDirty(r);
    }
    this.cursor.pendingWrap = false;
    this.cursor.col = 0;
  }

  private executeScrollUp(n: number): void {
    this.scrollUpRegion(n);
  }

  private executeScrollDown(n: number): void {
    this.scrollDownRegion(n);
  }

  private scrollUpRegion(n: number): void {
    const { top, bottom } = this.scrollRegion;
    const count = Math.max(1, Math.min(n, bottom - top + 1));
    for (let r = top; r + count <= bottom; r += 1) {
      const src = this.grid[r + count];
      if (src !== undefined) this.grid[r] = src.map((c) => ({ ...c }));
      this.markDirty(r);
    }
    for (let r = bottom - count + 1; r <= bottom; r += 1) {
      this.grid[r] = this.blankRow();
      this.markDirty(r);
    }
  }

  private scrollDownRegion(n: number): void {
    const { top, bottom } = this.scrollRegion;
    const count = Math.max(1, Math.min(n, bottom - top + 1));
    for (let r = bottom; r - count >= top; r -= 1) {
      const src = this.grid[r - count];
      if (src !== undefined) this.grid[r] = src.map((c) => ({ ...c }));
      this.markDirty(r);
    }
    for (let r = top; r < top + count; r += 1) {
      this.grid[r] = this.blankRow();
      this.markDirty(r);
    }
  }

  /* ------------------------- Scroll region ------------------------- */

  private executeDecstbm(topParam: number | undefined, bottomParam: number | undefined): void {
    const top = (topParam ?? 1) - 1;
    const bottom = (bottomParam ?? this.rows_) - 1;
    if (top >= 0 && bottom < this.rows_ && top < bottom) {
      this.scrollRegion = { top, bottom };
    } else {
      // Invalid values — reset to full screen.
      this.scrollRegion = { top: 0, bottom: this.rows_ - 1 };
    }
    // DECSTBM moves cursor to origin (home).
    this.cursor.row = 0;
    this.cursor.col = 0;
    this.cursor.pendingWrap = false;
  }

  /* ------------------------- Save / restore ------------------------- */

  private executeSave(): void {
    this.savedState = {
      cursor: { ...this.cursor },
      sgr: { ...this.sgr },
      scrollRegion: { ...this.scrollRegion },
    };
  }

  private executeRestore(): void {
    if (!this.savedState) {
      this.cursor.row = 0;
      this.cursor.col = 0;
      this.cursor.pendingWrap = false;
      return;
    }
    this.cursor = { ...this.savedState.cursor };
    this.sgr = { ...this.savedState.sgr };
    this.scrollRegion = { ...this.savedState.scrollRegion };
  }

  /* ------------------------- DEC private modes ------------------------- */

  private executeDecSet(params: readonly number[], enable: boolean): void {
    for (const p of params) {
      switch (p) {
        case 7:
          this.autoWrap = enable;
          break;
        case 6:
          // DECOM — origin mode (not modeled: we don't translate coords).
          break;
        case 12:
          this.cursor.blinking = enable;
          break;
        case 25:
          this.cursor.visible = enable;
          break;
        case 1049:
        case 1047:
        case 47:
          // Alt-screen flip — our scope deliberately doesn't model it. The
          // orchestrator (e.g. AnsiParser.onMode or the TUI router) handles
          // the screen swap. Here we just swallow.
          break;
        default:
          // Unknown / unsupported — drop silently.
          break;
      }
    }
  }

  /* ------------------------- SGR ------------------------- */

  private applySgr(params: readonly number[]): void {
    let i = 0;
    while (i < params.length) {
      const p = params[i]!;
      switch (p) {
        case 0:
          this.sgr = defaultSgr();
          break;
        case 1:
          this.sgr.bold = true;
          break;
        case 2:
          this.sgr.dim = true;
          break;
        case 3:
          this.sgr.italic = true;
          break;
        case 4:
          this.sgr.underline = true;
          break;
        case 5:
          this.sgr.blink = true;
          break;
        case 7:
          this.sgr.inverse = true;
          break;
        case 8:
          this.sgr.hidden = true;
          break;
        case 9:
          this.sgr.strike = true;
          break;
        case 21:
          this.sgr.underline = true;
          break;
        case 22:
          this.sgr.bold = false;
          this.sgr.dim = false;
          break;
        case 23:
          this.sgr.italic = false;
          break;
        case 24:
          this.sgr.underline = false;
          break;
        case 25:
          this.sgr.blink = false;
          break;
        case 27:
          this.sgr.inverse = false;
          break;
        case 28:
          this.sgr.hidden = false;
          break;
        case 29:
          this.sgr.strike = false;
          break;
        case 38: {
          const { color, consumed } = parseExtendedColor(params, i + 1);
          if (color !== undefined) this.sgr.fg = color;
          i += consumed;
          break;
        }
        case 39:
          this.sgr.fg = 'default';
          break;
        case 48: {
          const { color, consumed } = parseExtendedColor(params, i + 1);
          if (color !== undefined) this.sgr.bg = color;
          i += consumed;
          break;
        }
        case 49:
          this.sgr.bg = 'default';
          break;
        default:
          if (p >= 30 && p <= 37) {
            this.sgr.fg = { kind: 'named', index: (p - 30) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 };
          } else if (p >= 40 && p <= 47) {
            this.sgr.bg = { kind: 'named', index: (p - 40) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 };
          } else if (p >= 90 && p <= 97) {
            this.sgr.fg = { kind: 'bright', index: (p - 90) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 };
          } else if (p >= 100 && p <= 107) {
            this.sgr.bg = { kind: 'bright', index: (p - 100) as 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 };
          }
          break;
      }
      i += 1;
    }
  }

  /* ------------------------- Grid helpers ------------------------- */

  private allocateGrid(rows: number, cols: number): void {
    this.grid = new Array<InternalCell[]>(rows);
    for (let r = 0; r < rows; r += 1) {
      this.grid[r] = new Array<InternalCell>(cols);
      for (let c = 0; c < cols; c += 1) {
        this.grid[r]![c] = blankCell();
      }
    }
    this.rowRevisions = new Uint32Array(rows);
  }

  private blankRow(): InternalCell[] {
    const row = new Array<InternalCell>(this.cols_);
    for (let c = 0; c < this.cols_; c += 1) row[c] = blankCellWithSgr(this.sgr);
    return row;
  }

  private markDirty(row: number): void {
    this.dirtyRows.add(row);
  }

  /* ------------------------- Envelope emission ------------------------- */

  private buildRowDelta(row: number): RowDelta {
    const before = this.rowRevisions[row] ?? 0;
    const after = (before + 1) >>> 0;
    const rowArr = this.grid[row] ?? [];
    const spans = buildSpansForRow(rowArr);
    return {
      row,
      revision_before: before,
      revision_after: after,
      spans,
    };
  }

  private emitSnapshot(): void {
    const row_deltas: RowDelta[] = [];
    for (let r = 0; r < this.rows_; r += 1) {
      // For snapshots we want revision_after to match what subsequent deltas
      // expect. Keep the previous revision_before so re-snapshot mid-run
      // doesn't desync the mirror's row_revisions vs. ours.
      const before = this.rowRevisions[r] ?? 0;
      const rowArr = this.grid[r] ?? [];
      row_deltas.push({
        row: r,
        revision_before: before,
        revision_after: before,
        spans: buildSpansForRow(rowArr),
      });
    }
    const payload: GridSnapshotPayload = {
      kind: 'grid_snapshot',
      rows: this.rows_,
      cols: this.cols_,
      buffer_kind: 'main',
      row_deltas,
      cursor: this.buildCursorState(),
      mode_state: this.buildModeState(),
    };
    this.emit(payload);
    // Reset dirty accumulator — snapshot is authoritative.
    this.dirtyRows.clear();
    this.cursorAtFeedStart = { ...this.cursor };
  }

  private emitDirty(): void {
    if (this.dirtyRows.size === 0) {
      // Cursor-only change?
      if (!cursorEqual(this.cursorAtFeedStart, this.cursor)) {
        this.emitCursor();
      }
      return;
    }
    // Bump revisions AFTER capturing `revision_before` via buildRowDelta.
    const deltas: RowDelta[] = [];
    const sortedRows = [...this.dirtyRows].sort((a, b) => a - b);
    for (const r of sortedRows) {
      if (r < 0 || r >= this.rows_) continue;
      deltas.push(this.buildRowDelta(r));
    }
    // Commit new revisions (revision_after values from the deltas).
    for (const d of deltas) {
      this.rowRevisions[d.row] = d.revision_after;
    }
    const payload: GridDeltaPayload = {
      kind: 'grid_delta',
      row_deltas: deltas,
    };
    this.emit(payload);
    // If cursor also moved, emit a follow-up cursor_moved so downstream
    // consumers don't need to re-derive from the delta.
    if (!cursorEqual(this.cursorAtFeedStart, this.cursor)) {
      this.emitCursor();
    }
    this.dirtyRows.clear();
    this.cursorAtFeedStart = { ...this.cursor };
  }

  private emitCursor(): void {
    const payload: CursorMovedPayload = {
      kind: 'cursor_moved',
      cursor: this.buildCursorState(),
    };
    this.emit(payload);
  }

  private emit(payload: GridPayload): void {
    this.sequenceNo += 1;
    const env: GridEventEnvelope<GridPayload> = {
      session_id: this.sessionId,
      grid_epoch: this.epoch,
      sequence_no: this.sequenceNo,
      resize_generation: this.resizeGeneration,
      buffer_kind: 'main',
      payload,
    };
    this.onEnvelope(env);
  }

  private buildCursorState(): CursorState {
    return {
      row: this.cursor.row,
      col: this.cursor.col,
      visible: this.cursor.visible,
      shape: this.cursor.shape,
      blinking: this.cursor.blinking,
      pending_wrap: this.cursor.pendingWrap,
    };
  }

  private buildModeState(): TerminalModeState {
    return {
      alt_screen: false,
    };
  }
}

/* -------------------------- free functions -------------------------- */

function cursorEqual(a: InternalCursor, b: InternalCursor): boolean {
  return (
    a.row === b.row &&
    a.col === b.col &&
    a.visible === b.visible &&
    a.blinking === b.blinking &&
    a.shape === b.shape &&
    a.pendingWrap === b.pendingWrap
  );
}

function parseExtendedColor(
  params: readonly number[],
  i: number,
): { color: AnsiColor | undefined; consumed: number } {
  const mode = params[i];
  if (mode === 5) {
    const n = params[i + 1];
    if (n === undefined) return { color: undefined, consumed: 1 };
    return { color: { kind: 'indexed', index: clamp255(n) }, consumed: 2 };
  }
  if (mode === 2) {
    const r = params[i + 1];
    const g = params[i + 2];
    const b = params[i + 3];
    if (r === undefined || g === undefined || b === undefined) {
      const avail = [r, g, b].filter((x) => x !== undefined).length;
      return { color: undefined, consumed: 1 + avail };
    }
    return {
      color: { kind: 'rgb', r: clamp255(r), g: clamp255(g), b: clamp255(b) },
      consumed: 4,
    };
  }
  return { color: undefined, consumed: 1 };
}

function clamp255(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 255) return 255;
  return n | 0;
}

/**
 * Convert a row's internal cells into `CellSpan`s shaped for the wire.
 *
 * The mirror's `expandSpans` helper treats a span as "one grapheme, N blank
 * continuation cells" — so we MUST emit one span per printable grapheme,
 * plus coalesced `'blank'` runs for unstyled empty stretches.
 *
 * Encoding strategy:
 *   - Wide-leading: one 2-col span carrying the grapheme (continuation
 *     cell's width===0 is consumed silently).
 *   - Narrow printable: one 1-col span.
 *   - Unstyled blank stretch: one N-col `'blank'` span.
 *   - Styled blank (e.g. bg-filled space): one 1-col span per cell so the
 *     mirror re-emits the bg for each column.
 */
function buildSpansForRow(cells: readonly InternalCell[]): CellSpan[] {
  if (cells.length === 0) return [];
  const spans: CellSpan[] = [];
  let i = 0;
  while (i < cells.length) {
    const cell = cells[i]!;
    if (cell.width === 2) {
      spans.push({
        cols: 2,
        sgr: encodeSgr(cell),
        graphemes: { utf8: cell.grapheme },
      });
      i += 2;
      continue;
    }
    if (cell.width === 0) {
      // Orphan wide-continuation — shouldn't happen but emit a blank to
      // keep col arithmetic stable.
      spans.push({
        cols: 1,
        sgr: '0x0000000000000000',
        graphemes: 'blank',
      });
      i += 1;
      continue;
    }
    if (cell.grapheme === '' && isDefaultSgr(cell)) {
      let end = i;
      while (
        end < cells.length &&
        cells[end]!.grapheme === '' &&
        cells[end]!.width === 1 &&
        isDefaultSgr(cells[end]!)
      ) {
        end += 1;
      }
      spans.push({
        cols: end - i,
        sgr: '0x0000000000000000',
        graphemes: 'blank',
      });
      i = end;
      continue;
    }
    // Styled or printable narrow cell — emit one 1-col span so the mirror
    // gets exactly one grapheme per cell. (A run of identical styled blanks
    // still emits one span per cell — small waste, but semantically correct
    // given the wire expansion rule.)
    spans.push({
      cols: 1,
      sgr: encodeSgr(cell),
      graphemes:
        cell.grapheme === '' ? 'blank' : { utf8: cell.grapheme },
    });
    i += 1;
  }
  return spans;
}

function isDefaultSgr(c: InternalCell): boolean {
  return (
    c.fg === 'default' &&
    c.bg === 'default' &&
    !c.bold &&
    !c.italic &&
    !c.underline &&
    !c.inverse &&
    !c.strike &&
    !c.dim &&
    !c.hidden &&
    !c.blink
  );
}

/**
 * Encode the cell's SGR attributes into the u64 hex string consumed by
 * `CellBuffer.parseSgr`.
 *
 * Layout (big-endian hex, 16 chars):
 *   [0..1]  attrs byte (bold/italic/underline/blink/inverse/strike/dim/doubleU)
 *   [2..3]  color-kind byte: high 2 bits fg kind, low 2 bits bg kind (<<4)
 *   [4..5]  fg palette
 *   [6..7]  bg palette
 *   [8..13] fg rgb (3 bytes)
 *   [10..15] bg rgb (2 bytes — layout defined by CellBuffer.parseSgr)
 *
 * We mirror the CellBuffer reader exactly so encode/decode round-trip.
 */
function encodeSgr(c: InternalCell): string {
  let attrs = 0;
  if (c.bold) attrs |= 1 << 7;
  if (c.italic) attrs |= 1 << 6;
  if (c.underline) attrs |= 1 << 5;
  if (c.blink) attrs |= 1 << 4;
  if (c.inverse) attrs |= 1 << 3;
  if (c.strike) attrs |= 1 << 2;
  if (c.dim) attrs |= 1 << 1;
  // double-underline not modeled (we don't emit SGR 21-double-underline-only)

  const { kind: fgKind, palette: fgPal, rgb: fgRgb } = colorToPacked(c.fg);
  const { kind: bgKind, palette: bgPal, rgb: bgRgb } = colorToPacked(c.bg);
  const kindByte = ((fgKind & 0b11) << 6) | ((bgKind & 0b11) << 4);
  const hex =
    (attrs & 0xff).toString(16).padStart(2, '0') +
    (kindByte & 0xff).toString(16).padStart(2, '0') +
    (fgPal & 0xff).toString(16).padStart(2, '0') +
    (bgPal & 0xff).toString(16).padStart(2, '0') +
    (fgRgb & 0xffffff).toString(16).padStart(6, '0') +
    (bgRgb & 0xffff).toString(16).padStart(4, '0');
  return `0x${hex.padEnd(16, '0').slice(0, 16).toUpperCase()}`;
}

function colorToPacked(c: AnsiColor | 'default'): {
  kind: 0 | 1 | 2 | 3;
  palette: number;
  rgb: number;
} {
  if (c === 'default') return { kind: 0, palette: 0, rgb: 0 };
  switch (c.kind) {
    case 'default':
      return { kind: 0, palette: 0, rgb: 0 };
    case 'named':
      return { kind: 1, palette: c.index, rgb: 0 };
    case 'bright':
      return { kind: 1, palette: 8 + c.index, rgb: 0 };
    case 'indexed':
      return { kind: 2, palette: c.index & 0xff, rgb: 0 };
    case 'rgb':
      return {
        kind: 3,
        palette: 0,
        rgb: ((c.r & 0xff) << 16) | ((c.g & 0xff) << 8) | (c.b & 0xff),
      };
  }
}


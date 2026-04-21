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
  BufferKind,
  CellSpan,
  CursorState,
  GridDeltaPayload,
  GridEventEnvelope,
  GridPayload,
  GridSnapshotPayload,
  CursorMovedPayload,
  ModeChangedPayload,
  RowDelta,
  TerminalModeState,
} from '../grid-mirror/types.js';
import {
  blankCell,
  blankCellWithSgr,
  defaultSgr,
  type Buffer,
  type InternalCell,
  type InternalCursor,
  type InternalSavedState,
  type InternalScrollRegion,
  type InternalSgrStyle,
  type Scrollback,
  type ScrollbackRow,
} from './types.js';

/**
 * Module-scoped grapheme segmenter.
 *
 * Instantiating `Intl.Segmenter` pulls in ICU grapheme tables — 10-80 µs
 * per construction on V8. Previously this was allocated inside every
 * `flushText()` call, meaning a vim-style feed with ~40 CSIs per paint
 * would construct ~40 Segmenters per PTY chunk and thousands per second
 * during active editing. Hoisting to module scope makes every emulator
 * instance share the same table pointer — zero allocations per feed.
 *
 * `Intl.Segmenter` is thread-safe and stateless across `.segment()`
 * calls (returns a fresh iterator each time), so sharing is correct.
 */
const GRAPHEME_SEG = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface VtEmulatorOptions {
  readonly sessionId?: string;
  readonly rows?: number;
  readonly cols?: number;
  readonly onEnvelope: (env: GridEventEnvelope<GridPayload>) => void;
  /**
   * Called when the emulator wants to send bytes back to the PTY in response
   * to a query it consumed. Used for:
   *   - DSR (CSI 5n / CSI 6n) status / cursor reports.
   *   - DA (CSI c / CSI >0c) device attribute reports.
   *   - OSC 10 / OSC 11 `?` fg/bg color queries.
   * When unset, queries are silently dropped (pre-existing behaviour).
   */
  readonly onRespond?: (bytes: Uint8Array) => void;
  /**
   * Optional hook called when OSC 7 reports a new working directory. The
   * parser strips the `file://host/` prefix and passes the decoded path.
   * Invalid payloads (missing scheme, un-decodable) are dropped — the hook
   * is only called for successfully parsed values.
   */
  readonly onCwdChanged?: (cwd: string) => void;
  /**
   * Optional source for the current theme's fg/bg colours, used to answer
   * OSC 10 / OSC 11 queries. Each component is 0-255. If absent, the
   * emulator falls back to pure white on pure black — same defaults xterm
   * would otherwise report.
   */
  readonly themeColors?: () => { readonly fg: RgbColor; readonly bg: RgbColor };
  /** Reported as the "version" field in Secondary DA (`CSI > 0 c` response). */
  readonly secondaryDaVersion?: number;
  /**
   * Optional callback invoked whenever the top-of-stack kitty keyboard flags
   * change (via `CSI > <flags> u`, `CSI < u`, or `CSI = <flags> u`). Hosts
   * wire this into `GridMirror.applyMode` so `TerminalModeSnapshot.kittyKeyboard`
   * stays in sync with what apps have requested from the emulator. When unset,
   * the emulator still tracks the state internally so query responses remain
   * correct; only downstream mirrors stay unnotified.
   */
  readonly onKittyKeyboardFlagsChanged?: (flags: number) => void;
  /**
   * Optional hook fired when a **bare** BEL (0x07) is received in the Ground
   * state. BEL bytes that terminate OSC / DCS / APC / PM strings do NOT fire
   * this hook — they are string terminators, not real bells. The host wires
   * this into the bell store which drives the visual flash and optional
   * audible beep.
   */
  readonly onBell?: () => void;
  /**
   * Maximum rows retained in the main-buffer scrollback ring. When a row
   * falls off the top of the main scroll region (LF / IND / NEL / autowrap
   * at bottom), it is cloned into the ring before being cleared.
   *
   * Defaults to 10 000 (a familiar xterm-family ceiling; see note in
   * VtEmulator's `DEFAULT_SCROLLBACK_ROWS`). Set to `0` to disable
   * scrollback entirely — rows will be discarded as they were before α3.
   * Alt buffer never contributes to scrollback regardless of this value.
   */
  readonly scrollbackRows?: number;
}

/** 8-bit-per-channel RGB triple. */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

type FsmState =
  | 'Ground'
  | 'Escape'
  | 'Csi'
  | 'Osc'
  | 'IgnoreUntilSt';

/**
 * In-flight record of a mode flip observed this feed. We only track the
 * fields downstream actually consumes — `alt_screen` is the one that
 * matters for α2. Extending this to `bracketed_paste` / `mouse_tracking`
 * etc. is α-future work, gated on the engine emitting them too.
 */
type ModeChangeEntry = { readonly mode: 'alt_screen'; readonly value: boolean };

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
/**
 * Default scrollback cap — mirrors xterm's `saveLines: 10000` default, which
 * in practice costs ~17 MB for 200-col wide rows of `InternalCell` at typical
 * V8 shapes (~8-9 bytes per cell field × 12 fields). See scrollback.test.ts
 * for the sanity-check math. Hosts that need more (e.g. CI log viewers) can
 * raise via `VtEmulatorOptions.scrollbackRows`; hosts that need tighter
 * memory (embedded / tiny TUI demos) can pass `0` to disable.
 */
const DEFAULT_SCROLLBACK_ROWS = 10_000;

export class VtEmulator {
  private readonly sessionId: string;
  private readonly onEnvelope: (env: GridEventEnvelope<GridPayload>) => void;
  private readonly onRespond: ((bytes: Uint8Array) => void) | undefined;
  private readonly onCwdChanged: ((cwd: string) => void) | undefined;
  private readonly themeColors:
    | (() => { readonly fg: RgbColor; readonly bg: RgbColor })
    | undefined;
  private readonly secondaryDaVersion: number;
  private readonly onKittyKeyboardFlagsChanged:
    | ((flags: number) => void)
    | undefined;
  private readonly onBell: (() => void) | undefined;
  private readonly classifier = new DefaultClassifier('narrow');

  /**
   * Kitty keyboard protocol flags stack.
   *
   * Apps push/pop via:
   *   - `CSI > <flags> u`  → push a new top with `<flags>`.
   *   - `CSI < [n] u`       → pop `n` (default 1) entries.
   *   - `CSI = <flags> u`   → set the current top (mode 1 / OR).
   *   - `CSI = <flags> ; 2 u` → set (replace). `;3` = AND (reset bits).
   *   - `CSI ? u`           → query: reply `CSI ? <top> u`.
   *
   * We initialise with a single `0` entry so queries before any push still
   * answer (`ESC [ ? 0 u`). xterm / kitty both cap the stack at 10; beyond
   * that, the oldest entry is dropped. We model the same limit.
   */
  private kittyFlagStack: number[] = [0];
  private static readonly KITTY_STACK_MAX = 10;
  /** Only the low 5 bits are defined by the kitty spec (flags 1/2/4/8/16). */
  private static readonly KITTY_FLAG_MASK = 0x1f;

  private rows_: number;
  private cols_: number;

  /**
   * 2D cell grid of the *active* buffer. `grid[row][col]` is the canonical
   * cell. Always equal to `activeBuffer().grid`; kept as a direct field so
   * hot-path write ops don't indirect through the active-kind switch.
   */
  private grid: InternalCell[][] = [];
  /**
   * Per-row revision counter for the active buffer (wraps at 2^32 — same as
   * GridMirror wire). Swapped in/out with `grid` when we flip alt/main.
   * Each buffer owns its revisions independently so main's revisions don't
   * advance while alt is being scribbled on (and vice-versa).
   */
  private rowRevisions: Uint32Array = new Uint32Array(0);

  /**
   * Buffer currently holding main screen contents. When `active === 'main'`
   * this *is* `{ grid, rowRevisions }` (same object refs). When alt is
   * active, it stashes the last-seen main state.
   */
  private mainBuffer: Buffer = { grid: [], rowRevisions: new Uint32Array(0) };
  /** Alt-screen buffer — dormant when main is active, live when alt is. */
  private altBuffer: Buffer = { grid: [], rowRevisions: new Uint32Array(0) };
  /** Which buffer is currently receiving writes. */
  private active: BufferKind = 'main';

  /**
   * Bounded scrollback ring for the main buffer. Rows are appended when
   * they fall off the top of the scroll region while `active === 'main'`.
   * Alt buffer scroll-offs bypass this ring entirely (xterm contract).
   *
   * Stored as a mutable internal state that we expose through `getScrollback()`
   * as a `Readonly<>` projection. `maxRows` is frozen at construction (it's
   * `readonly` on the interface); the mutable head/tail machinery lives in
   * `rows`, `baseRowId`, `evictedCount`, `pinBlockedEvictions`.
   */
  private mainScrollback!: Scrollback;

  /**
   * 1048/1049 cursor-save slot. Per xterm `ctlseqs`, 1048 keeps a SEPARATE
   * save slot from DECSC (ESC 7) so apps can nest the two without either
   * stomping the other. Our `savedState` handles DECSC only; this handles
   * 1048 / the 1049 save-phase exclusively.
   */
  private savedState1048: InternalSavedState | null = null;

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

  /**
   * Mode transitions discovered during the current feed() batch, emitted
   * BEFORE `grid_delta` / `cursor_moved` so downstream consumers know which
   * buffer the subsequent rows belong to. RFC 0001 invariant: the mode
   * flip must precede any row delta sourced from the new active buffer.
   * We process mode changes inline (they flip `this.grid` / `this.active`)
   * and defer only the *envelope* emission until `emitDirty()` time.
   */
  private pendingModeChanges: ModeChangeEntry[] = [];

  constructor(opts: VtEmulatorOptions) {
    this.sessionId = opts.sessionId ?? 'tui-local';
    this.onEnvelope = opts.onEnvelope;
    this.onRespond = opts.onRespond;
    this.onCwdChanged = opts.onCwdChanged;
    this.themeColors = opts.themeColors;
    this.secondaryDaVersion = opts.secondaryDaVersion ?? 0;
    this.onKittyKeyboardFlagsChanged = opts.onKittyKeyboardFlagsChanged;
    this.onBell = opts.onBell;
    this.rows_ = Math.max(1, opts.rows ?? DEFAULT_ROWS);
    this.cols_ = Math.max(1, opts.cols ?? DEFAULT_COLS);
    // Clamp negative / non-integer scrollback settings to a sane floor;
    // 0 is a valid "disabled" value and preserved as-is.
    const rawCap = opts.scrollbackRows ?? DEFAULT_SCROLLBACK_ROWS;
    const cap = Number.isFinite(rawCap) ? Math.max(0, Math.floor(rawCap)) : DEFAULT_SCROLLBACK_ROWS;
    this.mainScrollback = {
      maxRows: cap,
      rows: [],
      baseRowId: 0,
      evictedCount: 0,
      pinBlockedEvictions: 0,
    };
    this.allocateGrid(this.rows_, this.cols_);
    // Both buffers are shaped the same at construction; main starts active.
    // The alt buffer stays dormant (blank) until the first 47/1047/1049.
    this.mainBuffer = { grid: this.grid, rowRevisions: this.rowRevisions };
    this.altBuffer = {
      grid: VtEmulator.makeBlankGrid(this.rows_, this.cols_),
      rowRevisions: new Uint32Array(this.rows_),
    };
    this.scrollRegion = { top: 0, bottom: this.rows_ - 1 };
    this.cursorAtFeedStart = { ...this.cursor };
    // Emit initial snapshot so downstream mirror is seeded.
    this.emitSnapshot();
  }

  /**
   * Read-only projection of the main-buffer scrollback ring, intended for
   * tests and future renderers. The returned object is the live ring — the
   * `readonly` annotations prevent typed mutation, but callers should treat
   * it as a snapshot (stale after the next `feed()` / `resize()`).
   */
  getScrollback(): Readonly<Scrollback> {
    return this.mainScrollback;
  }

  /**
   * @internal test-only
   *
   * Pins the scrollback row at `index` so subsequent evictions pause when
   * the head pointer reaches it. Exposed purely so the α3 test suite can
   * exercise the pause-eviction policy without depending on the (not-yet-
   * implemented) P1 block engine that will set `pinned` in production.
   */
  _debugPinScrollbackRow(index: number): void {
    const row = this.mainScrollback.rows[index];
    if (row !== undefined) row.pinned = true;
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
      for (const { segment } of GRAPHEME_SEG.segment(decoded)) {
        this.printGrapheme(segment);
      }
    };

    for (let i = 0; i < bytes.length; i += 1) {
      const b = bytes[i]!;
      // After `ESC ( ` (or `) * +`), the very next byte — printable OR
      // control — is consumed as the charset designator. xterm spec: this
      // slot is a single G-set designator (e.g. 'B' = ASCII). If the next
      // byte is a control like LF, a previous implementation would leave
      // the flag set and silently drop the next printable. Consume here
      // before the FSM sees the byte.
      if (this.pendingCharsetSkip && this.state === 'Ground') {
        // Flush any pending text so printable drops aren't ambiguous.
        flushText();
        this.pendingCharsetSkip = false;
        continue;
      }
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
    // We'll reflow the main buffer (copy cells into the new grid) but
    // *clear* the alt buffer — that matches xterm: apps on alt are
    // expected to redraw on SIGWINCH, and keeping stale alt cells at new
    // dimensions would leak garbage on re-entry.
    const oldMainGrid = this.mainBuffer.grid;
    this.rows_ = newRows;
    this.cols_ = newCols;

    // Build fresh grids for both buffers at the new dimensions.
    const newMainGrid = VtEmulator.makeBlankGrid(newRows, newCols);
    const copyRows = Math.min(oldRows, newRows);
    const copyCols = Math.min(oldCols, newCols);
    for (let r = 0; r < copyRows; r += 1) {
      const src = oldMainGrid[r]!;
      const dst = newMainGrid[r]!;
      for (let c = 0; c < copyCols; c += 1) {
        dst[c] = { ...(src[c] ?? blankCell()) };
      }
    }
    this.mainBuffer = {
      grid: newMainGrid,
      rowRevisions: new Uint32Array(newRows),
    };
    this.altBuffer = {
      grid: VtEmulator.makeBlankGrid(newRows, newCols),
      rowRevisions: new Uint32Array(newRows),
    };
    const activeBuffer = this.active === 'main' ? this.mainBuffer : this.altBuffer;
    this.grid = activeBuffer.grid;
    this.rowRevisions = activeBuffer.rowRevisions;

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
    // RIS blanks BOTH buffers and forces main active — otherwise a
    // post-reset app would still be writing into a dormant alt screen.
    this.mainBuffer = { grid: this.grid, rowRevisions: this.rowRevisions };
    this.altBuffer = {
      grid: VtEmulator.makeBlankGrid(this.rows_, this.cols_),
      rowRevisions: new Uint32Array(this.rows_),
    };
    this.active = 'main';
    // Scrollback is cleared on RIS — a hard reset wipes history the same
    // way it wipes the grid. `maxRows` is preserved so downstream
    // configuration (tiny-shell tests, CI buffers) survives the reset.
    this.mainScrollback.rows.length = 0;
    this.mainScrollback.baseRowId = 0;
    this.mainScrollback.evictedCount = 0;
    this.mainScrollback.pinBlockedEvictions = 0;
    this.savedState1048 = null;
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
    this.pendingModeChanges.length = 0;
    const hadKittyFlags = this.currentKittyFlags() !== 0;
    this.kittyFlagStack = [0];
    if (hadKittyFlags) this.onKittyKeyboardFlagsChanged?.(0);
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
        // Bare BEL in Ground state: fire the host-supplied bell hook so the
        // UI can surface a visual flash / optional beep. BELs that terminate
        // OSC / DCS / APC / PM strings are handled in stepOsc / stepIgnore
        // and never reach here — those are string terminators, not bells.
        if (this.onBell !== undefined) {
          try {
            this.onBell();
          } catch {
            // Host callback failures must never corrupt parser state.
          }
        }
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
        // ESC \ terminator — dispatch any recognised OSC command.
        this.oscEscPending = false;
        this.dispatchOsc(this.seqBuf);
        this.state = 'Ground';
        this.seqBuf = '';
        return;
      }
      // Lone ESC in payload — stash and keep accumulating (defensive).
      this.oscEscPending = false;
      this.seqBuf += '\x1b';
    }
    if (b === BEL) {
      this.dispatchOsc(this.seqBuf);
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

  /**
   * Handle a complete OSC payload (the bytes between `ESC ]` and the
   * terminator). We recognise:
   *   - OSC 7 — working-directory report (`file://host/path`)
   *   - OSC 10 — fg color: `?` queries, everything else dropped
   *   - OSC 11 — bg color: `?` queries, everything else dropped
   * Unknown or malformed commands are silently ignored; this matches real
   * xterm's tolerance for other emitters' OSC payloads.
   */
  private dispatchOsc(payload: string): void {
    if (payload.length === 0) return;
    // Command is the digit run before the first `;`. Anything else (e.g.
    // `OSC 8;id=..;url`) is delegated to a per-command branch.
    const semi = payload.indexOf(';');
    const cmdRaw = semi === -1 ? payload : payload.slice(0, semi);
    const rest = semi === -1 ? '' : payload.slice(semi + 1);
    const cmd = parseInt(cmdRaw, 10);
    if (!Number.isFinite(cmd)) return;
    switch (cmd) {
      case 7:
        this.handleOscCwd(rest);
        return;
      case 10:
        this.handleOscColorQuery(rest, 'fg');
        return;
      case 11:
        this.handleOscColorQuery(rest, 'bg');
        return;
      default:
        return;
    }
  }

  /**
   * OSC 7 payload is `file://<host>/<path>`. We tolerate an empty host
   * (`file:///Users/...`) and percent-decode the path. Payloads without
   * the `file://` scheme are treated as raw paths for friendliness with
   * test fixtures but REAL shells always emit the scheme form. If decoding
   * throws (malformed %-escape), we drop.
   */
  private handleOscCwd(raw: string): void {
    if (this.onCwdChanged === undefined) return;
    if (raw.length === 0) return;
    let path: string | null = null;
    if (raw.startsWith('file://')) {
      const afterScheme = raw.slice('file://'.length);
      // host ends at the first `/`; anything before is the host portion
      // (often empty for local paths).
      const slash = afterScheme.indexOf('/');
      const hostAndPath = slash === -1 ? '' : afterScheme.slice(slash);
      if (hostAndPath.length === 0) return;
      try {
        path = decodeURIComponent(hostAndPath);
      } catch {
        return;
      }
    } else {
      // Non-conformant payload — drop so a misconfigured shell doesn't set
      // a nonsense cwd. Real emitters always ship the scheme.
      return;
    }
    if (path === null || path.length === 0) return;
    this.onCwdChanged(path);
  }

  /** OSC 10/11 color query — only `?` is acted on; setters are ignored. */
  private handleOscColorQuery(raw: string, which: 'fg' | 'bg'): void {
    if (raw !== '?') return;
    if (this.onRespond === undefined) return;
    const colours = this.themeColors?.() ?? {
      fg: { r: 0xff, g: 0xff, b: 0xff },
      bg: { r: 0x00, g: 0x00, b: 0x00 },
    };
    const c = which === 'fg' ? colours.fg : colours.bg;
    const cmd = which === 'fg' ? '10' : '11';
    const hex = (n: number): string =>
      Math.max(0, Math.min(255, n | 0)).toString(16).padStart(2, '0');
    // Standard xterm response: `ESC ] <cmd> ; rgb:RR/GG/BB BEL`. We use the
    // two-digit form which xterm / vte accept without complaint.
    const reply = `\x1b]${cmd};rgb:${hex(c.r)}/${hex(c.g)}/${hex(c.b)}\x07`;
    this.onRespond(new TextEncoder().encode(reply));
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
      else if (final === 'u') this.executeKittyQuery();
      // Unknown DEC private command → drop.
      return;
    }
    // Kitty keyboard protocol push/pop/set (`CSI > <flags> u`, `CSI < [n] u`,
    // `CSI = <flags> [; <mode>] u`). DECRC is `CSI u` with no private byte.
    if (final === 'u' && (priv === '>' || priv === '<' || priv === '=')) {
      this.executeKittyFlagsOp(priv, params);
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
        this.executeDsr(params);
        return;
      case 'c':
        this.executeDa(priv, params);
        return;
      default:
        // Unknown / out-of-scope — silently drop.
        return;
    }
  }

  /* ------------------------- Query responses ------------------------- */

  /**
   * DSR (Device Status Report).
   *   - `CSI 5 n` — report status. Reply `CSI 0 n` (ready).
   *   - `CSI 6 n` — report cursor position. Reply `CSI <row>;<col> R` with
   *     1-indexed values, matching xterm / ECMA-48. When the `?` private
   *     marker is present the reply would use `CSI ? <row>;<col> R`; we don't
   *     model DECORD so we always reply with the non-private form.
   *
   * All responses require `onRespond` to be wired; silent no-op otherwise.
   */
  private executeDsr(params: readonly number[]): void {
    if (this.onRespond === undefined) return;
    const mode = params[0] ?? 0;
    if (mode === 5) {
      this.onRespond(new TextEncoder().encode('\x1b[0n'));
      return;
    }
    if (mode === 6) {
      const row = (this.cursor.row | 0) + 1;
      const col = (this.cursor.col | 0) + 1;
      this.onRespond(new TextEncoder().encode(`\x1b[${row};${col}R`));
      return;
    }
    // Other DSR variants are out of scope.
  }

  /**
   * DA (Device Attributes).
   *   - `CSI c` / `CSI 0 c` → Primary DA. Reply `CSI ? 1 ; 2 c`
   *     (VT100 with advanced video option — same as xterm's default).
   *   - `CSI > 0 c` / `CSI > c` → Secondary DA. Reply
   *     `CSI > 0 ; <version> ; 0 c` where `<version>` defaults to 0 and can
   *     be overridden via `secondaryDaVersion`.
   *
   * Tertiary DA (`CSI = c`) and any other private variants are dropped.
   */
  private executeDa(priv: string, params: readonly number[]): void {
    if (this.onRespond === undefined) return;
    const first = params[0] ?? 0;
    if (priv === '' && first === 0) {
      this.onRespond(new TextEncoder().encode('\x1b[?1;2c'));
      return;
    }
    if (priv === '>' && first === 0) {
      const v = Math.max(0, this.secondaryDaVersion | 0);
      this.onRespond(new TextEncoder().encode(`\x1b[>0;${v};0c`));
      return;
    }
    // Unknown / tertiary — drop.
  }

  /* ------------------------- Kitty keyboard flags ------------------------- */

  /**
   * `CSI ? u` — report the flags on the top of the stack. When the stack is
   * empty (should never happen — we seed with `0`) we answer with `0` so
   * well-behaved apps don't spin. Silently dropped if `onRespond` is unset,
   * mirroring DSR / DA behaviour.
   */
  private executeKittyQuery(): void {
    if (this.onRespond === undefined) return;
    const top = this.currentKittyFlags();
    this.onRespond(new TextEncoder().encode(`\x1b[?${top}u`));
  }

  /**
   * Dispatches the three "mutation" forms of `CSI u`:
   *
   *   - `CSI > <flags> u`   push a new top (stack grows by 1)
   *   - `CSI < [n] u`       pop `n` (default 1) top entries
   *   - `CSI = <flags> u`   set the current top (mode 1 = OR the bits in)
   *   - `CSI = <flags> ; 2 u`  set (replace top exactly)
   *   - `CSI = <flags> ; 3 u`  clear (AND-NOT the bits from top)
   *
   * We keep a bounded stack (`KITTY_STACK_MAX`) — extra pushes drop the
   * oldest entry, matching both xterm and kitty behaviour under deep
   * nesting. Flags are masked to the 5 bits defined by the spec; higher
   * bits are tolerated on input but lost on echo.
   */
  private executeKittyFlagsOp(priv: string, params: readonly number[]): void {
    const prev = this.currentKittyFlags();
    if (priv === '>') {
      const flags = (params[0] ?? 0) & VtEmulator.KITTY_FLAG_MASK;
      this.kittyFlagStack.push(flags);
      // Cap stack depth — drop oldest on overflow so memory stays bounded.
      if (this.kittyFlagStack.length > VtEmulator.KITTY_STACK_MAX) {
        this.kittyFlagStack.shift();
      }
    } else if (priv === '<') {
      const n = Math.max(1, params[0] ?? 1);
      for (let i = 0; i < n; i++) {
        if (this.kittyFlagStack.length > 1) this.kittyFlagStack.pop();
        else this.kittyFlagStack[0] = 0;
      }
    } else if (priv === '=') {
      const flags = (params[0] ?? 0) & VtEmulator.KITTY_FLAG_MASK;
      const mode = params[1] ?? 1;
      const top = this.currentKittyFlags();
      let next: number;
      if (mode === 2) next = flags;
      else if (mode === 3) next = top & ~flags & VtEmulator.KITTY_FLAG_MASK;
      else next = (top | flags) & VtEmulator.KITTY_FLAG_MASK; // mode 1 / default — OR
      const idx = this.kittyFlagStack.length - 1;
      this.kittyFlagStack[idx >= 0 ? idx : 0] = next;
      if (this.kittyFlagStack.length === 0) this.kittyFlagStack.push(next);
    }
    const nowTop = this.currentKittyFlags();
    if (nowTop !== prev) {
      this.onKittyKeyboardFlagsChanged?.(nowTop);
    }
  }

  /** Convenience — current top-of-stack flags (always defined thanks to seed). */
  private currentKittyFlags(): number {
    if (this.kittyFlagStack.length === 0) return 0;
    return this.kittyFlagStack[this.kittyFlagStack.length - 1] ?? 0;
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
    // `pendingCharsetSkip` is now consumed at the feed() top-level loop so
    // control bytes (LF/HT/etc.) between `ESC (` and the designator byte
    // don't leave the flag set and drop the next printable. Keep a
    // defensive check here in case the flag is set via a path that
    // reaches printGrapheme directly — still swallow one grapheme.
    if (this.pendingCharsetSkip) {
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
    let start = Math.max(0, fromCol);
    let end = Math.min(this.cols_ - 1, toCol);
    if (start > end) return;
    // Wide-char invariant: a 2-col grapheme is stored as
    //   [col]  { width: 2, grapheme: 'X' }   (leader)
    //   [col+1]{ width: 0, grapheme: '' }    (trailer)
    // Erasing only one half would leave a half-wide ghost. Expand the
    // range outward when a boundary splits a wide-char pair.
    if (start > 0 && rowArr[start]?.width === 0) {
      // `start` points at a trailer — include its leader one column left.
      start -= 1;
    }
    if (end < this.cols_ - 1 && rowArr[end]?.width === 2) {
      // `end` points at a leader — include its trailer one column right.
      end += 1;
    }
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
    // Capture rows about to fall off the top into the main-buffer scrollback
    // ring — but ONLY when the scroll region starts at row 0 AND we're on
    // the main buffer. A scroll region pinned to a sub-rectangle (e.g.
    // `less -N`, which sets DECSTBM to protect a status line) is an
    // app-managed working region; those rows are not user history and
    // don't belong in scrollback. Alt buffer scroll-offs never capture.
    if (this.active === 'main' && top === 0 && this.mainScrollback.maxRows > 0) {
      for (let r = top; r < top + count; r += 1) {
        const src = this.grid[r];
        if (src !== undefined) this.captureToScrollback(src);
      }
    }
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

  /**
   * Clone `cells` into the main-buffer scrollback ring, then enforce the
   * bounded-cap policy.
   *
   * Eviction walks from index 0 (oldest). If the head row is `pinned`,
   * eviction PAUSES — the ring is allowed to grow past `maxRows` until an
   * unpinned row reaches the head. This preserves the invariant that a P1
   * block whose start row has been pinned can always look up that row by
   * id, regardless of how much traffic has scrolled past. Once the block
   * completes and the pin is released, the next capture will flush the
   * accumulated backlog down to the cap.
   *
   * `pinBlockedEvictions` counts eviction attempts that paused — useful as
   * a canary in tests and, later, as a telemetry signal if users report
   * runaway memory during very-long-running block executions.
   */
  private captureToScrollback(cells: readonly InternalCell[]): void {
    const ring = this.mainScrollback;
    if (ring.maxRows === 0) return;
    const clonedCells: InternalCell[] = new Array(cells.length);
    for (let i = 0; i < cells.length; i += 1) {
      // Spread keeps the plain-object shape so V8 can keep the hidden-class
      // stable across scrollback rows — faster than a hand-rolled copier
      // at this call frequency (≤ 1 row per LF).
      clonedCells[i] = { ...cells[i]! };
    }
    const row: ScrollbackRow = { cells: clonedCells };
    ring.rows.push(row);
    // Evict down to cap. If the head is pinned, stop — we'll try again on
    // the next capture. Unpinned rows at the head shift off normally and
    // bump both `evictedCount` (diagnostic) and `baseRowId` (so external
    // row-id refs stay monotonic).
    while (ring.rows.length > ring.maxRows) {
      const head = ring.rows[0];
      if (head === undefined) break;
      if (head.pinned === true) {
        ring.pinBlockedEvictions += 1;
        break;
      }
      ring.rows.shift();
      ring.evictedCount += 1;
      ring.baseRowId += 1;
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
    // Per xterm spec: parameter value 0 means "default". DECSTBM's defaults
    // are top=1 (first row) and bottom=rows (last row). Handling 0 here
    // keeps `CSI 0;24 r` working — it should set the full-screen region
    // on a 24-row terminal, not collapse to an invalid negative-top state.
    const topRaw = topParam === undefined || topParam === 0 ? 1 : topParam;
    const bottomRaw =
      bottomParam === undefined || bottomParam === 0 ? this.rows_ : bottomParam;
    const top = topRaw - 1;
    const bottom = bottomRaw - 1;
    if (top >= 0 && bottom < this.rows_ && top <= bottom) {
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
    // Per xterm spec (DECSC): saves cursor position, SGR attributes,
    // charset state, wrap flag (DECAWM), and origin mode. The scroll
    // region is NOT saved — restoring it would violate xterm semantics
    // and break apps like vim that DECSTBM between DECSC/DECRC pairs.
    this.savedState = {
      cursor: { ...this.cursor },
      sgr: { ...this.sgr },
      autoWrap: this.autoWrap,
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
    this.autoWrap = this.savedState.autoWrap;
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
        case 47:
          // DECSET 47 (h) / DECRESET 47 (l): legacy alt-buffer toggle.
          // Does NOT save the cursor and does NOT clear the buffer on
          // entry — apps that used `47` managed cursor saves themselves
          // via DECSC. This is the least-common-denominator form.
          this.swapAlt(enable, /*clearOnEnter=*/ false);
          break;
        case 1047:
          // DECSET 1047 (h): enter alt, CLEAR alt on entry. DECRESET 1047
          // (l): switch back to main. xterm quirk — when exiting 1047 it
          // also ED(2)-erases the alt buffer so the next re-entry starts
          // clean without the app having to ask. We mirror that quirk by
          // clearing alt on *both* entry and transition back when already
          // on alt.
          if (enable) {
            this.swapAlt(true, /*clearOnEnter=*/ true);
          } else {
            if (this.active === 'alt') this.clearActiveGrid();
            this.swapAlt(false, /*clearOnEnter=*/ false);
          }
          break;
        case 1048:
          // DECSET 1048 (h) — save cursor + SGR + autoWrap (like DECSC
          // but into a SEPARATE slot so DECSC state isn't stomped).
          // DECRESET 1048 (l) — restore.
          if (enable) this.saveCursor1048();
          else this.restoreCursor1048();
          break;
        case 1049:
          // DECSET 1049 (h) — combined: save cursor (1048 slot), swap to
          // alt, clear alt. This is the sequence vim / htop / less use on
          // entry. DECRESET 1049 (l) — swap back to main, restore cursor.
          if (enable) {
            this.saveCursor1048();
            this.swapAlt(true, /*clearOnEnter=*/ true);
          } else {
            this.swapAlt(false, /*clearOnEnter=*/ false);
            this.restoreCursor1048();
          }
          break;
        default:
          // Unknown / unsupported — drop silently.
          break;
      }
    }
  }

  /**
   * Core alt/main flip. Swaps `grid` + `rowRevisions` pointers between the
   * active buffer and its dormant counterpart, optionally clearing the
   * newly-active buffer on entry (1047 / 1049 semantics; 47 skips this).
   *
   * No-op when `toAlt` matches the current active buffer, matching the
   * xterm behaviour that successive `CSI ?1049h` within the same alt
   * session are idempotent. When the flip actually happens, emits a
   * `ModeChanged` envelope synchronously — BEFORE any grid delta for the
   * newly-active buffer. We also clear any row-level dirtiness that was
   * accumulated for the old active buffer; those rows belong to a buffer
   * the downstream mirror is about to leave, and re-emitting them after
   * the mode flip would attribute stale main content to the alt buffer.
   */
  private swapAlt(toAlt: boolean, clearOnEnter: boolean): void {
    const target: BufferKind = toAlt ? 'alt' : 'main';
    if (this.active === target) return;

    // Flush pending dirty rows of the currently-active buffer — they are
    // still attributable to the OLD buffer, so we emit the delta first,
    // then flip. This keeps the "mode flip precedes deltas for the NEW
    // buffer" invariant intact.
    this.flushPendingDeltaForCurrentBuffer();

    // Persist current grid back into whichever buffer slot is losing focus.
    if (this.active === 'main') {
      this.mainBuffer.grid = this.grid;
      this.mainBuffer.rowRevisions = this.rowRevisions;
    } else {
      this.altBuffer.grid = this.grid;
      this.altBuffer.rowRevisions = this.rowRevisions;
    }

    const nextBuffer = toAlt ? this.altBuffer : this.mainBuffer;
    this.grid = nextBuffer.grid;
    this.rowRevisions = nextBuffer.rowRevisions;
    this.active = target;
    if (clearOnEnter) {
      this.clearActiveGrid();
    }
    this.pendingModeChanges.push({ mode: 'alt_screen', value: toAlt });
    // Emit the mode-change envelope immediately so downstream sees the
    // flip before any subsequent delta/cursor event sourced from the new
    // buffer. Any dirty rows on the NEW buffer (e.g. from clearOnEnter)
    // will be emitted at feed-end via emitDirty().
    this.emitPendingModeChanges();
    // Clear feed-start cursor so a follow-up cursor_moved emission
    // doesn't fire spuriously just because the cursor "moved" relative
    // to pre-swap state on the previous buffer.
    this.cursorAtFeedStart = { ...this.cursor };
  }

  /**
   * Mid-feed flush of any cell mutations accumulated for the *current*
   * active buffer before it's about to be swapped out. This runs the
   * normal emitDirty path but preserves the cursor-at-feed-start
   * bookkeeping so the post-swap batch picks up where we left off.
   */
  private flushPendingDeltaForCurrentBuffer(): void {
    if (this.dirtyRows.size === 0 && cursorEqual(this.cursorAtFeedStart, this.cursor)) {
      return;
    }
    this.emitDirty();
  }

  /** Blank every cell of the currently-active grid and mark all rows dirty. */
  private clearActiveGrid(): void {
    for (let r = 0; r < this.rows_; r += 1) {
      const row = this.grid[r];
      if (row === undefined) continue;
      for (let c = 0; c < this.cols_; c += 1) {
        row[c] = blankCell();
      }
      this.markDirty(r);
    }
  }

  /** DECSET 1048 save slot. Distinct from DECSC. */
  private saveCursor1048(): void {
    this.savedState1048 = {
      cursor: { ...this.cursor },
      sgr: { ...this.sgr },
      autoWrap: this.autoWrap,
    };
  }

  /**
   * DECRESET 1048 / 1049 restore. Per xterm, an unsaved restore homes the
   * cursor; we mirror that so tests don't accidentally rely on stale state.
   */
  private restoreCursor1048(): void {
    if (!this.savedState1048) {
      this.cursor.row = 0;
      this.cursor.col = 0;
      this.cursor.pendingWrap = false;
      return;
    }
    this.cursor = { ...this.savedState1048.cursor };
    // Clamp to current dimensions — a resize between save and restore
    // could have shrunk the grid under us.
    this.cursor.row = Math.min(this.cursor.row, this.rows_ - 1);
    this.cursor.col = Math.min(this.cursor.col, this.cols_ - 1);
    this.cursor.pendingWrap = false;
    this.sgr = { ...this.savedState1048.sgr };
    this.autoWrap = this.savedState1048.autoWrap;
  }

  /**
   * Emit any `ModeChanged` envelopes that accumulated since the last
   * flush. Called from `swapAlt` (for immediate visibility) and from
   * `emitDirty` (defensive — should be a no-op there in the normal path).
   */
  private emitPendingModeChanges(): void {
    if (this.pendingModeChanges.length === 0) return;
    const changes = this.pendingModeChanges.slice();
    this.pendingModeChanges.length = 0;
    const payload: ModeChangedPayload = {
      kind: 'mode_changed',
      changes,
      state: this.buildModeState(),
    };
    this.emit(payload);
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
    this.grid = VtEmulator.makeBlankGrid(rows, cols);
    this.rowRevisions = new Uint32Array(rows);
  }

  /**
   * Allocate a fresh grid of blank cells. Factored out so both buffers
   * (main + alt) share one allocator — and so `resize()` / `reset()` can
   * build a new grid without accidentally aliasing `this.grid`.
   */
  private static makeBlankGrid(rows: number, cols: number): InternalCell[][] {
    const grid = new Array<InternalCell[]>(rows);
    for (let r = 0; r < rows; r += 1) {
      const row = new Array<InternalCell>(cols);
      for (let c = 0; c < cols; c += 1) row[c] = blankCell();
      grid[r] = row;
    }
    return grid;
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
      buffer_kind: this.active,
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
    // Defensive: mode changes should have been drained at the point of
    // the swap, but if a caller ever deferred them we emit now BEFORE any
    // grid delta so the "mode first, deltas second" invariant holds.
    this.emitPendingModeChanges();
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
      buffer_kind: this.active,
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
      alt_screen: this.active === 'alt',
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
    // Two wire forms are observed in the wild:
    //   4-arg: `CSI 38;2;r;g;b m`  (xterm, most emitters)
    //   5-arg: `CSI 38;2;cs;r;g;b m` (konsole, older vim patches —
    //     `cs` is a colorspace id that nobody actually consumes)
    //
    // Also: when an emitter uses colon subparams `CSI 38:2::r:g:b m`
    // our CSI parser (stepCsi L438) folds `:` into `;`. The ECMA-48 /
    // ITU-T T.416 colon form carries an empty "colorspace" slot between
    // `2` and `r`, which after collapse becomes `[38, 2, 0, r, g, b]`
    // — indistinguishable from the 5-arg semicolon form. So the same
    // heuristic handles both.
    //
    // Heuristic: if at least 5 params follow (`mode, a, b, c, d` after `i`),
    // try the 5-arg form first (skip the colorspace). If only 4 follow,
    // use them directly as r/g/b.
    const avail = params.length - i - 1;
    if (avail >= 5) {
      // 5-arg form: skip [i+1] (colorspace), use [i+2..i+4] as r/g/b.
      const r = params[i + 2];
      const g = params[i + 3];
      const b = params[i + 4];
      if (r === undefined || g === undefined || b === undefined) {
        return { color: undefined, consumed: 1 };
      }
      return {
        color: { kind: 'rgb', r: clamp255(r), g: clamp255(g), b: clamp255(b) },
        consumed: 5,
      };
    }
    const r = params[i + 1];
    const g = params[i + 2];
    const b = params[i + 3];
    if (r === undefined || g === undefined || b === undefined) {
      const a = [r, g, b].filter((x) => x !== undefined).length;
      return { color: undefined, consumed: 1 + a };
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


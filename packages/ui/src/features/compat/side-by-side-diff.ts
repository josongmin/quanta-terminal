/**
 * side-by-side-diff — pure diff function for two `FrameSnapshot`s.
 *
 * Consumed by the dev-only `SideBySideHarness` (EPIC-H §4.3). The function
 * compares a canvas-renderer snapshot against a legacy xterm snapshot and
 * returns every divergence as a typed `Diff` object.
 *
 * Cells are compared by:
 *   - grapheme
 *   - width (cols)
 *   - SGR attr blob
 *   - hyperlink id
 *
 * Cursors are compared by row/col and visibility. Mode diffs surface a
 * per-mode key mismatch (alt_screen, bracketed_paste, decckm, …) — every
 * enum on TerminalModeState is scanned.
 *
 * Input byte diffs are supplied separately — the harness taps the input
 * encoder via `recordInputBytes` and pushes `InputByteDiff` entries when
 * the two paths produced different byte sequences.
 */

export interface CellSnapshot {
  readonly grapheme: string;
  readonly cols: number;
  readonly sgr: string;
  readonly hyperlink_id: number;
}

export interface CursorSnapshot {
  readonly row: number;
  readonly col: number;
  readonly visible: boolean;
}

export interface ModeSnapshot {
  readonly [key: string]: boolean | number | string | undefined;
}

export interface FrameSnapshot {
  readonly rows: number;
  readonly cols: number;
  /** rows × cols matrix — [row][col]. Rows shorter than `cols` are padded. */
  readonly cells: ReadonlyArray<ReadonlyArray<CellSnapshot>>;
  readonly cursor: CursorSnapshot;
  readonly mode: ModeSnapshot;
}

export interface CellDiff {
  readonly kind: 'cell';
  readonly row: number;
  readonly col: number;
  readonly canvas: CellSnapshot;
  readonly xterm: CellSnapshot;
}

export interface CursorDiff {
  readonly kind: 'cursor';
  readonly canvas: CursorSnapshot;
  readonly xterm: CursorSnapshot;
}

export interface ModeDiff {
  readonly kind: 'mode';
  readonly mode: string;
  readonly canvas: unknown;
  readonly xterm: unknown;
}

export interface InputByteDiff {
  readonly kind: 'input';
  /** Time (ms) relative to harness start. */
  readonly at: number;
  readonly canvasBytes: Uint8Array;
  readonly xtermBytes: Uint8Array;
}

export type Diff = CellDiff | CursorDiff | ModeDiff | InputByteDiff;

const BLANK_CELL: CellSnapshot = Object.freeze({
  grapheme: '',
  cols: 1,
  sgr: '0x0000000000000000',
  hyperlink_id: 0,
});

function cellEqual(a: CellSnapshot, b: CellSnapshot): boolean {
  return (
    a.grapheme === b.grapheme &&
    a.cols === b.cols &&
    a.sgr === b.sgr &&
    a.hyperlink_id === b.hyperlink_id
  );
}

/** Compare two frames and return every divergent cell / cursor / mode. */
export function diffFrames(canvas: FrameSnapshot, xterm: FrameSnapshot): Diff[] {
  const diffs: Diff[] = [];

  const rows = Math.min(canvas.rows, xterm.rows);
  const cols = Math.min(canvas.cols, xterm.cols);

  // Emit size diffs as mode diffs on `__dims__` so the caller sees the
  // divergence even when rows/cols disagree.
  if (canvas.rows !== xterm.rows || canvas.cols !== xterm.cols) {
    diffs.push({
      kind: 'mode',
      mode: '__dims__',
      canvas: { rows: canvas.rows, cols: canvas.cols },
      xterm: { rows: xterm.rows, cols: xterm.cols },
    });
  }

  for (let r = 0; r < rows; r += 1) {
    const cRow = canvas.cells[r] ?? [];
    const xRow = xterm.cells[r] ?? [];
    for (let c = 0; c < cols; c += 1) {
      const cc = cRow[c] ?? BLANK_CELL;
      const xc = xRow[c] ?? BLANK_CELL;
      if (!cellEqual(cc, xc)) {
        diffs.push({ kind: 'cell', row: r, col: c, canvas: cc, xterm: xc });
      }
    }
  }

  if (
    canvas.cursor.row !== xterm.cursor.row ||
    canvas.cursor.col !== xterm.cursor.col ||
    canvas.cursor.visible !== xterm.cursor.visible
  ) {
    diffs.push({ kind: 'cursor', canvas: canvas.cursor, xterm: xterm.cursor });
  }

  const seen = new Set<string>();
  const allKeys = [
    ...Object.keys(canvas.mode),
    ...Object.keys(xterm.mode),
  ] as string[];
  for (const key of allKeys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const cv = canvas.mode[key];
    const xv = xterm.mode[key];
    if (cv !== xv) {
      diffs.push({ kind: 'mode', mode: key, canvas: cv, xterm: xv });
    }
  }

  return diffs;
}

/** Utility — count only cell diffs (used in tests + the dev overlay). */
export function countCellDiffs(diffs: readonly Diff[]): number {
  let n = 0;
  for (const d of diffs) if (d.kind === 'cell') n += 1;
  return n;
}

/** Build a `FrameSnapshot` from a flat rows array. Handy in tests. */
export function buildSnapshot(params: {
  readonly rows: number;
  readonly cols: number;
  readonly cells: ReadonlyArray<ReadonlyArray<CellSnapshot>>;
  readonly cursor: CursorSnapshot;
  readonly mode: ModeSnapshot;
}): FrameSnapshot {
  return params;
}

/** Empty-ish comparison — convenient baseline frame used by fixtures. */
export function blankSnapshot(rows: number, cols: number): FrameSnapshot {
  const cells: CellSnapshot[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const row: CellSnapshot[] = [];
    for (let c = 0; c < cols; c += 1) row.push(BLANK_CELL);
    cells.push(row);
  }
  return {
    rows,
    cols,
    cells,
    cursor: { row: 0, col: 0, visible: true },
    mode: {},
  };
}

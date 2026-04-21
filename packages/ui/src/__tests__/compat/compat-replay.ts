/**
 * Compat-fixture replay harness.
 *
 * Plan 0005 P0 Epic ε — scaffolding.
 *
 * Loads a recorded PTY byte stream (`input.bytes`), feeds it into a
 * `VtEmulator`, and verifies the grid state against `checkpoints.json` at
 * the recorded byte offsets. This is the core engine behind the
 * `C-ED-*` / `C-INT-*` / `C-PG-*` compat matrix (see
 * `docs/plans/0005-sota-convergence/test-strategy.md` §1).
 *
 * Design notes
 * ------------
 *  - No real terminal required. We replay bytes deterministically into the
 *    same `VtEmulator` that ships in production, then read back the grid
 *    via the emulator's `@internal` test accessors (`_getCell`,
 *    `_getCursor`). That means this harness is a true end-to-end test of
 *    the engine, minus the live PTY.
 *  - Row projection is structural, not byte-for-byte. A row is reduced to
 *    `{ text, widths, sgrDigest? }` (see `projectRow`). `text` joins
 *    graphemes with trailing blanks stripped; `widths` preserves wide-cell
 *    positions (so CJK round-trips correctly); `sgrDigest` is a SHA-256
 *    over per-cell SGR tuples, included only when the fixture cares about
 *    styling (reverse-video status bar, coloured diff output, etc.).
 *  - Checkpoints assert only the rows listed in `expected.selected_rows`,
 *    keyed by row index. Snapshots stay small and human-reviewable.
 *  - Replay is deterministic: same fixture bytes → bit-identical report.
 */

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { VtEmulator } from '../../shared/lib/vt-emulator/VtEmulator.js';
import type { GridEventEnvelope, GridPayload } from '../../shared/lib/grid-mirror/types.js';

/* ---------- Fixture on-disk shapes ---------- */

/**
 * Current snapshot-format version. Bump whenever the shape of
 * `RowProjection` or `CheckpointExpected` changes in a non-backwards
 * compatible way (grid projection semantics drift, new required fields,
 * etc.).
 *
 * `meta.json.snapshotFormatVersion` is optional for backwards compat with
 * the initial wave of fixtures (authored before the field existed); when
 * present the harness refuses to replay unless it matches. That protects
 * us from a future refactor silently rewriting projections.
 */
export const COMPAT_SNAPSHOT_FORMAT_VERSION = 1;

/** Shape of `meta.json`. */
export interface CompatFixtureMeta {
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
  readonly description: string;
  /** ISO-8601 authoring timestamp, included for audit / diff reviewability. */
  readonly authoredAt: string;
  /**
   * Preferred origin label.
   *
   *  - `synthetic`: hand-authored `input.bytes` (every compat fixture today).
   *  - `recorded`: captured from a live PTY via `tools/compat-record`; ships
   *    with a pointer to the source session.
   *
   * Optional for back-compat with the initial fixtures that used the older
   * `synthetic: boolean` flag; new fixtures SHOULD set `kind`.
   */
  readonly kind?: 'synthetic' | 'recorded';
  /** @deprecated use `kind` — left in place so existing fixtures still validate. */
  readonly synthetic?: boolean;
  /**
   * Optional compat ID. When present, the harness asserts it matches the
   * fixture directory basename so a renamed directory can't silently
   * desync from the registry.
   */
  readonly id?: string;
  /**
   * Snapshot-format version (see `COMPAT_SNAPSHOT_FORMAT_VERSION`). Omit
   * to opt out of the shape-drift guard (legacy fixtures); set to pin.
   */
  readonly snapshotFormatVersion?: number;
}

/**
 * A structural projection of a single grid row.
 *
 *  - `text`: grapheme-joined printable cells, with trailing blanks stripped.
 *    Wide-leading cells contribute one grapheme; their width-0 continuation
 *    contributes nothing.
 *  - `widths`: one entry per column (0 = wide-trailing, 1 = narrow,
 *    2 = wide-leading). Length equals the fixture's `cols`.
 *  - `sgrDigest`: SHA-256 of the per-cell SGR tuple stream. Optional —
 *    checkpoints that don't care about styling omit this field.
 */
export interface RowProjection {
  readonly text: string;
  readonly widths: readonly (0 | 1 | 2)[];
  readonly sgrDigest?: string;
}

/** What the fixture expects at a given byte offset. */
export interface CheckpointExpected {
  readonly cursor?: {
    readonly row: number;
    readonly col: number;
  };
  readonly mode?: {
    /**
     * `alt_screen` on the emitted `TerminalModeState`. Plan 0005 Epic α
     * flips this to `true` after DECSET 1049h. Until Epic α lands, the
     * emulator hard-codes `false` — that's why C-ED-01 is an intentional
     * RED test (see `test.fails(...)` in the integration spec).
     */
    readonly altScreen: boolean;
  };
  /**
   * Row-by-row projections. Keys are row indices (0-based). Rows not listed
   * are not checked. Keep the smallest set that makes the assertion clear.
   */
  readonly selected_rows?: Readonly<Record<string, RowProjection>>;
  /**
   * Scrollback ring assertions. Present on checkpoints that care about
   * alt-buffer-vs-scrollback correctness. Specifically, TUI fixtures
   * (top / htop / less) must assert `rowCount === 0` after an alt-screen
   * cycle to prove that rapid alt-buffer repaints NEVER leak into the
   * main-buffer scrollback ring.
   *
   * Engine contract (Epic α3): only main-buffer row evictions append to
   * scrollback; alt-buffer paints are ephemeral. If this invariant ever
   * regresses, a fixture's `rowCount` assertion is the canary.
   */
  readonly scrollback?: {
    /** Exact expected row count in `emulator.getScrollback().rows`. */
    readonly rowCount: number;
    /**
     * Optional row-by-row projections. Keys are scrollback indices (0-based,
     * oldest-first — matches `getScrollback().rows[i]`). Rows not listed are
     * not checked; keep the smallest set that makes the assertion clear.
     *
     * Enables fixtures that assert EXACTLY what was evicted to scrollback
     * (e.g. "after two full main-buffer repaints, row 0 of scrollback is
     * the first evicted line"). Only populate when the row content is
     * load-bearing; for mere "alt-paint didn't leak" assertions, `rowCount`
     * is sufficient.
     */
    readonly rows?: Readonly<Record<string, RowProjection>>;
  };
  /**
   * In-stream resize hook. When present, the harness calls
   * `emulator.resize(rows, cols)` at this checkpoint's byte offset BEFORE
   * running diffs. Used by `C-UX-02` and any future fixture that exercises
   * resize semantics without needing a fresh byte stream per dimension.
   *
   * Semantics:
   *  - The resize fires exactly once per checkpoint that declares it.
   *  - Multiple checkpoints at the same `at_byte_offset` cycle through
   *    resize dimensions (main buffer reflows; alt buffer clears per
   *    xterm). See `VtEmulator.resize()`.
   *  - Diffs that follow are projected against the NEW dimensions: row
   *    indices are validated against `emulator.getDimensions().rows`, and
   *    `selected_rows[*].widths` arrays must match the new column count.
   */
  readonly resize?: {
    readonly cols: number;
    readonly rows: number;
  };
}

/** One checkpoint entry in `checkpoints.json`. */
export interface CheckpointSpec {
  /** Byte offset into `input.bytes` AFTER which this checkpoint runs. */
  readonly at_byte_offset: number;
  readonly description: string;
  readonly expected: CheckpointExpected;
}

/* ---------- Report shape ---------- */

export interface CheckpointDiff {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface FailedCheckpoint {
  readonly index: number;
  readonly description: string;
  readonly at_byte_offset: number;
  readonly diff: readonly CheckpointDiff[];
}

/**
 * Byte accounting per Plan 0005 test-strategy §6.
 *
 * Invariant:  `inputBytes === feedBytes + droppedBytes`
 *
 *  - `inputBytes`: size of `input.bytes` on disk.
 *  - `feedBytes`:  sum of every chunk passed to `VtEmulator.feed()`.
 *  - `droppedBytes`: bytes rejected by an emergency drop path (always 0
 *    for P0 compat fixtures — compat streams are tiny and never exceed
 *    the soft/hard caps). Tracked so the invariant generalises to the
 *    P1 stress harness where emergency drops ARE expected under load.
 */
export interface ByteAccounting {
  readonly inputBytes: number;
  readonly feedBytes: number;
  readonly droppedBytes: number;
}

export interface CompatReport {
  readonly passed: boolean;
  readonly failedCheckpoints: readonly FailedCheckpoint[];
  /**
   * Minimal perf stub. Plan 0005 Epic ε §4.5 will grow a real harness —
   * for now we only surface the two coarse phase counts so existing tests
   * don't need to mutate when the real numbers land.
   */
  readonly perf: {
    readonly totalFeedMs: number;
    readonly paintSimMs: number;
  };
  /** See `ByteAccounting`. Assert `inputBytes === feedBytes + droppedBytes`. */
  readonly byteAccounting: ByteAccounting;
}

/* ---------- Public entry point ---------- */

/**
 * Replays the fixture at `fixtureDir` against a fresh `VtEmulator`.
 *
 * Resolution rules:
 *  - `meta.json` / `checkpoints.json` are UTF-8 JSON.
 *  - `input.bytes` is raw binary (no encoding, no framing).
 *
 * Determinism: given the same fixture, this returns byte-identical reports
 * across runs. The only non-deterministic field is `perf.*Ms` which is
 * excluded from the equality contract.
 */
export async function replayCompatFixture(
  fixtureDir: string,
): Promise<CompatReport> {
  const meta = await readJson<CompatFixtureMeta>(
    path.join(fixtureDir, 'meta.json'),
  );
  validateMeta(fixtureDir, meta);
  const checkpoints = await readJson<readonly CheckpointSpec[]>(
    path.join(fixtureDir, 'checkpoints.json'),
  );
  // Read as raw bytes — `fs.readFile` without an encoding returns a Node
  // `Buffer`, which subclasses `Uint8Array`. Wrap explicitly so downstream
  // TypedArray semantics are fully portable (the Node `Buffer` shape
  // extends but also overrides `.slice()`, and the spread of Node versions
  // we support has historically differed on `.subarray()` view aliasing).
  const bytes = await fs.readFile(path.join(fixtureDir, 'input.bytes'));
  const input = new Uint8Array(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  // Envelopes are captured so assertions can inspect `mode_state`. We walk
  // them in reverse for `latestModeState` because mode lives on snapshots
  // only (Epic α will grow `mode_changed` payloads).
  const envs: GridEventEnvelope<GridPayload>[] = [];
  const emulator = new VtEmulator({
    sessionId: 'compat-replay',
    rows: meta.rows,
    cols: meta.cols,
    onEnvelope: (env) => envs.push(env),
  });

  const SLICE = 4096;
  const failed: FailedCheckpoint[] = [];
  let fedUpTo = 0;
  let feedBytes = 0;
  const feedStart = nowMs();

  // Sort checkpoints by offset so out-of-order authoring doesn't break us.
  const ordered = [...checkpoints].sort(
    (a, b) => a.at_byte_offset - b.at_byte_offset,
  );

  const feedSlice = (from: number, to: number): void => {
    const chunk = input.subarray(from, to);
    emulator.feed(chunk);
    feedBytes += chunk.byteLength;
  };

  for (let i = 0; i < ordered.length; i += 1) {
    const cp = ordered[i]!;
    // Feed in SLICE-sized chunks up to the checkpoint's byte offset.
    while (fedUpTo < cp.at_byte_offset && fedUpTo < input.length) {
      const next = Math.min(fedUpTo + SLICE, cp.at_byte_offset, input.length);
      feedSlice(fedUpTo, next);
      fedUpTo = next;
    }
    // In-stream resize hook. Fires BEFORE the diff so assertions in this
    // same checkpoint see the grid at the new dimensions. `VtEmulator.resize`
    // takes (rows, cols); the checkpoint field is declared `{ cols, rows }`
    // to match the common "cols × rows" display form.
    if (cp.expected.resize) {
      emulator.resize(cp.expected.resize.rows, cp.expected.resize.cols);
    }
    const diff = diffCheckpoint(emulator, envs, cp, meta);
    if (diff.length > 0) {
      failed.push({
        index: i,
        description: cp.description,
        at_byte_offset: cp.at_byte_offset,
        diff,
      });
    }
  }

  // Drain remaining bytes (keeps the emulator in a consistent post-fixture
  // state; future checkpoints or perf harness can observe final state too).
  while (fedUpTo < input.length) {
    const next = Math.min(fedUpTo + SLICE, input.length);
    feedSlice(fedUpTo, next);
    fedUpTo = next;
  }
  const totalFeedMs = nowMs() - feedStart;

  return {
    passed: failed.length === 0,
    failedCheckpoints: failed,
    perf: {
      totalFeedMs,
      // Paint simulation isn't implemented here (separate perf harness).
      paintSimMs: 0,
    },
    byteAccounting: {
      inputBytes: input.byteLength,
      feedBytes,
      // No emergency drop path in the compat harness — stress tests that
      // exercise the batcher's 256 MiB hard cap will flip this counter.
      droppedBytes: 0,
    },
  };
}

/* ---------- Meta validation ---------- */

/**
 * Validate `meta.json` against the hard invariants.
 *
 * The harness aborts replay on violation so a broken fixture fails fast
 * with a clear error rather than producing subtle checkpoint mismatches.
 *
 *  - `cols` / `rows` positive integers.
 *  - `id`, if present, equals the directory basename.
 *  - `snapshotFormatVersion`, if present, equals `COMPAT_SNAPSHOT_FORMAT_VERSION`.
 *  - `kind`, if present, is one of the allowed literals.
 */
function validateMeta(fixtureDir: string, meta: CompatFixtureMeta): void {
  if (!Number.isInteger(meta.cols) || meta.cols <= 0) {
    throw new Error(
      `compat-replay: invalid meta.cols=${String(meta.cols)} in ${fixtureDir}`,
    );
  }
  if (!Number.isInteger(meta.rows) || meta.rows <= 0) {
    throw new Error(
      `compat-replay: invalid meta.rows=${String(meta.rows)} in ${fixtureDir}`,
    );
  }
  const dirBasename = path.basename(fixtureDir);
  if (meta.id !== undefined && meta.id !== dirBasename) {
    throw new Error(
      `compat-replay: meta.id=${meta.id} does not match directory basename ${dirBasename}`,
    );
  }
  if (meta.kind !== undefined && meta.kind !== 'synthetic' && meta.kind !== 'recorded') {
    throw new Error(
      `compat-replay: meta.kind must be 'synthetic' | 'recorded', got ${String(meta.kind)}`,
    );
  }
  if (
    meta.snapshotFormatVersion !== undefined &&
    meta.snapshotFormatVersion !== COMPAT_SNAPSHOT_FORMAT_VERSION
  ) {
    throw new Error(
      `compat-replay: snapshotFormatVersion mismatch in ${dirBasename}: ` +
        `fixture=${String(meta.snapshotFormatVersion)}, ` +
        `harness=${COMPAT_SNAPSHOT_FORMAT_VERSION}. ` +
        `Refusing to replay against a drifted snapshot shape. ` +
        `Either bump the fixture (and re-review) or bump the harness constant.`,
    );
  }
}

/* ---------- Checkpoint diffing ---------- */

function diffCheckpoint(
  emulator: VtEmulator,
  envs: readonly GridEventEnvelope<GridPayload>[],
  cp: CheckpointSpec,
  meta: CompatFixtureMeta,
): CheckpointDiff[] {
  const diff: CheckpointDiff[] = [];

  if (cp.expected.cursor) {
    const got = emulator._getCursor();
    if (got.row !== cp.expected.cursor.row) {
      diff.push({
        field: 'cursor.row',
        expected: cp.expected.cursor.row,
        actual: got.row,
      });
    }
    if (got.col !== cp.expected.cursor.col) {
      diff.push({
        field: 'cursor.col',
        expected: cp.expected.cursor.col,
        actual: got.col,
      });
    }
  }

  if (cp.expected.mode) {
    const latestMode = latestModeState(envs);
    const expectedAlt = cp.expected.mode.altScreen;
    if (latestMode.alt_screen !== expectedAlt) {
      diff.push({
        field: 'mode.altScreen',
        expected: expectedAlt,
        actual: latestMode.alt_screen,
      });
    }
  }

  if (cp.expected.scrollback) {
    // Read via the public projection — `getScrollback().rows.length` is the
    // canonical count. No test-only accessor needed; the engine already
    // exposes this for renderers and perf harnesses.
    const ring = emulator.getScrollback();
    const actualCount = ring.rows.length;
    const expectedCount = cp.expected.scrollback.rowCount;
    if (expectedCount !== undefined && actualCount !== expectedCount) {
      diff.push({
        field: 'scrollback.rowCount',
        expected: expectedCount,
        actual: actualCount,
      });
    }
    if (cp.expected.scrollback.rows) {
      for (const [rowKey, expectedRow] of Object.entries(
        cp.expected.scrollback.rows,
      )) {
        const idx = Number.parseInt(rowKey, 10);
        if (!Number.isInteger(idx) || idx < 0 || idx >= ring.rows.length) {
          diff.push({
            field: `scrollback.rows.${rowKey}`,
            expected: `valid scrollback row index (0..${ring.rows.length - 1})`,
            actual: `out-of-range (${rowKey})`,
          });
          continue;
        }
        const ringRow = ring.rows[idx]!;
        const actualRow = projectScrollbackRow(ringRow.cells, meta.cols, {
          includeSgrDigest: expectedRow.sgrDigest !== undefined,
        });
        if (expectedRow.text !== undefined && actualRow.text !== expectedRow.text) {
          diff.push({
            field: `scrollback.rows.${rowKey}.text`,
            expected: expectedRow.text,
            actual: actualRow.text,
          });
        }
        if (expectedRow.widths !== undefined && !widthsEqual(actualRow.widths, expectedRow.widths)) {
          diff.push({
            field: `scrollback.rows.${rowKey}.widths`,
            expected: expectedRow.widths,
            actual: actualRow.widths,
          });
        }
        if (
          expectedRow.sgrDigest !== undefined &&
          actualRow.sgrDigest !== expectedRow.sgrDigest
        ) {
          diff.push({
            field: `scrollback.rows.${rowKey}.sgrDigest`,
            expected: expectedRow.sgrDigest,
            actual: actualRow.sgrDigest,
          });
        }
      }
    }
  }

  if (cp.expected.selected_rows) {
    // Read LIVE dimensions. After an in-stream `resize` hook the emulator's
    // grid may no longer match `meta.rows` / `meta.cols`; projection and
    // row-index validation MUST track the post-resize reality. For fixtures
    // without a resize hook, `liveDims` equals `{ rows: meta.rows, cols: meta.cols }`
    // (constructor uses meta; no resize path taken), so existing fixtures
    // project identically.
    const liveDims = emulator.getDimensions();
    for (const [rowKey, expectedRow] of Object.entries(
      cp.expected.selected_rows,
    )) {
      const row = Number.parseInt(rowKey, 10);
      if (!Number.isInteger(row) || row < 0 || row >= liveDims.rows) {
        diff.push({
          field: `selected_rows.${rowKey}`,
          expected: `valid row index (0..${liveDims.rows - 1})`,
          actual: `out-of-range or non-integer (${rowKey})`,
        });
        continue;
      }
      const actualRow = projectRow(emulator, row, liveDims.cols, {
        includeSgrDigest: expectedRow.sgrDigest !== undefined,
      });
      if (actualRow.text !== expectedRow.text) {
        diff.push({
          field: `selected_rows.${rowKey}.text`,
          expected: expectedRow.text,
          actual: actualRow.text,
        });
      }
      if (!widthsEqual(actualRow.widths, expectedRow.widths)) {
        diff.push({
          field: `selected_rows.${rowKey}.widths`,
          expected: expectedRow.widths,
          actual: actualRow.widths,
        });
      }
      if (
        expectedRow.sgrDigest !== undefined &&
        actualRow.sgrDigest !== expectedRow.sgrDigest
      ) {
        diff.push({
          field: `selected_rows.${rowKey}.sgrDigest`,
          expected: expectedRow.sgrDigest,
          actual: actualRow.sgrDigest,
        });
      }
    }
  }

  return diff;
}

/* ---------- Row projection ---------- */

/**
 * Project a row from the live emulator state into the stable structural
 * form used in checkpoints.
 *
 * Wide cells: the leading half (width===2) contributes its grapheme; the
 * trailing half (width===0) contributes nothing to text but keeps its slot
 * in `widths` (so the projection round-trips).
 */
export function projectRow(
  emulator: VtEmulator,
  row: number,
  cols: number,
  opts: { readonly includeSgrDigest: boolean },
): RowProjection {
  const widthsMut: (0 | 1 | 2)[] = new Array(cols).fill(1) as (0 | 1 | 2)[];
  let text = '';
  let lastNonBlankIdx = -1;
  const sgrParts: string[] = [];

  for (let c = 0; c < cols; c += 1) {
    const cell = emulator._getCell(row, c);
    if (!cell) {
      widthsMut[c] = 1;
      continue;
    }
    widthsMut[c] = cell.width;
    if (cell.width !== 0 && cell.grapheme !== '') {
      text += cell.grapheme;
      lastNonBlankIdx = c;
    }
    if (opts.includeSgrDigest) {
      sgrParts.push(sgrTupleFor(cell));
    }
  }

  // Strip trailing blanks (printables already contributed; we only need to
  // trim the "blank text tail"). `lastNonBlankIdx` is a column index, but
  // `text` is a grapheme sequence, so we can't slice by column. Instead,
  // rebuild text only up through `lastNonBlankIdx`.
  if (lastNonBlankIdx === -1) {
    text = '';
  } else {
    let rebuilt = '';
    for (let c = 0; c <= lastNonBlankIdx; c += 1) {
      const cell = emulator._getCell(row, c);
      if (cell && cell.width !== 0 && cell.grapheme !== '') {
        rebuilt += cell.grapheme;
      }
    }
    text = rebuilt;
  }

  const projection: RowProjection = opts.includeSgrDigest
    ? {
        text,
        widths: widthsMut,
        sgrDigest: sha256Hex(sgrParts.join('|')),
      }
    : {
        text,
        widths: widthsMut,
      };
  return projection;
}

/**
 * Project a scrollback row (a plain array of `InternalCell`) into the
 * same `RowProjection` shape used for live-grid rows. Mirror of
 * `projectRow` but reads the cells array directly — scrollback rows live
 * in the ring, not in the live grid, so `_getCell` can't reach them.
 */
export function projectScrollbackRow(
  cells: readonly {
    readonly grapheme: string;
    readonly width: 0 | 1 | 2;
    readonly fg: { kind: string; [k: string]: unknown } | 'default';
    readonly bg: { kind: string; [k: string]: unknown } | 'default';
    readonly bold: boolean;
    readonly italic: boolean;
    readonly underline: boolean;
    readonly inverse: boolean;
    readonly strike: boolean;
    readonly dim: boolean;
    readonly hidden: boolean;
    readonly blink: boolean;
  }[],
  cols: number,
  opts: { readonly includeSgrDigest: boolean },
): RowProjection {
  const widthsMut: (0 | 1 | 2)[] = new Array(cols).fill(1) as (0 | 1 | 2)[];
  let lastNonBlankIdx = -1;
  const sgrParts: string[] = [];
  const maxCol = Math.min(cells.length, cols);

  for (let c = 0; c < maxCol; c += 1) {
    const cell = cells[c]!;
    widthsMut[c] = cell.width;
    if (cell.width !== 0 && cell.grapheme !== '') {
      lastNonBlankIdx = c;
    }
    if (opts.includeSgrDigest) {
      sgrParts.push(sgrTupleFor(cell));
    }
  }

  let text = '';
  if (lastNonBlankIdx !== -1) {
    for (let c = 0; c <= lastNonBlankIdx; c += 1) {
      const cell = cells[c]!;
      if (cell.width !== 0 && cell.grapheme !== '') {
        text += cell.grapheme;
      }
    }
  }

  return opts.includeSgrDigest
    ? { text, widths: widthsMut, sgrDigest: sha256Hex(sgrParts.join('|')) }
    : { text, widths: widthsMut };
}

/**
 * Produce a stable string tuple for a cell's SGR state.
 *
 * Colours are serialised by `kind` + index/channels so equality is
 * kind-aware (a "named black" ≠ "indexed 0" ≠ "rgb(0,0,0)").
 */
function sgrTupleFor(cell: {
  readonly fg: { kind: string; [k: string]: unknown } | 'default';
  readonly bg: { kind: string; [k: string]: unknown } | 'default';
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly inverse: boolean;
  readonly strike: boolean;
  readonly dim: boolean;
  readonly hidden: boolean;
  readonly blink: boolean;
}): string {
  const fg = colorStr(cell.fg);
  const bg = colorStr(cell.bg);
  // Pack booleans into a 8-bit field for compactness.
  let flags = 0;
  if (cell.bold) flags |= 1 << 0;
  if (cell.italic) flags |= 1 << 1;
  if (cell.underline) flags |= 1 << 2;
  if (cell.inverse) flags |= 1 << 3;
  if (cell.strike) flags |= 1 << 4;
  if (cell.dim) flags |= 1 << 5;
  if (cell.hidden) flags |= 1 << 6;
  if (cell.blink) flags |= 1 << 7;
  return `${fg},${bg},${flags}`;
}

function colorStr(
  c: { kind: string; [k: string]: unknown } | 'default',
): string {
  if (c === 'default') return 'd';
  const kind = c.kind;
  if (kind === 'named' || kind === 'bright' || kind === 'indexed') {
    return `${kind}:${String(c['index'])}`;
  }
  if (kind === 'rgb') {
    return `rgb:${String(c['r'])},${String(c['g'])},${String(c['b'])}`;
  }
  return 'd';
}

function widthsEqual(
  a: readonly (0 | 1 | 2)[],
  b: readonly (0 | 1 | 2)[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/* ---------- Envelope helpers ---------- */

function latestModeState(
  envs: readonly GridEventEnvelope<GridPayload>[],
): { readonly alt_screen: boolean } {
  for (let i = envs.length - 1; i >= 0; i -= 1) {
    const env = envs[i]!;
    const payload = env.payload;
    if (payload.kind === 'grid_snapshot') {
      return { alt_screen: payload.mode_state.alt_screen ?? false };
    }
    if (payload.kind === 'mode_changed') {
      return { alt_screen: payload.state.alt_screen ?? false };
    }
  }
  // No snapshot yet — impossible in practice since the emulator emits one
  // on construction, but typed safely.
  return { alt_screen: false };
}

/* ---------- IO / util ---------- */

async function readJson<T>(file: string): Promise<T> {
  const raw = await fs.readFile(file, 'utf8');
  return JSON.parse(raw) as T;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function nowMs(): number {
  // `performance.now()` is stable under vitest/jsdom; fall back to Date.now
  // for ultra-old environments.
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

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

/** Shape of `meta.json`. */
export interface CompatFixtureMeta {
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
  readonly description: string;
  /** ISO-8601 authoring timestamp, included for audit / diff reviewability. */
  readonly authoredAt: string;
  /** Optional free-form label for a future real-recording replacement. */
  readonly synthetic?: boolean;
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
  const checkpoints = await readJson<readonly CheckpointSpec[]>(
    path.join(fixtureDir, 'checkpoints.json'),
  );
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
  const feedStart = nowMs();

  // Sort checkpoints by offset so out-of-order authoring doesn't break us.
  const ordered = [...checkpoints].sort(
    (a, b) => a.at_byte_offset - b.at_byte_offset,
  );

  for (let i = 0; i < ordered.length; i += 1) {
    const cp = ordered[i]!;
    // Feed in SLICE-sized chunks up to the checkpoint's byte offset.
    while (fedUpTo < cp.at_byte_offset && fedUpTo < input.length) {
      const next = Math.min(fedUpTo + SLICE, cp.at_byte_offset, input.length);
      emulator.feed(input.subarray(fedUpTo, next));
      fedUpTo = next;
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
  if (fedUpTo < input.length) {
    while (fedUpTo < input.length) {
      const next = Math.min(fedUpTo + SLICE, input.length);
      emulator.feed(input.subarray(fedUpTo, next));
      fedUpTo = next;
    }
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
  };
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
    const actualCount = emulator.getScrollback().rows.length;
    const expectedCount = cp.expected.scrollback.rowCount;
    if (actualCount !== expectedCount) {
      diff.push({
        field: 'scrollback.rowCount',
        expected: expectedCount,
        actual: actualCount,
      });
    }
  }

  if (cp.expected.selected_rows) {
    for (const [rowKey, expectedRow] of Object.entries(
      cp.expected.selected_rows,
    )) {
      const row = Number.parseInt(rowKey, 10);
      if (!Number.isInteger(row) || row < 0 || row >= meta.rows) {
        diff.push({
          field: `selected_rows.${rowKey}`,
          expected: 'valid row index',
          actual: `out-of-range or non-integer (${rowKey})`,
        });
        continue;
      }
      const actualRow = projectRow(emulator, row, meta.cols, {
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

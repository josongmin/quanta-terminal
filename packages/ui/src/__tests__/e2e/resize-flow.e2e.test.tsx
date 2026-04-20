/**
 * **Final E2E — resize full-loop**
 *
 * Exercises the resize pipeline end-to-end from the perspective of the UI:
 *
 *   ConnectedSession.resize(cols, rows) → bridge.resize(sessionId, cols, rows)
 *   → engine produces a new `GridSnapshot` with an incremented
 *     `resize_generation` (simulated in-test because no VT engine is present)
 *   → `GridMirror.applySnapshot` reseeds
 *   → `MirrorSource.emit(dirtyRows)` fires
 *   → `CellBuffer.writeSnapshot` detects `rows.length !== rows_` and
 *     calls `resize(...)` to rebuild the packed buffer at the new dims
 *   → `TerminalCanvas` shows the new geometry via the imperative handle
 *     (`ref.current.cellBuffer.dimensions()`).
 *
 * ### Mechanism note
 *
 * `TerminalCanvas.tsx` (the widget under test) does **not** own a
 * `ResizeObserver` nor a `bridge.resize` call-site. Resize detection in the
 * production stack lives one layer above — a host-measurement seam computes
 * `cellsPerContainer` and hands the result to `ConnectedSession.resize`,
 * which forwards to `bridge.resize`. The widget learns about the new
 * dimensions exclusively through a fresh `GridSnapshot` with a bumped
 * `resize_generation`. These tests therefore stub the bridge, drive a
 * real `ConnectedSession`, and cross-check that the snapshot-driven
 * pipeline re-dimensions `CellBuffer` correctly.
 *
 * Covered scenarios:
 *   1. initial mount dimension parity (mirror vs CellBuffer)
 *   2. bridge.resize is called with the new cols/rows
 *   3. new snapshot with bumped resize_generation → CellBuffer re-dimensions
 *   4. stale `resize_generation` delta → dropped by GridMirror
 *   5. in-flight delta between bridge.resize and the snapshot → dropped
 *      (same stale-generation path)
 *   6. shrink to smaller grid → CellBuffer matches new dims
 *   7. zero/min-dim edge case → bridge forwards 0×0 (clamp is host-side);
 *      mirror snapshot at 1×1 is the practical minimum the widget respects
 *   8. rapid successive snapshots → last snapshot wins
 *   9. selection persists across a resize but `copy()` honors the new
 *      (post-resize) dimensions
 */

import { act, render } from '@testing-library/react';
import { createRef, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEventListener,
  SessionId,
  SpawnSessionOptions,
  SpawnSessionResult,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';

import { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import type { CellSpan, RowDelta } from '../../shared/lib/grid-mirror/types.js';
import {
  DEFAULT_METRICS,
  MirrorSource,
  type MemoryBackend,
} from '../../shared/ui/cell-renderer/index.js';
import {
  TerminalCanvas,
  type TerminalCanvasHandle,
} from '../../widgets/terminal-canvas/TerminalCanvas.js';
import { connectSession } from '../../features/session/connect.js';
import { useSessionStore } from '../../entities/session/index.js';

const SESSION_ID = 'sess-1' as SessionId;

/* ---------- wire builders ---------- */

function textSpan(text: string): CellSpan {
  return {
    cols: text.length,
    sgr: '0x0000000000000000',
    graphemes: { utf8: text },
    hyperlink_id: 0,
    ext: null,
  };
}

function blankSpan(cols: number): CellSpan {
  return {
    cols,
    sgr: '0x0000000000000000',
    graphemes: 'blank',
    hyperlink_id: 0,
    ext: null,
  };
}

function rowDeltaFor(
  row: number,
  text: string,
  cols: number,
  revBefore = 1,
  revAfter = 2,
): RowDelta {
  const spans: CellSpan[] = [];
  if (text.length > 0) spans.push(textSpan(text));
  if (cols > text.length) spans.push(blankSpan(cols - text.length));
  return {
    row,
    revision_before: revBefore,
    revision_after: revAfter,
    spans,
    continuation: false,
    hyperlink_refs: [],
  };
}

function snapshotEnv(opts: {
  rows: number;
  cols: number;
  contents?: readonly string[];
  gridEpoch?: number;
  sequenceNo?: number;
  resizeGeneration?: number;
}) {
  const { rows, cols, contents = [], gridEpoch = 1, sequenceNo = 0, resizeGeneration = 0 } = opts;
  const row_deltas: RowDelta[] = [];
  for (let r = 0; r < rows; r += 1) {
    const text = contents[r] ?? '';
    row_deltas.push({
      row: r,
      revision_before: 0,
      revision_after: 1,
      spans:
        text.length > 0
          ? [textSpan(text), blankSpan(Math.max(0, cols - text.length))]
          : [blankSpan(cols)],
      continuation: false,
      hyperlink_refs: [],
    });
  }
  return {
    session_id: SESSION_ID,
    grid_epoch: gridEpoch,
    sequence_no: sequenceNo,
    resize_generation: resizeGeneration,
    buffer_kind: 'main' as const,
    payload: {
      kind: 'grid_snapshot' as const,
      rows,
      cols,
      buffer_kind: 'main' as const,
      row_deltas,
      cursor: {
        row: 0,
        col: 0,
        visible: true,
        shape: 'block' as const,
        blinking: false,
        pending_wrap: false,
      },
      mode_state: {},
      meta: {},
    },
  };
}

function deltaEnv(opts: {
  seq: number;
  rowDeltas: RowDelta[];
  gridEpoch?: number;
  resizeGeneration?: number;
}) {
  const { seq, rowDeltas, gridEpoch = 1, resizeGeneration = 0 } = opts;
  return {
    session_id: SESSION_ID,
    grid_epoch: gridEpoch,
    sequence_no: seq,
    resize_generation: resizeGeneration,
    buffer_kind: 'main' as const,
    payload: {
      kind: 'grid_delta' as const,
      row_deltas: rowDeltas,
      scrolls: [],
      scrollback_appended: 0,
    },
  };
}

/* ---------- bridge stub ---------- */

function makeBridge(): HostBridge & { resize: ReturnType<typeof vi.fn> } {
  const listeners = new Set<HostEventListener>();
  return {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
      return {
        sessionId: SESSION_ID,
        shell: '/bin/zsh',
        cwd: options.cwd ?? '/',
      };
    },
    async write() {},
    resize: vi.fn(() => Promise.resolve()),
    async close() {},
    async cancelBlock() {},
    async notify() {},
    async openInEditor() {},
    async installShellIntegration() {
      return {
        targetPath: '/tmp/stub',
        snippet: '',
        alreadyInstalled: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async uninstallShellIntegration() {
      return {
        targetPath: '/tmp/stub',
        removedRegion: '',
        alreadyAbsent: true,
        fileMissing: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async aiSuggest() {
      return {
        id: 'stub',
        command: 'ls',
        tier: 'safe',
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
  } as HostBridge & { resize: ReturnType<typeof vi.fn> };
}

/* ---------- mount helper ---------- */

interface MountResult {
  readonly mirror: GridMirror;
  readonly source: MirrorSource;
  readonly ref: { current: TerminalCanvasHandle | null };
  readonly backend: MemoryBackend;
  readonly unmount: () => void;
}

function mountCanvas(opts: {
  rows: number;
  cols: number;
  contents?: readonly string[];
}): MountResult {
  const source = new MirrorSource();
  const mirror = new GridMirror({ onChange: (d) => source.emit(d) });
  mirror.applySnapshot(snapshotEnv({ ...opts, resizeGeneration: 0 }));

  const ref = createRef<TerminalCanvasHandle>();
  const result = render(
    <TerminalCanvas
      ref={ref as Ref<TerminalCanvasHandle>}
      mirror={mirror}
      mirrorSource={source}
      backend="memory"
      metrics={DEFAULT_METRICS}
      platform="linux"
    />,
  );
  const backend = (ref.current?.backend ?? null) as MemoryBackend | null;
  if (!backend) throw new Error('memory backend must be mounted');
  return {
    mirror,
    source,
    ref: ref as { current: TerminalCanvasHandle | null },
    backend,
    unmount: result.unmount,
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/* ---------- resize application helper ---------- */

/**
 * Apply a resize snapshot in "act" + wait for the MirrorSource → CellBuffer
 * subscription to deliver the dirty set so `writeSnapshot` has a chance to
 * re-dimension the local packed buffer.
 *
 * The widget's CellBuffer subscribes to MirrorSource dirty-row notifications.
 * When the mirror reseeds via `applySnapshot`, it fires `onChange` with the
 * full row index set. The CellBuffer marks those rows dirty — but the
 * dimension change actually happens synchronously on the imperative handle
 * call site: EPIC-E tests reach for `ref.current.applySnapshot(...)` which
 * invokes `buffer.writeSnapshot(rows)`. `writeSnapshot` internally detects
 * `rows.length !== this.rows_` and calls `buffer.resize(...)`.
 *
 * So the test pipeline is:
 *   1. mirror.applySnapshot(env with new dims + bumped resize_generation)
 *   2. drive ref.current.applySnapshot(freshRows, cursor, mode) to pull the
 *      rows out of the mirror into the local buffer (same path the
 *      EPIC-C snapshot-applied callback uses in production).
 */
function driveSnapshotIntoWidget(m: MountResult): void {
  const dims = m.mirror.getDimensions();
  const rows: NonNullable<ReturnType<GridMirror['getRow']>>[] = [];
  for (let r = 0; r < dims.rows; r += 1) {
    const row = m.mirror.getRow(r);
    if (row) rows.push(row);
  }
  act(() => {
    m.ref.current?.applySnapshot(rows, m.mirror.getCursor(), m.mirror.getMode());
  });
}

/* ---------- tests ---------- */

beforeEach(() => {
  useSessionStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resize full-loop (e2e)', () => {
  it('initial mount — mirror dims match CellBuffer.dimensions', async () => {
    const m = mountCanvas({ rows: 6, cols: 24 });
    await flushEffects();
    expect(m.mirror.getDimensions()).toEqual({ rows: 6, cols: 24 });
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 6, cols: 24 });
  });

  it('ConnectedSession.resize forwards cols/rows to bridge.resize with the session id', async () => {
    const bridge = makeBridge();
    const session = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => undefined,
    });
    await session.resize(120, 40);
    expect(bridge.resize).toHaveBeenCalledWith(SESSION_ID, 120, 40);
    await session.close();
  });

  it('new snapshot with bumped resize_generation → CellBuffer re-dimensions to match', async () => {
    const m = mountCanvas({ rows: 4, cols: 16, contents: ['first'] });
    await flushEffects();
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 4, cols: 16 });

    // Engine would emit a new snapshot after the resize — simulate.
    m.mirror.applySnapshot(
      snapshotEnv({
        rows: 8,
        cols: 32,
        contents: ['after-resize'],
        gridEpoch: 1,
        sequenceNo: 10,
        resizeGeneration: 1,
      }),
    );
    driveSnapshotIntoWidget(m);
    await flushEffects();

    expect(m.mirror.getDimensions()).toEqual({ rows: 8, cols: 32 });
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 8, cols: 32 });
  });

  it('stale resize_generation delta is dropped by the mirror after a bump', async () => {
    const m = mountCanvas({ rows: 4, cols: 16 });
    await flushEffects();
    // Bump generation via a new snapshot.
    m.mirror.applySnapshot(
      snapshotEnv({
        rows: 4,
        cols: 16,
        gridEpoch: 1,
        sequenceNo: 5,
        resizeGeneration: 2,
      }),
    );
    // Old-generation delta with a sequence number after the snapshot.
    const result = m.mirror.applyDelta(
      deltaEnv({
        seq: 6,
        rowDeltas: [rowDeltaFor(0, 'ghost', 16)],
        gridEpoch: 1,
        resizeGeneration: 1, // stale
      }),
    );
    expect(result).toEqual({ outcome: 'discarded', reason: 'stale_resize_generation' });
  });

  it('in-flight delta arriving between bridge.resize and the resize-snapshot is dropped', async () => {
    // Scenario: UI invoked bridge.resize. Engine has already bumped the
    // resize_generation but the UI's mirror has NOT yet received the new
    // snapshot (network in-flight). A pre-existing delta with the new
    // generation cannot be applied because the mirror still thinks its
    // dimensions are the old ones. This path is the same stale-gate
    // — the mirror drops the delta.
    const m = mountCanvas({ rows: 4, cols: 16 });
    await flushEffects();
    // Apply a new snapshot at generation 1 (mirror now at gen=1).
    m.mirror.applySnapshot(
      snapshotEnv({ rows: 4, cols: 16, gridEpoch: 1, sequenceNo: 5, resizeGeneration: 1 }),
    );
    // A delta from BEFORE the resize (gen=0) arrives late.
    const result = m.mirror.applyDelta(
      deltaEnv({
        seq: 6,
        rowDeltas: [rowDeltaFor(1, 'late', 16)],
        gridEpoch: 1,
        resizeGeneration: 0,
      }),
    );
    expect(result).toEqual({ outcome: 'discarded', reason: 'stale_resize_generation' });
  });

  it('shrink — snapshot with smaller row count AND cols → CellBuffer downsizes both axes', async () => {
    // `CellBuffer.writeSnapshot` derives cols from the first row's
    // `cells.length` and resizes the packed buffer accordingly. A snapshot
    // that narrows the grid must take effect in both axes so the buffer
    // stays in lock-step with the authoritative `GridMirror` dims.
    const m = mountCanvas({ rows: 12, cols: 40, contents: ['tall grid row 0'] });
    await flushEffects();
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 12, cols: 40 });

    m.mirror.applySnapshot(
      snapshotEnv({
        rows: 3,
        cols: 16,
        contents: ['tiny'],
        gridEpoch: 1,
        sequenceNo: 3,
        resizeGeneration: 1,
      }),
    );
    driveSnapshotIntoWidget(m);
    await flushEffects();

    // Mirror is the authority on dims.
    expect(m.mirror.getDimensions()).toEqual({ rows: 3, cols: 16 });
    // CellBuffer shrinks on BOTH axes to match the mirror.
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 3, cols: 16 });
    // Out-of-range cells are clipped on both axes.
    expect(m.ref.current?.cellBuffer.getCell(10, 30)).toBeNull();
    expect(m.ref.current?.cellBuffer.getCell(0, 30)).toBeNull();
    // Surviving row carries the new content.
    expect(m.ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('tiny');
  });

  it('zero / minimum dims edge case — bridge forwards 0×0 raw; mirror handles 1×1 snapshot', async () => {
    // Part A: bridge contract — feature layer does NOT silently clamp.
    // The clamp is hook-side (`useTerminalSurface`/host-measure). Pin the
    // forward-shape so a regression is detected at the feature boundary.
    const bridge = makeBridge();
    const session = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => undefined,
    });
    await session.resize(0, 0);
    expect(bridge.resize).toHaveBeenCalledWith(SESSION_ID, 0, 0);
    await session.close();

    // Part B: practical minimum — a 1×N snapshot is the smallest row-count
    // the widget will represent. A real engine never emits rows=0 (it emits
    // the previous dim if the host reports a zero window). Mirror and
    // CellBuffer must both follow the new dims authoritatively.
    const m = mountCanvas({ rows: 4, cols: 16 });
    await flushEffects();
    m.mirror.applySnapshot(
      snapshotEnv({
        rows: 1,
        cols: 16,
        gridEpoch: 1,
        sequenceNo: 7,
        resizeGeneration: 1,
      }),
    );
    driveSnapshotIntoWidget(m);
    await flushEffects();
    expect(m.mirror.getDimensions()).toEqual({ rows: 1, cols: 16 });
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 1, cols: 16 });
  });

  it('rapid successive resize snapshots — last snapshot wins, no intermediate residue', async () => {
    const m = mountCanvas({ rows: 4, cols: 16 });
    await flushEffects();

    // Three snapshots fired back-to-back (simulating a debounce-missed burst).
    const bursts = [
      { rows: 5, cols: 18, gen: 1, seq: 1 },
      { rows: 7, cols: 24, gen: 2, seq: 2 },
      { rows: 10, cols: 30, gen: 3, seq: 3 },
    ];
    for (const b of bursts) {
      m.mirror.applySnapshot(
        snapshotEnv({
          rows: b.rows,
          cols: b.cols,
          gridEpoch: 1,
          sequenceNo: b.seq,
          resizeGeneration: b.gen,
        }),
      );
    }
    driveSnapshotIntoWidget(m);
    await flushEffects();

    expect(m.mirror.getDimensions()).toEqual({ rows: 10, cols: 30 });
    // Last-snapshot-wins on both axes — the CellBuffer follows the final
    // authoritative dims from the mirror, not the monotonic max.
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 10, cols: 30 });
  });

  it('selection across a resize — extend-beyond-new-bounds stays in SelectionManager, copy clips to new dims', async () => {
    // Set up a 4×16 grid with two lines, select all of them, then resize
    // down to 2×8. The SelectionManager's `current` is not forcibly reset
    // (no production code wipes it on resize); but `copy()` reads live
    // buffer dimensions, so an out-of-range end must not yield rows that
    // no longer exist.
    const m = mountCanvas({
      rows: 4,
      cols: 16,
      contents: ['hello world', 'second line'],
    });
    await flushEffects();

    act(() => {
      m.ref.current!.selection.begin({ row: 0, col: 0 }, 'char');
      m.ref.current!.selection.extend({ row: 3, col: 15 });
    });
    expect(m.ref.current?.selection.get()).not.toBeNull();

    // Shrink the grid. CellBuffer follows the mirror on both axes.
    m.mirror.applySnapshot(
      snapshotEnv({
        rows: 2,
        cols: 16,
        contents: ['hi', 'ok'],
        gridEpoch: 1,
        sequenceNo: 9,
        resizeGeneration: 1,
      }),
    );
    driveSnapshotIntoWidget(m);
    await flushEffects();

    // Mirror authoritative dims.
    expect(m.mirror.getDimensions()).toEqual({ rows: 2, cols: 16 });
    expect(m.ref.current?.cellBuffer.dimensions().rows).toBe(2);
    // SelectionManager still holds the stale anchor (per production
    // policy — no invalidation), but the user-visible `copy()` output
    // must not reference rows beyond the new grid.
    let copied = '';
    expect(() => {
      copied = m.ref.current!.selection.copy();
    }).not.toThrow();
    // Must NOT leak the vanished pre-resize content.
    expect(copied).not.toContain('hello world');
    expect(copied).not.toContain('second line');
    // Positive assertion: the surviving rows ('hi' and 'ok') are what a
    // copy of a grid-wide selection on the POST-resize buffer should
    // produce. This pins the "clip to new dims" behavior concretely — if
    // the selection path accidentally returns empty text on a stale
    // out-of-range end anchor, the positive assertion fails.
    expect(copied).toContain('hi');
    expect(copied).toContain('ok');
  });

  it('full loop — bridge.resize + mirror snapshot at the new dims together drive the widget to the new geometry', async () => {
    // The other tests cover the two halves in isolation:
    //   - "ConnectedSession.resize forwards ..." covers feature → bridge.
    //   - "new snapshot with bumped resize_generation ..." covers mirror →
    //     CellBuffer.
    // This test composes them in one flow so a regression that wires the
    // bridge call to the wrong session, or silently drops the post-resize
    // snapshot at the widget seam, is caught at the e2e boundary.
    const bridge = makeBridge();
    const session = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => undefined,
    });
    // Host-side would normally emit a new snapshot in response to resize.
    // We simulate that in the same act so both halves participate.
    const m = mountCanvas({ rows: 24, cols: 80, contents: ['before'] });
    await flushEffects();
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 24, cols: 80 });

    await session.resize(100, 30);
    expect(bridge.resize).toHaveBeenCalledWith(SESSION_ID, 100, 30);

    // The engine now fires a fresh snapshot at the matching dims.
    m.mirror.applySnapshot(
      snapshotEnv({
        rows: 30,
        cols: 100,
        contents: ['after'],
        gridEpoch: 1,
        sequenceNo: 20,
        resizeGeneration: 1,
      }),
    );
    driveSnapshotIntoWidget(m);
    await flushEffects();
    expect(m.mirror.getDimensions()).toEqual({ rows: 30, cols: 100 });
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 30, cols: 100 });
    // Content of the new row 0 is visible through the buffer.
    expect(m.ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('after');
    await session.close();
  });

  it('shrink ONLY cols (rows unchanged) — CellBuffer narrows the column axis independently', async () => {
    // Orthogonal axis check: a column-only shrink must not accidentally be
    // clamped against the previous column count. Previously `writeSnapshot`
    // only resized when both axes changed (RFC §22 #13); the recent fix makes
    // either axis trigger a re-dimension. Pin the column-only path.
    const m = mountCanvas({ rows: 6, cols: 40, contents: ['abcdefghij'] });
    await flushEffects();
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 6, cols: 40 });

    m.mirror.applySnapshot(
      snapshotEnv({
        rows: 6,
        cols: 12,
        contents: ['shrunk'],
        gridEpoch: 1,
        sequenceNo: 4,
        resizeGeneration: 1,
      }),
    );
    driveSnapshotIntoWidget(m);
    await flushEffects();

    expect(m.mirror.getDimensions()).toEqual({ rows: 6, cols: 12 });
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 6, cols: 12 });
    // Cells beyond the new column count are clipped.
    expect(m.ref.current?.cellBuffer.getCell(0, 12)).toBeNull();
    expect(m.ref.current?.cellBuffer.getCell(0, 11)).not.toBeNull();
  });

  it('shrink ONLY rows (cols unchanged) — CellBuffer drops excess rows and out-of-range row reads clip', async () => {
    // Symmetric orthogonal check for the row axis.
    const m = mountCanvas({ rows: 20, cols: 24, contents: ['top'] });
    await flushEffects();
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 20, cols: 24 });

    m.mirror.applySnapshot(
      snapshotEnv({
        rows: 5,
        cols: 24,
        contents: ['after'],
        gridEpoch: 1,
        sequenceNo: 4,
        resizeGeneration: 1,
      }),
    );
    driveSnapshotIntoWidget(m);
    await flushEffects();

    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 5, cols: 24 });
    // Rows beyond the new count are clipped.
    expect(m.ref.current?.cellBuffer.getCell(5, 0)).toBeNull();
    expect(m.ref.current?.cellBuffer.getCell(19, 0)).toBeNull();
    expect(m.ref.current?.cellBuffer.getCell(4, 0)).not.toBeNull();
  });

  it('after resize, new delta at the new generation applies cleanly', async () => {
    const m = mountCanvas({ rows: 4, cols: 16 });
    await flushEffects();

    // Resize to 6×20, generation=1.
    m.mirror.applySnapshot(
      snapshotEnv({
        rows: 6,
        cols: 20,
        gridEpoch: 1,
        sequenceNo: 5,
        resizeGeneration: 1,
      }),
    );
    driveSnapshotIntoWidget(m);
    await flushEffects();
    expect(m.ref.current?.cellBuffer.dimensions()).toEqual({ rows: 6, cols: 20 });

    // A delta at the new generation targeting row 1 must apply. The
    // snapshot set each row's `revision_after: 1`, so the delta carries
    // `revision_before: 1`.
    const deltaResult = m.mirror.applyDelta(
      deltaEnv({
        seq: 6,
        rowDeltas: [rowDeltaFor(1, 'post-resize', 20, 1, 2)],
        gridEpoch: 1,
        resizeGeneration: 1,
      }),
    );
    expect(deltaResult.outcome).toBe('applied');
  });
});

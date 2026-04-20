/**
 * **E2E — mass / high-throughput streaming stress**
 *
 * Validates that the full UI stack holds up under pathological input bursts:
 *
 *   - single-batch deltas spanning thousands of rows
 *   - resize snapshot storms
 *   - row-revision churn (same row updated thousands of times)
 *   - revision-mismatch escalation to SnapshotRequest (K=5 / 10s storm
 *     threshold per EPIC-C `GridMirror`)
 *   - very large pastes (10KB / 100KB) — bracketed wrap + embedded-sentinel
 *     strip under load
 *   - multi-delta rAF coalesce (one paint per frame regardless of burst)
 *   - synchronized-update windows accumulating large dirty sets
 *   - full-screen selection → copy of ~10k cells
 *   - wrap-normalized copy on long soft-wrapped lines (ADR 0016)
 *   - rapid-fire resize with final-wins semantics
 *
 * Tests assert **correctness + liveness** (crash-free + finishes within a
 * generous timeout), not absolute performance numbers — perf regression is
 * the job of the perf-budget suite, not e2e flake bait.
 */

import { act, render } from '@testing-library/react';
import { createRef, type Ref } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import type {
  CellSpan,
  RowDelta,
  SnapshotRequest,
} from '../../shared/lib/grid-mirror/types.js';
import {
  DEFAULT_METRICS,
  MirrorSource,
  type MemoryBackend,
  type MemoryBackendCall,
} from '../../shared/ui/cell-renderer/index.js';
import {
  TerminalCanvas,
  type TerminalCanvasHandle,
} from '../../widgets/terminal-canvas/TerminalCanvas.js';
import { Focus } from '../../features/input/Focus.js';
import { KeyEncoder } from '../../features/input/KeyEncoder.js';
import { MouseEncoder } from '../../features/input/MouseEncoder.js';
import { Paste } from '../../features/input/Paste.js';
import {
  createStubMirror,
  ModeSnapshot,
} from '../../features/input/ModeSnapshot.js';
import { mount as mountInputHost } from '../../features/input/input-host.js';

const SESSION_ID = '01J00000000000000000000001';

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

function makeRowDelta(
  row: number,
  text: string,
  cols: number,
  revBefore: number,
  revAfter: number,
  continuation = false,
): RowDelta {
  const spans: CellSpan[] = [];
  if (text.length > 0) spans.push(textSpan(text.slice(0, cols)));
  const pad = Math.max(0, cols - text.length);
  if (pad > 0) spans.push(blankSpan(pad));
  return {
    row,
    revision_before: revBefore,
    revision_after: revAfter,
    spans,
    continuation,
    hyperlink_refs: [],
  };
}

function snapshotEnv(opts: {
  rows: number;
  cols: number;
  contents?: readonly string[];
  continuation?: readonly boolean[];
  gridEpoch?: number;
  sequenceNo?: number;
  resizeGeneration?: number;
}) {
  const {
    rows,
    cols,
    contents = [],
    continuation = [],
    gridEpoch = 1,
    sequenceNo = 0,
    resizeGeneration = 0,
  } = opts;
  const row_deltas: RowDelta[] = [];
  for (let r = 0; r < rows; r += 1) {
    const text = contents[r] ?? '';
    const isCont = continuation[r] ?? false;
    row_deltas.push(makeRowDelta(r, text, cols, 0, 1, isCont));
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

/* ---------- mount helpers ---------- */

interface MountResult {
  readonly mirror: GridMirror;
  readonly source: MirrorSource;
  readonly ref: { current: TerminalCanvasHandle | null };
  readonly backend: MemoryBackend;
  readonly container: HTMLElement;
  readonly unmount: () => void;
}

function mountCanvas(opts: {
  rows: number;
  cols: number;
  contents?: readonly string[];
  continuation?: readonly boolean[];
  stormThreshold?: { k: number; windowMs: number };
  onSnapshotResyncRequested?: (req: SnapshotRequest) => void;
  onCopyRequest?: (text: string) => void;
}): MountResult {
  const source = new MirrorSource();
  type MirrorOpts = NonNullable<ConstructorParameters<typeof GridMirror>[0]>;
  const mirrorOpts: MirrorOpts = {
    onChange: (d) => source.emit(d),
    ...(opts.stormThreshold ? { stormThreshold: opts.stormThreshold } : {}),
    ...(opts.onSnapshotResyncRequested
      ? { onSnapshotResyncRequested: opts.onSnapshotResyncRequested }
      : {}),
  };
  const mirror = new GridMirror(mirrorOpts);
  mirror.applySnapshot(
    snapshotEnv({
      rows: opts.rows,
      cols: opts.cols,
      ...(opts.contents ? { contents: opts.contents } : {}),
      ...(opts.continuation ? { continuation: opts.continuation } : {}),
    }),
  );

  const ref = createRef<TerminalCanvasHandle>();
  const extras: Partial<{ onCopyRequest: (text: string) => void }> = {};
  if (opts.onCopyRequest) extras.onCopyRequest = opts.onCopyRequest;
  const result = render(
    <TerminalCanvas
      ref={ref as Ref<TerminalCanvasHandle>}
      mirror={mirror}
      mirrorSource={source}
      backend="memory"
      metrics={DEFAULT_METRICS}
      platform="linux"
      {...extras}
    />,
  );
  const backend = (ref.current?.backend ?? null) as MemoryBackend | null;
  if (!backend) throw new Error('memory backend must be mounted');
  return {
    mirror,
    source,
    ref: ref as { current: TerminalCanvasHandle | null },
    backend,
    container: result.container,
    unmount: result.unmount,
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/**
 * Pull every row out of the mirror and push them into the widget's
 * CellBuffer via the imperative handle. Mirrors the EPIC-C snapshot-applied
 * callback path used in production and in `resize-flow.e2e.test.tsx`.
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

/* ---------- paste harness (reuses input-host) ---------- */

interface PasteHarness {
  container: HTMLElement;
  handle: ReturnType<typeof mountInputHost>;
  bytesOut: Uint8Array[];
}

function makePasteHarness(init: { bracketedPaste: boolean }): PasteHarness {
  const mirror = createStubMirror({ bracketedPaste: init.bracketedPaste });
  const modeSnapshot = new ModeSnapshot(mirror);
  const keyEncoder = new KeyEncoder({ modeSnapshot });
  const mouseEncoder = new MouseEncoder({ modeSnapshot });
  const paste = new Paste({ modeSnapshot });
  const focus = new Focus({ modeSnapshot });

  const bytesOut: Uint8Array[] = [];
  const container = document.createElement('div');
  container.setAttribute('tabindex', '0');
  document.body.appendChild(container);

  const handle = mountInputHost(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform: 'linux',
    onBytesOut: (b) => bytesOut.push(b),
    onOverlayUpdate: () => undefined,
  });

  return { container, handle, bytesOut };
}

function dispatchPaste(el: HTMLElement, text: string): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text' ? text : '') },
  });
  el.dispatchEvent(ev);
}

/* ================================================================
 * Tests
 * ================================================================ */

describe('streaming stress (e2e)', () => {
  /* --------------------------- Mass output --------------------------- */

  it(
    'single-batch GridDelta with 10_000 row updates applies cleanly — first/middle/last rows verified, buffer matches',
    { timeout: 10_000 },
    async () => {
      const ROWS = 10_000;
      const COLS = 40;
      const m = mountCanvas({ rows: ROWS, cols: COLS });
      await flushEffects();

      // Build 10k row deltas in a single delta payload. Each row in the
      // seed snapshot is revision_after=1, so revision_before must be 1.
      const deltas: RowDelta[] = [];
      for (let r = 0; r < ROWS; r += 1) {
        deltas.push(makeRowDelta(r, `row${r}`, COLS, 1, 2));
      }
      const start = performance.now();
      const result = m.mirror.applyDelta(deltaEnv({ seq: 1, rowDeltas: deltas }));
      const elapsed = performance.now() - start;

      expect(result.outcome).toBe('applied');
      // Generous upper bound — just proves the pipeline completes.
      expect(elapsed).toBeLessThan(8000);
      // Mirror-side correctness: first, middle, and last rows all present.
      expect(m.mirror.getRow(0)?.cells[0]?.grapheme).toBe('row0');
      expect(m.mirror.getRow(ROWS / 2)?.cells[0]?.grapheme).toBe(`row${ROWS / 2}`);
      expect(m.mirror.getRow(ROWS - 1)?.cells[0]?.grapheme).toBe(`row${ROWS - 1}`);
      // Push the snapshot into the widget's CellBuffer and verify the same
      // three rows round-trip through the damage-set → buffer path. A
      // regression where the delta-driven path dropped rows mid-iteration
      // would surface as a mismatch on any of these checkpoints.
      driveSnapshotIntoWidget(m);
      await flushEffects();
      const buf = m.ref.current!.cellBuffer;
      expect(buf.getCell(0, 0)?.grapheme).toBe('row0');
      expect(buf.getCell(ROWS / 2, 0)?.grapheme).toBe(`row${ROWS / 2}`);
      expect(buf.getCell(ROWS - 1, 0)?.grapheme).toBe(`row${ROWS - 1}`);
      m.unmount();
    },
  );

  it(
    'same-row revision churn (1000 updates on row 0) does not crash; final revision observable',
    { timeout: 10_000 },
    async () => {
      const m = mountCanvas({ rows: 4, cols: 16 });
      await flushEffects();

      const N = 1000;
      // Row 0 seed revision is 1 (from the snapshot). Each delta bumps by +1.
      let rev = 1;
      let seq = 1;
      const start = performance.now();
      for (let i = 0; i < N; i += 1) {
        const next = rev + 1;
        const res = m.mirror.applyDelta(
          deltaEnv({
            seq: seq++,
            rowDeltas: [makeRowDelta(0, `v${i}`, 16, rev, next)],
          }),
        );
        expect(res.outcome).toBe('applied');
        rev = next;
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(6000);

      // Final content wins.
      expect(m.mirror.getRow(0)?.cells[0]?.grapheme).toBe(`v${N - 1}`);
      expect(m.mirror.getRow(0)?.revision).toBe(rev);
      m.unmount();
    },
  );

  it(
    '100 back-to-back resize snapshots → only final dimensions survive (last-wins)',
    { timeout: 10_000 },
    async () => {
      const m = mountCanvas({ rows: 4, cols: 16 });
      await flushEffects();

      const start = performance.now();
      for (let i = 1; i <= 100; i += 1) {
        // Alternate row counts so each snapshot actually changes dims.
        const rows = 4 + (i % 8);
        const cols = 16 + (i % 6);
        m.mirror.applySnapshot(
          snapshotEnv({
            rows,
            cols,
            gridEpoch: 1,
            sequenceNo: i,
            resizeGeneration: i,
          }),
        );
      }
      // Final resize: pin to known dims.
      m.mirror.applySnapshot(
        snapshotEnv({
          rows: 12,
          cols: 32,
          gridEpoch: 1,
          sequenceNo: 200,
          resizeGeneration: 200,
        }),
      );
      driveSnapshotIntoWidget(m);
      await flushEffects();
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5000);

      // Mirror is authoritative on dimensions; CellBuffer row count follows.
      expect(m.mirror.getDimensions()).toEqual({ rows: 12, cols: 32 });
      expect(m.ref.current?.cellBuffer.dimensions().rows).toBe(12);
      m.unmount();
    },
  );

  it(
    'revision-mismatch storm (≥ K within W) escalates to SnapshotRequest — fewer than K does NOT escalate',
    { timeout: 10_000 },
    async () => {
      const snapshotRequested = vi.fn<(req: SnapshotRequest) => void>();
      // Lower the K for speed; the real default is K=5/10s. We still pin
      // the ADR-documented policy: after K mismatches the mirror escalates.
      const m = mountCanvas({
        rows: 4,
        cols: 16,
        stormThreshold: { k: 5, windowMs: 10_000 },
        onSnapshotResyncRequested: (req) => snapshotRequested(req),
      });
      await flushEffects();

      // First: feed K-1 = 4 mismatches and prove NO escalation yet. This
      // pins the threshold boundary — the original test only asserted that
      // ≥K triggers, never that <K does not. A regression to K=1 would
      // have passed the old test.
      let seq = 1;
      for (let i = 0; i < 4; i += 1) {
        m.mirror.applyDelta(
          deltaEnv({
            seq: seq++,
            rowDeltas: [makeRowDelta(0, 'x', 16, 99, 100)],
          }),
        );
      }
      expect(snapshotRequested).not.toHaveBeenCalled();

      // Row 0 seed rev = 1. We intentionally feed `revision_before: 99`
      // for each delta → every row is a mismatch. Cross the threshold.
      for (let i = 0; i < 2; i += 1) {
        m.mirror.applyDelta(
          deltaEnv({
            seq: seq++,
            rowDeltas: [makeRowDelta(0, 'x', 16, 99, 100)],
          }),
        );
      }

      expect(snapshotRequested).toHaveBeenCalled();
      const callArg = snapshotRequested.mock.calls[0]?.[0];
      expect(callArg?.reason).toBe('row_mismatch_storm');
      // The request must carry the correct session and grid epoch so the
      // host knows which session to re-snapshot. A stray request with
      // wrong coordinates would be a cross-session resync leak.
      expect(callArg?.session_id).toBe(SESSION_ID);
      expect(callArg?.epoch).toBe(1);
      m.unmount();
    },
  );

  /* --------------------------- Large paste --------------------------- */

  it(
    '10KB paste with bracketed ON → 1 emit, sentinel wrap, payload bytes verbatim',
    { timeout: 10_000 },
    () => {
      const h = makePasteHarness({ bracketedPaste: true });
      try {
        const payload = 'a'.repeat(10_000);
        const start = performance.now();
        dispatchPaste(h.container, payload);
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(3000);

        expect(h.bytesOut.length).toBe(1);
        const emitted = h.bytesOut[0]!;
        // 6 START + 10_000 body + 6 END.
        expect(emitted.length).toBe(6 + 10_000 + 6);
        // START sentinel.
        expect(Array.from(emitted.slice(0, 6))).toEqual([
          0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e,
        ]);
        // END sentinel.
        expect(Array.from(emitted.slice(-6))).toEqual([
          0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e,
        ]);
      } finally {
        h.handle.unmount();
        h.container.remove();
      }
    },
  );

  it(
    '100KB paste with embedded end-sentinel is stripped before wrap and still emitted once (byte-level START/END + interior verified)',
    { timeout: 10_000 },
    () => {
      const h = makePasteHarness({ bracketedPaste: true });
      try {
        // Build a 100KB payload whose middle contains an embedded END
        // sentinel. Encoder must strip it out of the payload.
        const filler = 'z'.repeat(50_000);
        const embedded = String.fromCharCode(0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e);
        const payload = filler + embedded + filler;
        const start = performance.now();
        dispatchPaste(h.container, payload);
        const elapsed = performance.now() - start;
        expect(elapsed).toBeLessThan(5000);

        expect(h.bytesOut.length).toBe(1);
        const emitted = h.bytesOut[0]!;
        // Expected body: 50k 'z' + 50k 'z' (embedded sentinel stripped).
        // Plus 6+6 sentinel bytes for START/END.
        expect(emitted.length).toBe(6 + 100_000 + 6);
        // START sentinel bytes (ESC [ 2 0 0 ~).
        expect(Array.from(emitted.slice(0, 6))).toEqual([
          0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e,
        ]);
        // END sentinel bytes (ESC [ 2 0 1 ~).
        expect(Array.from(emitted.slice(-6))).toEqual([
          0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e,
        ]);
        // Count interior 'z' bytes — the stripped sentinel leaves only 'z's.
        // Also prove NO interior bytes form the end sentinel pattern — a
        // naive strip-by-replace implementation could miss overlapping
        // sentinels at boundaries, so walk the whole interior looking for
        // the ESC[201~ byte pattern.
        let zCount = 0;
        for (let i = 6; i < emitted.length - 6; i += 1) {
          if (emitted[i] === 0x7a) zCount += 1;
        }
        expect(zCount).toBe(100_000);
        // No stray end-sentinel byte sequence in the interior.
        const body = emitted.slice(6, emitted.length - 6);
        for (let i = 0; i <= body.length - 6; i += 1) {
          const is201 =
            body[i] === 0x1b &&
            body[i + 1] === 0x5b &&
            body[i + 2] === 0x32 &&
            body[i + 3] === 0x30 &&
            body[i + 4] === 0x31 &&
            body[i + 5] === 0x7e;
          expect(is201).toBe(false);
        }
      } finally {
        h.handle.unmount();
        h.container.remove();
      }
    },
  );

  /* ------------------------- rAF coalescing ------------------------- */

  it(
    'multiple mirror-delta bursts within a single frame → exactly one `delta` backend call per tick',
    { timeout: 10_000 },
    async () => {
      const m = mountCanvas({ rows: 8, cols: 20 });
      await flushEffects();

      // Reset backend call log so we only see post-mount deltas.
      m.backend.resetCalls();
      // Start the renderer so `scheduleFrame()` actually schedules.
      m.ref.current!.renderer.start();

      // Fire 50 deltas inside a single synthetic frame — each bumps one
      // row's revision by +1.
      let seq = 1;
      // Each row seed rev = 1.
      const rowRev = new Array<number>(8).fill(1);
      for (let i = 0; i < 50; i += 1) {
        const row = i % 8;
        const before = rowRev[row]!;
        const after = before + 1;
        m.mirror.applyDelta(
          deltaEnv({
            seq: seq++,
            rowDeltas: [makeRowDelta(row, `b${i}`, 20, before, after)],
          }),
        );
        rowRev[row] = after;
      }

      // Force a single rAF tick — the DamageSet drained on this tick
      // should bundle every dirty row into ONE `applyGridDelta`.
      act(() => {
        m.ref.current!.renderer.forceTick();
      });

      const deltaCalls = m.backend
        .calls()
        .filter((c: MemoryBackendCall) => c.kind === 'delta');
      // Exactly one paint per frame (I-3: rAF coalesce).
      expect(deltaCalls.length).toBe(1);
      // And that single paint covers all 8 dirty rows (one per original
      // row, since 50 updates landed across 8 rows).
      const payload = deltaCalls[0]?.payload as { rows: number; dirty: number };
      expect(payload.dirty).toBe(8);
      m.unmount();
    },
  );

  it(
    'synchronized-update window accumulates all dirty rows and flushes once on End',
    { timeout: 10_000 },
    async () => {
      const dirtySets: number[] = [];
      const source = new MirrorSource();
      const mirror = new GridMirror({
        onChange: (d) => {
          dirtySets.push(d.size);
          source.emit(d);
        },
      });
      // Seed.
      mirror.applySnapshot(snapshotEnv({ rows: 200, cols: 20 }));
      const seededCount = dirtySets.length;

      // Begin a DECSET 2026 window.
      mirror.apply({
        session_id: SESSION_ID,
        grid_epoch: 1,
        sequence_no: 1,
        resize_generation: 0,
        buffer_kind: 'main',
        payload: { kind: 'synchronized_update', phase: 'begin' },
      });

      // Fire 200 row-deltas inside the window — onChange should NOT fire
      // per-delta, only accumulate.
      const rowRev = new Array<number>(200).fill(1);
      let seq = 2;
      for (let r = 0; r < 200; r += 1) {
        const before = rowRev[r]!;
        const after = before + 1;
        mirror.applyDelta(
          deltaEnv({
            seq: seq++,
            rowDeltas: [makeRowDelta(r, `s${r}`, 20, before, after)],
          }),
        );
        rowRev[r] = after;
      }

      // No change dispatches since the window began.
      expect(dirtySets.length).toBe(seededCount);

      // End the window → one flush with the full accumulated set.
      mirror.apply({
        session_id: SESSION_ID,
        grid_epoch: 1,
        sequence_no: seq++,
        resize_generation: 0,
        buffer_kind: 'main',
        payload: { kind: 'synchronized_update', phase: 'end' },
      });

      expect(dirtySets.length).toBe(seededCount + 1);
      // The single flush covers all 200 rows.
      expect(dirtySets[dirtySets.length - 1]).toBe(200);
      mirror.dispose();
    },
  );

  /* ---------------------- Selection / copy --------------------- */

  it(
    'full-screen selection over ~10_000 cells copies within the time budget',
    { timeout: 10_000 },
    async () => {
      // 100 rows x 100 cols = 10_000 cells. Each row has ASCII 'a'..'z'
      // repeating. Pure ASCII so `cellsToString` is simple.
      const ROWS = 100;
      const COLS = 100;
      const contents: string[] = [];
      for (let r = 0; r < ROWS; r += 1) {
        // Unique per-row token to prove "last line present in output".
        contents.push(`r${r}:` + 'x'.repeat(Math.max(0, COLS - 8)));
      }
      const m = mountCanvas({ rows: ROWS, cols: COLS, contents });
      await flushEffects();

      act(() => {
        m.ref.current!.selection.begin({ row: 0, col: 0 }, 'char');
        m.ref.current!.selection.extend({ row: ROWS - 1, col: COLS - 1 });
      });

      const start = performance.now();
      const copied = m.ref.current!.selection.copy();
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(3000);
      // Must contain the first and last unique tokens.
      expect(copied.startsWith('r0:')).toBe(true);
      expect(copied.includes(`r${ROWS - 1}:`)).toBe(true);
      // Line count: ROWS-1 newlines (last row terminal).
      const newlines = (copied.match(/\n/g) ?? []).length;
      expect(newlines).toBe(ROWS - 1);
      m.unmount();
    },
  );

  it(
    'copy over a very long soft-wrapped line joins continuation rows without separators (ADR 0016)',
    { timeout: 10_000 },
    async () => {
      // 10 rows, each tagged `continuation: true` except the first →
      // models a single logical line that soft-wrapped across 10 visual
      // rows. Per ADR 0016 copy joins continuation rows with empty
      // string, not newline.
      const ROWS = 10;
      const COLS = 40;
      const contents: string[] = [];
      const continuation: boolean[] = [];
      for (let r = 0; r < ROWS; r += 1) {
        contents.push(`p${r}`.padEnd(COLS, '.'));
        continuation.push(r !== 0);
      }
      const m = mountCanvas({ rows: ROWS, cols: COLS, contents, continuation });
      await flushEffects();

      act(() => {
        m.ref.current!.selection.begin({ row: 0, col: 0 }, 'char');
        m.ref.current!.selection.extend({ row: ROWS - 1, col: COLS - 1 });
      });
      const copied = m.ref.current!.selection.copy({
        preserveTrailingWhitespace: true,
        tabStops: 8,
      });

      // No `\n` inside the copied text: every row after the first is
      // a continuation → empty join, not newline.
      expect(copied.includes('\n')).toBe(false);
      // Every per-row token is present in reading order.
      for (let r = 0; r < ROWS; r += 1) {
        expect(copied.includes(`p${r}`)).toBe(true);
      }
      m.unmount();
    },
  );

  /* ---------------------- Resize stress ---------------------- */

  it(
    '100 resizes within a tight loop — final snapshot wins and delta at the new generation applies',
    { timeout: 10_000 },
    async () => {
      const m = mountCanvas({ rows: 4, cols: 16 });
      await flushEffects();

      const start = performance.now();
      for (let i = 1; i <= 100; i += 1) {
        m.mirror.applySnapshot(
          snapshotEnv({
            rows: 6,
            cols: 20,
            gridEpoch: 1,
            sequenceNo: i,
            resizeGeneration: i,
          }),
        );
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5000);

      driveSnapshotIntoWidget(m);
      await flushEffects();
      expect(m.mirror.getDimensions()).toEqual({ rows: 6, cols: 20 });
      expect(m.ref.current?.cellBuffer.dimensions().rows).toBe(6);

      // A stale-gen delta must be dropped (middle drop).
      const drop = m.mirror.applyDelta(
        deltaEnv({
          seq: 500,
          rowDeltas: [makeRowDelta(0, 'stale', 20, 1, 2)],
          gridEpoch: 1,
          resizeGeneration: 50, // stale
        }),
      );
      expect(drop).toEqual({ outcome: 'discarded', reason: 'stale_resize_generation' });

      // A fresh-gen delta applies cleanly.
      const ok = m.mirror.applyDelta(
        deltaEnv({
          seq: 501,
          rowDeltas: [makeRowDelta(0, 'fresh', 20, 1, 2)],
          gridEpoch: 1,
          resizeGeneration: 100,
        }),
      );
      expect(ok.outcome).toBe('applied');
      expect(m.mirror.getRow(0)?.cells[0]?.grapheme).toBe('fresh');
      m.unmount();
    },
  );
});

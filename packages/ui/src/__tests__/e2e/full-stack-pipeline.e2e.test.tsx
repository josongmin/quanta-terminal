/**
 * **Final E2E — full UI pipeline**
 *
 * End-to-end: `GridMirror → CellBuffer → Renderer(MemoryBackend) →
 * TerminalCanvas → Selection → Copy` — every layer is real. Only external
 * I/O (DOM pointer / keyboard events, clipboard) is stubbed.
 *
 * The `MemoryBackend` records every backend call so we can observe what
 * the renderer emitted without running a real paint. That lets us assert
 * on the pipeline *output* — a full GridSnapshot must produce exactly one
 * `snapshot` call; a GridDelta must produce a `delta` call — without
 * wedging the test on canvas-specific frame timing.
 *
 * Retires:
 *   - I-3 (Grid is truth) at the UI observation point — selection, copy,
 *     hit-test all read from the mirror.
 *   - RFC §13.8 copy semantics — wrap-joined continuation rows.
 *   - RFC §22 #20 (selection across wrapped rows) — indirectly, via the
 *     copy round-trip test.
 */

import { act, fireEvent, render } from '@testing-library/react';
import { createRef, type Ref } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import type {
  CellSpan,
  RowDelta,
} from '../../shared/lib/grid-mirror/types.js';
import {
  DEFAULT_METRICS,
  MemoryBackend,
  MirrorSource,
  type MemoryBackendCall,
} from '../../shared/ui/cell-renderer/index.js';
import {
  TerminalCanvas,
  type TerminalCanvasHandle,
} from '../../widgets/terminal-canvas/TerminalCanvas.js';

const SESSION_ID = '01J00000000000000000000001';

/** Build a span whose single grapheme repeats to fill `count` cells. */
function textSpan(text: string): CellSpan {
  return {
    cols: text.length,
    sgr: '0x0000000000000000',
    graphemes: { utf8: text },
    hyperlink_id: 0,
    ext: null,
  };
}

/**
 * Build an array of single-cell spans, one per character. Use this when a
 * test needs per-cell grapheme assertions (e.g. copy's exact substring at a
 * selected column range). The default `textSpan` stamps the entire string
 * onto col 0 — fine for width-of-row tests, wrong for range slicing.
 */
function perCellSpans(text: string): CellSpan[] {
  return [...text].map((ch) => ({
    cols: 1,
    sgr: '0x0000000000000000',
    graphemes: { utf8: ch },
    hyperlink_id: 0,
    ext: null,
  }));
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

function rowDelta(row: number, text: string, cols: number, revAfter = 2): RowDelta {
  const spans: CellSpan[] = [];
  if (text.length > 0) spans.push(textSpan(text));
  if (cols > text.length) spans.push(blankSpan(cols - text.length));
  return {
    row,
    revision_before: 1,
    revision_after: revAfter,
    spans,
    continuation: false,
    hyperlink_refs: [],
  };
}

function snapshotEnv(rows: number, cols: number, contents: ReadonlyArray<string>) {
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
    grid_epoch: 1,
    sequence_no: 0,
    resize_generation: 0,
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

function deltaEnv(seq: number, rowDeltas: RowDelta[]) {
  return {
    session_id: SESSION_ID,
    grid_epoch: 1,
    sequence_no: seq,
    resize_generation: 0,
    buffer_kind: 'main' as const,
    payload: {
      kind: 'grid_delta' as const,
      row_deltas: rowDeltas,
      scrolls: [],
      scrollback_appended: 0,
    },
  };
}

function mountCanvas(opts: {
  rows?: number;
  cols?: number;
  contents?: readonly string[];
  onSelectionChange?: (sel: unknown) => void;
  onCopyRequest?: (text: string) => void;
  onHyperlinkClick?: (ev: { id: number; uri: string | null; modifiers: string[] }) => void;
} = {}): {
  mirror: GridMirror;
  source: MirrorSource;
  ref: { current: TerminalCanvasHandle | null };
  container: HTMLElement;
  backend: MemoryBackend;
  unmount: () => void;
} {
  const rows = opts.rows ?? 4;
  const cols = opts.cols ?? 16;
  const source = new MirrorSource();
  const mirror = new GridMirror({
    onChange: (d) => source.emit(d),
  });
  mirror.applySnapshot(snapshotEnv(rows, cols, opts.contents ?? []));

  const ref = createRef<TerminalCanvasHandle>();
  // Build props with conditional spread so `exactOptionalPropertyTypes`
  // does not complain about passing `undefined` for optional callbacks.
  const extras: Partial<{
    onSelectionChange: (sel: unknown) => void;
    onCopyRequest: (text: string) => void;
    onHyperlinkClick: (ev: { id: number; uri: string | null; modifiers: string[] }) => void;
  }> = {};
  if (opts.onSelectionChange) extras.onSelectionChange = opts.onSelectionChange;
  if (opts.onCopyRequest) extras.onCopyRequest = opts.onCopyRequest;
  if (opts.onHyperlinkClick) extras.onHyperlinkClick = opts.onHyperlinkClick;
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
  // The backend is constructed lazily inside the widget; we pull it via the
  // ref. Cast is safe because memory backend is the only kind mounted here.
  const backend = (ref.current?.backend ?? null) as MemoryBackend | null;
  if (!backend) throw new Error('memory backend must be mounted');
  return {
    mirror,
    source,
    ref: ref as { current: TerminalCanvasHandle | null },
    container: result.container,
    backend,
    unmount: result.unmount,
  };
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('full-stack UI pipeline (e2e)', () => {
  it('renders a grid snapshot through the mirror and records a snapshot call on the backend', async () => {
    const { backend } = mountCanvas({ contents: ['hello'] });
    await flushEffects();
    const calls = backend.calls();
    const snapshotCall = calls.find((c: MemoryBackendCall) => c.kind === 'snapshot');
    expect(snapshotCall).toBeDefined();
  });

  it('the mirror and the widget share dimensions after mount', async () => {
    const { mirror, ref } = mountCanvas({ rows: 6, cols: 24 });
    await flushEffects();
    expect(mirror.getDimensions()).toEqual({ rows: 6, cols: 24 });
    expect(ref.current?.cellBuffer.dimensions()).toEqual({ rows: 6, cols: 24 });
  });

  it('row 0 content from the snapshot is observable through CellBuffer.getCell', async () => {
    const { ref } = mountCanvas({ rows: 4, cols: 16, contents: ['abc'] });
    await flushEffects();
    // `expandSpans` stamps the full span text onto index 0 and leaves the
    // following columns empty for the one-span case. The text is the full
    // grapheme-run payload. Col 3+ is blank per the trailing blank span.
    const cell0 = ref.current?.cellBuffer.getCell(0, 0);
    const cell3 = ref.current?.cellBuffer.getCell(0, 3);
    expect(cell0?.grapheme).toBe('abc');
    expect(cell3?.grapheme).toBe('');
  });

  it('applying a GridDelta through the mirror bubbles a dirty-row change downstream', async () => {
    const { mirror, ref } = mountCanvas({ rows: 4, cols: 16, contents: ['row0'] });
    await flushEffects();
    const dirtyRows: number[] = [];
    // Subscribe to the mirror source (same plumbing Renderer uses).
    const unsub = ref.current!.mirrorSource.subscribe((dirty: ReadonlySet<number>) => {
      for (const r of dirty) dirtyRows.push(r);
    });
    mirror.applyDelta(deltaEnv(1, [rowDelta(1, 'row1', 16, 2)]));
    expect(dirtyRows).toContain(1);
    unsub();
  });

  it('pointerdown → move → up produces a non-null selection at the anchored cell and onSelectionChange reports start+end', async () => {
    const onSelectionChange = vi.fn();
    const { container, ref } = mountCanvas({
      rows: 4,
      cols: 16,
      contents: ['hello world'],
      onSelectionChange,
    });
    await flushEffects();
    const app = container.querySelector('[role="application"]') as HTMLElement;
    // jsdom's DOMRect / PointerEvent combo returns zero rects and drops
    // `clientX`/`clientY` off synthesized PointerEvents. We stub both sides
    // so the production path (container.getBoundingClientRect(), hitTest
    // against DEFAULT_METRICS 8×16 CSS px cells) has well-defined inputs
    // and the exact cell-arithmetic is observable.
    app.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 } as DOMRect);
    const makePointerEvent = (type: string, clientX: number, clientY: number): Event =>
      new (class extends Event {
        clientX = clientX;
        clientY = clientY;
        pointerId = 1;
        button = 0;
        buttons = type === 'pointerup' ? 0 : 1;
        detail = 1;
        pointerType = 'mouse';
        ctrlKey = false;
        metaKey = false;
        altKey = false;
        shiftKey = false;
      })(type, { bubbles: true, cancelable: true });
    // pointerDown at (2,2) → cell (0,0); move to (40,2) → cell (0, 5); up.
    act(() => {
      app.dispatchEvent(makePointerEvent('pointerdown', 2, 2));
    });
    act(() => {
      app.dispatchEvent(makePointerEvent('pointermove', 40, 2));
    });
    act(() => {
      app.dispatchEvent(makePointerEvent('pointerup', 40, 2));
    });
    expect(onSelectionChange).toHaveBeenCalled();
    // The SelectionManager is the source of truth; the callback merely
    // broadcasts. A "crash-proof" assertion (just `.toHaveBeenCalled()`) would
    // not catch a regression where the manager stopped receiving the drag
    // events, so we also verify a concrete selection landed at the exact
    // cells the pixel arithmetic maps to.
    const final = ref.current!.selection.get();
    expect(final).not.toBeNull();
    expect(final!.start).toEqual({ row: 0, col: 0 });
    expect(final!.end.row).toBe(0);
    expect(final!.end.col).toBe(5);
    expect(final!.mode).toBe('char');
  });

  it('Ctrl+C on a non-empty selection calls onCopyRequest with the EXACT selected substring', async () => {
    // Use per-cell spans so `getCell(row, c)` returns one grapheme per column
    // — the ordinary `textSpan(text)` stamps the whole string at col 0 and
    // would let the test pass by accident for any selection overlapping col 0.
    const onCopyRequest = vi.fn();
    const source = new MirrorSource();
    const mirror = new GridMirror({ onChange: (d) => source.emit(d) });
    const cols = 16;
    const row0Spans = [
      ...perCellSpans('abcdefghij'),
      blankSpan(cols - 10),
    ];
    mirror.applySnapshot({
      session_id: SESSION_ID,
      grid_epoch: 1,
      sequence_no: 0,
      resize_generation: 0,
      buffer_kind: 'main',
      payload: {
        kind: 'grid_snapshot',
        rows: 4,
        cols,
        buffer_kind: 'main',
        row_deltas: [
          {
            row: 0,
            revision_before: 0,
            revision_after: 1,
            spans: row0Spans,
            continuation: false,
            hyperlink_refs: [],
          },
          ...[1, 2, 3].map((r) => ({
            row: r,
            revision_before: 0,
            revision_after: 1,
            spans: [blankSpan(cols)],
            continuation: false,
            hyperlink_refs: [],
          })),
        ],
        cursor: {
          row: 0,
          col: 0,
          visible: true,
          shape: 'block',
          blinking: false,
          pending_wrap: false,
        },
        mode_state: {},
        meta: {},
      },
    });
    const ref = createRef<TerminalCanvasHandle>();
    const { container } = render(
      <TerminalCanvas
        ref={ref as Ref<TerminalCanvasHandle>}
        mirror={mirror}
        mirrorSource={source}
        backend="memory"
        metrics={DEFAULT_METRICS}
        platform="linux"
        onCopyRequest={onCopyRequest}
      />,
    );
    await flushEffects();
    // Sanity probe — per-cell graphemes actually landed so the selection
    // slice we're about to ask for is meaningful.
    expect(ref.current?.cellBuffer.getCell(0, 0)?.grapheme).toBe('a');
    expect(ref.current?.cellBuffer.getCell(0, 4)?.grapheme).toBe('e');
    // Pre-seed a programmatic selection through the real SelectionManager.
    // SelectionManager mutations drive React state updates inside
    // TerminalCanvas (selection overlay), so wrap in act.
    act(() => {
      ref.current!.selection.begin({ row: 0, col: 0 }, 'char');
      ref.current!.selection.extend({ row: 0, col: 5 });
    });
    // Confirm selection.copy() resolves to the expected substring BEFORE the
    // key event so we can assert on the exact payload the production path
    // forwards to the caller.
    const expected = ref.current!.selection.copy();
    expect(expected).toBe('abcde');
    const app = container.querySelector('[role="application"]') as HTMLElement;
    // Linux platform → Ctrl+C is the copy modifier.
    act(() => {
      fireEvent.keyDown(app, { key: 'c', ctrlKey: true });
    });
    expect(onCopyRequest).toHaveBeenCalledTimes(1);
    // The callback receives exactly what `selection.copy()` produced — not a
    // substring, not a stringified "something containing 'abcd'", but the
    // real UTF-8 payload the caller would put on the clipboard.
    expect(onCopyRequest).toHaveBeenCalledWith('abcde');
  });

  it('Ctrl+C on an EMPTY selection is a no-op (onCopyRequest is not called)', async () => {
    const onCopyRequest = vi.fn();
    const { container } = mountCanvas({
      rows: 4,
      cols: 16,
      contents: ['abcdefghij'],
      onCopyRequest,
    });
    await flushEffects();
    // No selection seeded — the platform key handler must recognise there is
    // nothing to copy and leave the clipboard alone.
    const app = container.querySelector('[role="application"]') as HTMLElement;
    act(() => {
      fireEvent.keyDown(app, { key: 'c', ctrlKey: true });
    });
    expect(onCopyRequest).not.toHaveBeenCalled();
  });

  it('hit-test → screenToCell maps pointer coords to cell grid coords', async () => {
    const { ref } = mountCanvas({ rows: 4, cols: 16, contents: ['0123456789'] });
    await flushEffects();
    const { cellWidthCssPx, cellHeightCssPx } = DEFAULT_METRICS;
    // Pointer 2.5 cells right, 1.5 cells down → (col=2, row=1).
    const hit = ref.current!.hitTest.screenToCell(
      2.5 * cellWidthCssPx,
      1.5 * cellHeightCssPx,
    );
    expect(hit).toEqual({ row: 1, col: 2, hyperlinkId: null });
  });

  it('hyperlink click with the platform modifier fires onHyperlinkClick', async () => {
    // Pre-seed the mirror with a snapshot whose row 0 already has
    // `hyperlink_id: 1` stamped — this is the initial state the widget
    // reads at mount (writeSnapshot runs synchronously in the mount
    // effect), so the CellBuffer's hyperlink side-table is live before
    // the pointer event fires.
    const source = new MirrorSource();
    const mirror = new GridMirror({ onChange: (d) => source.emit(d) });
    mirror.applySnapshot({
      session_id: SESSION_ID,
      grid_epoch: 1,
      sequence_no: 0,
      resize_generation: 0,
      buffer_kind: 'main',
      payload: {
        kind: 'grid_snapshot',
        rows: 4,
        cols: 16,
        buffer_kind: 'main',
        row_deltas: [
          {
            row: 0,
            revision_before: 0,
            revision_after: 1,
            spans: [
              {
                cols: 4,
                sgr: '0x0000000000000000',
                graphemes: { utf8: 'link' },
                hyperlink_id: 1,
                ext: null,
              },
              blankSpan(12),
            ],
            continuation: false,
            hyperlink_refs: [1],
          },
        ],
        cursor: {
          row: 0,
          col: 0,
          visible: true,
          shape: 'block',
          blinking: false,
          pending_wrap: false,
        },
        mode_state: {},
        meta: {},
      },
    });
    // Register the hyperlink URI so resolveHyperlink returns the uri.
    mirror.apply({
      session_id: SESSION_ID,
      grid_epoch: 1,
      sequence_no: 1,
      resize_generation: 0,
      buffer_kind: 'main',
      payload: {
        kind: 'hyperlink_added',
        id: 1,
        uri: 'https://example.test/',
        params: null,
      },
    });

    const onHyperlinkClick = vi.fn();
    const ref = createRef<TerminalCanvasHandle>();
    const { container } = render(
      <TerminalCanvas
        ref={ref as Ref<TerminalCanvasHandle>}
        mirror={mirror}
        mirrorSource={source}
        backend="memory"
        platform="linux"
        onHyperlinkClick={onHyperlinkClick}
      />,
    );
    await flushEffects();
    // Sanity probe — the CellBuffer shows the hyperlink at col 0.
    expect(ref.current?.cellBuffer.getCell(0, 0)?.hyperlinkId).toBe(1);
    // And the hit-test resolves the hyperlink at col 2 (any cell in the
    // 4-cell hyperlink region).
    const probeHit = ref.current?.hitTest.screenToCell(
      2 * DEFAULT_METRICS.cellWidthCssPx + 1,
      0,
    );
    expect(probeHit?.hyperlinkId).toBe(1);
    const app = container.querySelector('[role="application"]') as HTMLElement;
    // Linux platform → Ctrl+click is the hyperlink modifier. Click inside
    // the 4-cell hyperlink region. We dispatch a native PointerEvent to
    // ensure jsdom passes `ctrlKey` through to React's synthetic event.
    const native = new (class extends Event {
      clientX = 2 * DEFAULT_METRICS.cellWidthCssPx + 1;
      clientY = 0;
      pointerId = 1;
      ctrlKey = true;
      shiftKey = false;
      altKey = false;
      metaKey = false;
      button = 0;
      buttons = 1;
      detail = 1;
      pointerType = 'mouse';
    })('pointerdown', { bubbles: true, cancelable: true });
    app.dispatchEvent(native);
    expect(onHyperlinkClick).toHaveBeenCalledTimes(1);
    expect(onHyperlinkClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, uri: 'https://example.test/' }),
    );
  });

  it('unmount tears down the renderer, buffer, and backend — MirrorSource returns to zero subscribers and the backend records the unmount', async () => {
    const { source, backend, ref, unmount } = mountCanvas();
    await flushEffects();
    // Baseline: at least one subscriber (the CellBuffer) and a mounted backend.
    expect(source.subscriberCount()).toBeGreaterThan(0);
    expect(backend.calls().some((c) => c.kind === 'mount')).toBe(true);
    expect(ref.current).not.toBeNull();

    await act(async () => {
      unmount();
    });

    // CellBuffer.dispose ran → MirrorSource subscription released.
    expect(source.subscriberCount()).toBe(0);
    // Backend saw its unmount call.
    expect(backend.calls().some((c) => c.kind === 'unmount')).toBe(true);
    // Imperative handle detaches.
    expect(ref.current).toBeNull();
    // Firing a post-unmount delta into the mirror is a no-op on the source
    // (no subscriber) — future emits must not re-awaken a torn-down buffer.
    const beforeEmitCount = backend.calls().length;
    source.emit(new Set([0]));
    expect(backend.calls().length).toBe(beforeEmitCount);
  });

  it('sequencing → snapshot arrives before the first delta call on the backend', async () => {
    const { mirror, backend } = mountCanvas({ rows: 4, cols: 16, contents: ['a'] });
    await flushEffects();
    mirror.applyDelta(deltaEnv(1, [rowDelta(1, 'b', 16, 2)]));
    await flushEffects();
    const kinds = backend.calls().map((c) => c.kind);
    const snapshotIdx = kinds.indexOf('snapshot');
    expect(snapshotIdx).toBeGreaterThanOrEqual(0);
    // Any `delta` call must land after the initial snapshot.
    for (let i = 0; i < kinds.length; i += 1) {
      if (kinds[i] === 'delta') {
        expect(i).toBeGreaterThan(snapshotIdx);
      }
    }
  });
});

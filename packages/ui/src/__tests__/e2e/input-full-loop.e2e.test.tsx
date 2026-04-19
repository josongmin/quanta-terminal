/**
 * **Final E2E — plain key input full loop**
 *
 * Covers the non-IME input pipeline end-to-end:
 *
 *   DOM KeyboardEvent → `input-host` → `KeyEncoder` → `onBytesOut`
 *
 * Plus a composed scenario where a key press is echoed into the grid
 * through a real `GridMirror → CellBuffer → TerminalCanvas` stack, so
 * that the "input went to PTY, PTY echoed back, renderer observed it"
 * loop is tested at a single observation point.
 *
 * Counterpart to `ime-end-to-end.e2e.test.tsx` which covers composing
 * events. This file deliberately excludes IME; all keydowns here have
 * `isComposing=false`.
 */

import { act, render } from '@testing-library/react';
import { createRef, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Focus } from '../../features/input/Focus.js';
import { KeyEncoder } from '../../features/input/KeyEncoder.js';
import { MouseEncoder } from '../../features/input/MouseEncoder.js';
import { Paste } from '../../features/input/Paste.js';
import { createStubMirror, ModeSnapshot } from '../../features/input/ModeSnapshot.js';
import { mount } from '../../features/input/input-host.js';
import { GridMirror } from '../../shared/lib/grid-mirror/index.js';
import type { CellSpan, RowDelta } from '../../shared/lib/grid-mirror/types.js';
import {
  DEFAULT_METRICS,
  MirrorSource,
} from '../../shared/ui/cell-renderer/index.js';
import {
  TerminalCanvas,
  type TerminalCanvasHandle,
} from '../../widgets/terminal-canvas/TerminalCanvas.js';

const SESSION_ID = '01J00000000000000000000001';

interface InputHarness {
  container: HTMLElement;
  handle: ReturnType<typeof mount>;
  bytesOut: Uint8Array[];
  mirror: ReturnType<typeof createStubMirror>;
}

function makeInputHarness(
  init: Parameters<typeof createStubMirror>[0] = {},
): InputHarness {
  const mirror = createStubMirror(init);
  const modeSnapshot = new ModeSnapshot(mirror);
  const keyEncoder = new KeyEncoder({ modeSnapshot });
  const mouseEncoder = new MouseEncoder({ modeSnapshot });
  const paste = new Paste({ modeSnapshot });
  const focus = new Focus({ modeSnapshot });

  const bytesOut: Uint8Array[] = [];

  const container = document.createElement('div');
  container.setAttribute('tabindex', '0');
  document.body.appendChild(container);

  const handle = mount(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform: 'linux',
    onBytesOut: (b) => bytesOut.push(b),
  });

  return { container, handle, bytesOut, mirror };
}

/** Flatten recorded byte chunks into a single Uint8Array. */
function flatten(buffers: readonly Uint8Array[]): Uint8Array {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

function hex(buffers: readonly Uint8Array[]): string {
  return Array.from(flatten(buffers))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

/** Dispatch a native KeyboardEvent onto the given element. */
function keyDown(
  el: HTMLElement,
  init: KeyboardEventInit & { key: string; code?: string },
): void {
  el.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, ...init }),
  );
}

/**
 * jsdom has no `DataTransfer`, so we fabricate a minimal clipboardData
 * surface and attach it to a plain `Event` labelled 'paste'. `input-host`
 * only reads `ev.clipboardData?.getData('text')`, which this shim covers.
 */
function dispatchPaste(el: HTMLElement, text: string): void {
  const ev = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'clipboardData', {
    value: { getData: (kind: string) => (kind === 'text' ? text : '') },
  });
  el.dispatchEvent(ev);
}

// --- GridMirror helpers (reused from full-stack-pipeline.e2e.test.tsx) -----

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

async function flushEffects(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

// -------------------------------------------------------------------------

describe('plain-key input full loop (e2e)', () => {
  let harness: InputHarness;

  beforeEach(() => {
    harness = makeInputHarness();
  });

  afterEach(() => {
    harness.handle.unmount();
    harness.container.remove();
  });

  it('plain "a" keydown → onBytesOut receives [0x61] exactly once', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'a', code: 'KeyA' });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x61]);
  });

  it('Shift+"A" → [0x41]', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'A', code: 'KeyA', shiftKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x41]);
  });

  it('Ctrl+C → [0x03] (SIGINT byte)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'c', code: 'KeyC', ctrlKey: true });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x03]);
  });

  it('Enter → [0x0d]', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Enter', code: 'Enter' });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x0d]);
  });

  it('Esc → [0x1b]', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Escape', code: 'Escape' });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b]);
  });

  it('Arrow Up (DECCKM off) → ESC [ A', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'ArrowUp', code: 'ArrowUp' });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x5b, 0x41]);
  });

  it('Backspace → [0x7f]', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Backspace', code: 'Backspace' });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x7f]);
  });

  it('fast sequential keydowns invoke onBytesOut once per key in order', () => {
    const { container, bytesOut } = harness;
    const keys: Array<{ key: string; code: string; expect: number }> = [
      { key: 'h', code: 'KeyH', expect: 0x68 },
      { key: 'i', code: 'KeyI', expect: 0x69 },
      { key: '!', code: 'Digit1', expect: 0x21 },
      { key: 'Enter', code: 'Enter', expect: 0x0d },
    ];
    for (const k of keys) {
      keyDown(container, { key: k.key, code: k.code });
    }
    expect(bytesOut).toHaveLength(keys.length);
    for (let i = 0; i < keys.length; i += 1) {
      expect(Array.from(bytesOut[i]!)).toEqual([keys[i]!.expect]);
    }
  });

  it('keypress then grid delta round-trip: PTY echo simulation paints the typed char into the CellBuffer', async () => {
    // Real TerminalCanvas + real GridMirror. We drive keys into `input-host`
    // (bytes leave via onBytesOut) and then simulate the PTY echoing the
    // byte back by applying a delta to the mirror. The "full loop" is:
    //
    //   keydown('a') → encoder → onBytesOut([0x61])   (the write half)
    //   mirror.applyDelta(row='a') → dirty-row fires  (the read half)
    //   canvas handle.applySnapshot(rows)             (buffer sync)
    //   cellBuffer.getCell(0,0) === 'a'               (observed)
    //
    // The prod path from mirror-dirty → cell-buffer runs on the Renderer's
    // rAF tick; here we invoke the widget's imperative `applySnapshot`
    // API to bypass rAF and make the observation deterministic.
    const source = new MirrorSource();
    const mirror = new GridMirror({ onChange: (d) => source.emit(d) });
    mirror.applySnapshot(snapshotEnv(4, 16, ['']));

    const canvasRef = createRef<TerminalCanvasHandle>();
    const result = render(
      <TerminalCanvas
        ref={canvasRef as Ref<TerminalCanvasHandle>}
        mirror={mirror}
        mirrorSource={source}
        backend="memory"
        metrics={DEFAULT_METRICS}
        platform="linux"
      />,
    );
    await flushEffects();

    const { container: inputEl, bytesOut } = harness;

    // Track dirty-row notifications from the mirror source (the signal
    // that the renderer would use to schedule a frame in prod).
    const dirtyRows: number[] = [];
    const unsub = canvasRef.current!.mirrorSource.subscribe(
      (dirty: ReadonlySet<number>) => {
        for (const r of dirty) dirtyRows.push(r);
      },
    );

    // 1. User presses "a" — input-host encodes and hands to onBytesOut.
    keyDown(inputEl, { key: 'a', code: 'KeyA' });
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x61]);

    // 2. Simulate the PTY echoing the byte back — a delta writes "a" into
    // row 0, col 0.
    await act(async () => {
      mirror.applyDelta(deltaEnv(1, [rowDelta(0, 'a', 16, 2)]));
      await flushEffects();
    });
    // The mirror-source dirty signal fired for row 0.
    expect(dirtyRows).toContain(0);

    // 3. Sync the buffer with the mirror's new state (prod path: renderer
    // tick pulls via rowFetcher; test path: imperative applySnapshot).
    const dims = mirror.getDimensions();
    const rows = Array.from({ length: dims.rows }, (_, r) => mirror.getRow(r)!);
    await act(async () => {
      canvasRef.current!.applySnapshot(rows, mirror.getCursor(), mirror.getMode());
    });

    // 4. The CellBuffer now sees the echoed glyph.
    const cell = canvasRef.current?.cellBuffer.getCell(0, 0);
    expect(cell?.grapheme).toBe('a');

    unsub();
    result.unmount();
  });

  it('paste with bracketed paste OFF forwards the text bytes verbatim', () => {
    const { container, bytesOut } = harness;
    dispatchPaste(container, 'hi');
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x68, 0x69]); // "hi"
  });

  it('paste with bracketed paste ON wraps with ESC [ 200 ~ / ESC [ 201 ~ sentinels', () => {
    // New harness with bracketedPaste toggled on.
    harness.handle.unmount();
    harness.container.remove();
    harness = makeInputHarness({ bracketedPaste: true });
    const { container, bytesOut } = harness;

    dispatchPaste(container, 'hi');
    expect(bytesOut).toHaveLength(1);
    // ESC [ 2 0 0 ~ 'h' 'i' ESC [ 2 0 1 ~
    expect(hex(bytesOut)).toBe('1b5b3230307e68691b5b3230317e');
  });

  it('focus gain with focusReporting ON → emits ESC [ I', () => {
    harness.handle.unmount();
    harness.container.remove();
    harness = makeInputHarness({ focusReporting: true });
    const { container, bytesOut } = harness;
    // Capture-phase focus listener fires from a dispatched focus Event.
    container.dispatchEvent(new Event('focus'));
    // Last emit should be the focus-in sequence (0x1b 0x5b 0x49).
    const lastOut = bytesOut.at(-1);
    expect(lastOut).toBeDefined();
    expect(Array.from(lastOut!)).toEqual([0x1b, 0x5b, 0x49]);
  });

  it('blur with focusReporting ON → emits ESC [ O', () => {
    harness.handle.unmount();
    harness.container.remove();
    harness = makeInputHarness({ focusReporting: true });
    const { container, bytesOut } = harness;
    container.dispatchEvent(new Event('blur'));
    const lastOut = bytesOut.at(-1);
    expect(lastOut).toBeDefined();
    expect(Array.from(lastOut!)).toEqual([0x1b, 0x5b, 0x4f]);
  });

  it('focus/blur with focusReporting OFF → no focus bytes emitted', () => {
    // Default harness (focusReporting=false).
    const { container, bytesOut } = harness;
    container.dispatchEvent(new Event('focus'));
    container.dispatchEvent(new Event('blur'));
    expect(bytesOut).toHaveLength(0);
  });

  it('unmount removes all keyboard listeners — subsequent keydown emits nothing', () => {
    const { container, handle, bytesOut } = harness;
    keyDown(container, { key: 'a', code: 'KeyA' });
    expect(bytesOut).toHaveLength(1);
    handle.unmount();
    keyDown(container, { key: 'b', code: 'KeyB' });
    keyDown(container, { key: 'Enter', code: 'Enter' });
    // Unchanged — the two post-unmount keys are dropped on the floor.
    expect(bytesOut).toHaveLength(1);
  });

  it('onBytesOut is a vi.fn() spy: each key fires the callback exactly once', () => {
    // Rebuild with a spy so we can assert call count shape.
    harness.handle.unmount();
    harness.container.remove();

    const mirror = createStubMirror();
    const modeSnapshot = new ModeSnapshot(mirror);
    const spy = vi.fn<(bytes: Uint8Array) => void>();
    const container = document.createElement('div');
    container.setAttribute('tabindex', '0');
    document.body.appendChild(container);
    const handle = mount(container, {
      keyEncoder: new KeyEncoder({ modeSnapshot }),
      mouseEncoder: new MouseEncoder({ modeSnapshot }),
      paste: new Paste({ modeSnapshot }),
      focus: new Focus({ modeSnapshot }),
      platform: 'linux',
      onBytesOut: spy,
    });

    keyDown(container, { key: 'x', code: 'KeyX' });
    keyDown(container, { key: 'y', code: 'KeyY' });
    keyDown(container, { key: 'z', code: 'KeyZ' });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(Array.from(spy.mock.calls[0]![0])).toEqual([0x78]);
    expect(Array.from(spy.mock.calls[1]![0])).toEqual([0x79]);
    expect(Array.from(spy.mock.calls[2]![0])).toEqual([0x7a]);

    // Rehydrate the outer harness so the afterEach cleanup still runs
    // against a mounted handle/container.
    handle.unmount();
    container.remove();
    harness = makeInputHarness();
  });

  it('modifier-only keydown (Shift alone) emits no bytes', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
    expect(bytesOut).toHaveLength(0);
  });
});

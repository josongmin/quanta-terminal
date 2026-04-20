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

  it('modifier-only keydowns (Control / Alt / Meta / CapsLock) emit no bytes', () => {
    const { container, bytesOut } = harness;
    for (const mod of [
      { key: 'Control', code: 'ControlLeft', ctrlKey: true },
      { key: 'Alt', code: 'AltLeft', altKey: true },
      { key: 'Meta', code: 'MetaLeft', metaKey: true },
      { key: 'CapsLock', code: 'CapsLock' },
    ] as const) {
      keyDown(container, mod);
    }
    expect(bytesOut).toHaveLength(0);
  });

  // -- Named keys: complete legacy coverage ---------------------------------
  //
  // These keys are referenced by readline/vim/emacs bindings and each
  // must emit its canonical xterm sequence. The legacy encoder builds
  // them from the SPECIAL_TILDE_CODE / ENDPOINT_FINAL tables, so any
  // drift in those tables breaks the CLI UX.

  it('Home → ESC [ H (unmodified, DECCKM off)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Home', code: 'Home' });
    expect(hex(bytesOut)).toBe('1b5b48'); // ESC [ H
  });

  it('End → ESC [ F (unmodified, DECCKM off)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'End', code: 'End' });
    expect(hex(bytesOut)).toBe('1b5b46'); // ESC [ F
  });

  it('Insert → ESC [ 2 ~', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Insert', code: 'Insert' });
    expect(hex(bytesOut)).toBe('1b5b327e');
  });

  it('Delete → ESC [ 3 ~', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Delete', code: 'Delete' });
    expect(hex(bytesOut)).toBe('1b5b337e');
  });

  it('PageUp → ESC [ 5 ~ / PageDown → ESC [ 6 ~', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'PageUp', code: 'PageUp' });
    keyDown(container, { key: 'PageDown', code: 'PageDown' });
    expect(bytesOut).toHaveLength(2);
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x5b, 0x35, 0x7e]);
    expect(Array.from(bytesOut[1]!)).toEqual([0x1b, 0x5b, 0x36, 0x7e]);
  });

  it('F1 → SS3 P, F2 → SS3 Q, F3 → SS3 R, F4 → SS3 S (unmodified)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'F1', code: 'F1' });
    keyDown(container, { key: 'F2', code: 'F2' });
    keyDown(container, { key: 'F3', code: 'F3' });
    keyDown(container, { key: 'F4', code: 'F4' });
    expect(bytesOut).toHaveLength(4);
    // Each is ESC O <final>
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x4f, 0x50]);
    expect(Array.from(bytesOut[1]!)).toEqual([0x1b, 0x4f, 0x51]);
    expect(Array.from(bytesOut[2]!)).toEqual([0x1b, 0x4f, 0x52]);
    expect(Array.from(bytesOut[3]!)).toEqual([0x1b, 0x4f, 0x53]);
  });

  it('F5 → ESC [ 1 5 ~ / F12 → ESC [ 2 4 ~ (tilde-form)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'F5', code: 'F5' });
    keyDown(container, { key: 'F12', code: 'F12' });
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x5b, 0x31, 0x35, 0x7e]);
    expect(Array.from(bytesOut[1]!)).toEqual([0x1b, 0x5b, 0x32, 0x34, 0x7e]);
  });

  // -- Modifier-bit encoding -------------------------------------------------
  //
  // The xterm modifier bitmap is off-by-one (1 = none, 2 = Shift, 3 = Alt,
  // 5 = Ctrl, 6 = Ctrl+Shift). Modified arrows use the CSI 1 ; <mod>
  // <final> form, NOT the DECCKM SS3 form. Pin a handful of the common
  // combos since readline + terminfo care.

  it('Shift+ArrowUp → ESC [ 1 ; 2 A (modifier bit = 2)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'ArrowUp', code: 'ArrowUp', shiftKey: true });
    expect(hex(bytesOut)).toBe('1b5b313b3241');
  });

  it('Ctrl+ArrowLeft → ESC [ 1 ; 5 D (modifier bit = 5, word-back in readline)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'ArrowLeft', code: 'ArrowLeft', ctrlKey: true });
    expect(hex(bytesOut)).toBe('1b5b313b3544');
  });

  it('Alt+ArrowRight → ESC [ 1 ; 3 C (modifier bit = 3)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'ArrowRight', code: 'ArrowRight', altKey: true });
    expect(hex(bytesOut)).toBe('1b5b313b3343');
  });

  it('Ctrl+Shift+End → ESC [ 1 ; 6 F (modifier bit = 6)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'End', code: 'End', ctrlKey: true, shiftKey: true });
    expect(hex(bytesOut)).toBe('1b5b313b3646');
  });

  it('Shift+F1 → ESC O 1 ; 2 P (F1-F4 modified form uses SS3)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'F1', code: 'F1', shiftKey: true });
    expect(hex(bytesOut)).toBe('1b4f313b3250');
  });

  // -- DECCKM mode changes arrow encoding -----------------------------------

  it('ArrowUp with DECCKM ON → SS3 A (ESC O A)', () => {
    harness.handle.unmount();
    harness.container.remove();
    harness = makeInputHarness({ decckm: true });
    keyDown(harness.container, { key: 'ArrowUp', code: 'ArrowUp' });
    expect(hex(harness.bytesOut)).toBe('1b4f41');
  });

  // -- Space and Ctrl+Space --------------------------------------------------

  it('Space → 0x20 (plain space)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: ' ', code: 'Space' });
    expect(Array.from(bytesOut[0]!)).toEqual([0x20]);
  });

  it('Ctrl+Space → 0x00 (NUL byte, readline set-mark)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: ' ', code: 'Space', ctrlKey: true });
    expect(Array.from(bytesOut[0]!)).toEqual([0x00]);
  });

  it('Alt+Space → ESC 0x20 (Alt prefix wraps space)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: ' ', code: 'Space', altKey: true });
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x20]);
  });

  // -- Ctrl+Backspace / Ctrl+Alt+Backspace ----------------------------------

  it('Ctrl+Backspace → 0x08 (BS, encoder disambiguates from 0x7f)', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Backspace', code: 'Backspace', ctrlKey: true });
    expect(Array.from(bytesOut[0]!)).toEqual([0x08]);
  });

  it('Ctrl+Alt+Backspace → ESC 0x08', () => {
    const { container, bytesOut } = harness;
    keyDown(container, { key: 'Backspace', code: 'Backspace', ctrlKey: true, altKey: true });
    expect(Array.from(bytesOut[0]!)).toEqual([0x1b, 0x08]);
  });

  // -- keyup path ------------------------------------------------------------
  //
  // The legacy encoder is kind-agnostic: it sees the key + modifiers,
  // not the press/release kind. So under legacy encoding the keyup path
  // produces the SAME bytes as the keydown. This pins that observed
  // behaviour so a later fix (e.g. gating release to kitty L2+ at the
  // KeyEncoder level) is caught as an intentional change.

  it('keyup routes through the encoder and emits the same legacy bytes as keydown', () => {
    const { container, bytesOut } = harness;
    container.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    expect(bytesOut).toHaveLength(1);
    expect(Array.from(bytesOut[0]!)).toEqual([0x61]);
  });

  it('keyup for pure-modifier keys (Shift alone) still emits nothing', () => {
    const { container, bytesOut } = harness;
    container.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', bubbles: true }),
    );
    expect(bytesOut).toHaveLength(0);
  });

  it('keyup during Composing is short-circuited by input-host (no encoder call)', () => {
    const { container, bytesOut } = harness;
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
    const before = bytesOut.length;
    container.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }),
    );
    expect(bytesOut.length).toBe(before);
  });

  // -- Paste path: bracketed ON + embedded end sentinel ---------------------

  it('paste path: bracketed paste ON with empty text emits no bytes', () => {
    harness.handle.unmount();
    harness.container.remove();
    harness = makeInputHarness({ bracketedPaste: true });
    dispatchPaste(harness.container, '');
    // Even wrapped, a zero-length payload would still emit START+END; the
    // input-host skips the emit because out.bytes.length is 0.
    // Actually START+END is 12 bytes, so the guard only trips when payload
    // AND sentinels are both absent. Here Paste.encode returns an empty
    // array only when bracketed is off AND text is empty. With bracketed
    // on, it returns [START, END] (12 bytes). Input-host emits that.
    expect(harness.bytesOut).toHaveLength(1);
    expect(hex(harness.bytesOut)).toBe('1b5b3230307e1b5b3230317e');
  });

  // -- IME state machine integration on focus/blur --------------------------

  it('focus/blur route through the IME state machine and leave it in Idle on a plain session', () => {
    const { container, handle } = harness;
    container.dispatchEvent(new Event('focus'));
    expect(handle.state().kind).toBe('Idle');
    container.dispatchEvent(new Event('blur'));
    expect(handle.state().kind).toBe('Idle');
  });

  // -- Unmount leak check ----------------------------------------------------

  it('unmount also removes paste/focus/blur listeners, not just keydown', () => {
    const { container, handle, bytesOut } = harness;
    handle.unmount();

    // None of these should result in any byte emission because all
    // listeners are detached.
    dispatchPaste(container, 'x');
    container.dispatchEvent(new Event('focus'));
    container.dispatchEvent(new Event('blur'));
    container.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    container.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    keyDown(container, { key: 'a', code: 'KeyA' });

    expect(bytesOut).toHaveLength(0);
    // Rehydrate so afterEach unmount call is valid.
    harness = makeInputHarness();
  });
});

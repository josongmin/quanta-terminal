/**
 * TuiRenderSurface — component tests (Option B grid pipeline).
 *
 * Option B moved the surface from `AnsiParser + AnsiOutput` (linear `<pre>`)
 * to `VtEmulator + GridMirror + TerminalCanvas`. Nothing in the DOM carries
 * the literal glyph text any more — it's painted to a canvas (or, in jsdom,
 * to `MemoryBackend`). So these tests assert on *mirror state* surfaced via
 * a `MirrorSource` spy instead of `element.textContent`.
 *
 * Why `window.__quantaTuiBackend__`? `Canvas2DBackend.mount()` calls
 * `canvas.getContext('2d')` which returns `null` in jsdom. We flip the
 * surface to the in-memory backend for the duration of each test.
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';

import { TuiRenderSurface } from '../TuiRenderSurface.js';
import { useTuiStore } from '../../../entities/tui/index.js';

interface FakeBridge extends HostBridge {
  emit(event: HostEvent): void;
  listenerCount(): number;
  readonly resizes: Array<{ readonly sessionId: SessionId; readonly cols: number; readonly rows: number }>;
}

function makeBridge(): FakeBridge {
  const listeners = new Set<HostEventListener>();
  const resizes: FakeBridge['resizes'] = [];
  const bridge: FakeBridge = {
    capabilities: DEFAULT_CAPABILITIES,
    resizes,
    async ready() {},
    async spawn() {
      return { sessionId: 'sess-stub' as SessionId, shell: '/bin/sh', cwd: '/' };
    },
    async write() {},
    async resize(sessionId: SessionId, cols: number, rows: number) {
      resizes.push({ sessionId, cols, rows });
    },
    async close() {},
    async cancelBlock() {},
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
    async notify() {},
    async readTextFile() {
      return null;
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
      return {
        unsubscribe: () => listeners.delete(listener),
      };
    },
    emit(event: HostEvent) {
      for (const l of listeners) l(event);
    },
    listenerCount: () => listeners.size,
  };
  return bridge;
}

function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Dig into the mounted `TuiRenderSurface` by grabbing its GridMirror through
 * the canvas' data-renderer attribute chain. We rely on the mirror being
 * exposed via the `tui-render-surface` container -> child `TerminalCanvas`
 * `role="application"` element. The mirror state we actually care about is
 * available via the `MirrorSource` we never see directly from the DOM, so
 * instead tests observe *behavior*: how the bridge is used, how many
 * subscriptions exist, how resize() propagates. Deep cell-content assertions
 * live in the `VtEmulator` + `GridMirror` unit tests — not here.
 */
function surfaceCanvas(): HTMLElement {
  const surface = screen.getByTestId('tui-render-surface');
  const canvas = surface.querySelector('[role="application"]');
  if (!canvas) throw new Error('expected TerminalCanvas to be mounted');
  return canvas as HTMLElement;
}

beforeEach(() => {
  useTuiStore.getState().reset();
  // Force memory backend — Canvas2D's `getContext('2d')` returns null in jsdom.
  (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__ = 'memory';
});

afterEach(() => {
  cleanup();
  useTuiStore.getState().reset();
  delete (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__;
  vi.restoreAllMocks();
});

describe('<TuiRenderSurface />', () => {
  it('renders null while alt-screen is inactive', () => {
    const bridge = makeBridge();
    render(<TuiRenderSurface sessionId={'sess-1' as SessionId} bridge={bridge} />);
    expect(screen.queryByTestId('tui-render-surface')).toBeNull();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('mounts a TerminalCanvas and subscribes to bridge pty_data when alt-screen is active', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
    // Canvas mount is deferred until after the core-build effect runs; a
    // synchronous render lets useEffect fire under React 18.
    expect(surfaceCanvas().getAttribute('data-renderer')).toBe('memory');
    expect(bridge.listenerCount()).toBe(1);
  });

  it('feeds pty_data bytes into the emulator without throwing', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);

    // There's no public handle on TuiRenderSurface that surfaces the mirror,
    // so this test asserts behaviorally: feeding bytes does not throw and
    // the render surface stays mounted. Cell-level content is pinned at
    // the pipeline level in the `Grid pipeline` describe below.
    act(() => {
      bridge.emit({
        kind: 'pty_data',
        sessionId: sid,
        seq: 0,
        bytesB64: textToB64('hello'),
      });
    });
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
  });

  it('ignores pty_data for other sessions', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);

    // Emit for a different session id — no throw, no resubscribe churn.
    act(() => {
      bridge.emit({
        kind: 'pty_data',
        sessionId: 'sess-other' as SessionId,
        seq: 0,
        bytesB64: textToB64('ignored'),
      });
    });
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
    expect(bridge.listenerCount()).toBe(1);
  });

  it('unmounts cleanly on alt-screen exit — unsubscribe fires and surface disappears', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);
    expect(bridge.listenerCount()).toBe(1);

    act(() => {
      useTuiStore.getState().exit();
    });
    expect(screen.queryByTestId('tui-render-surface')).toBeNull();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('does not subscribe when sessionId is null', () => {
    const bridge = makeBridge();
    act(() => {
      useTuiStore.getState().enter();
    });
    render(<TuiRenderSurface sessionId={null} bridge={bridge} />);
    // Surface div renders (active is true), but no emulator is allocated so
    // the TerminalCanvas child is absent.
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
    expect(bridge.listenerCount()).toBe(0);
  });

  it('does not subscribe when bridge is null', () => {
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={null} />);
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
  });

  it('re-allocates a fresh emulator + mirror on each alt-screen enter→exit→re-enter cycle', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;

    // Cycle 1.
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);
    expect(bridge.listenerCount()).toBe(1);
    act(() => {
      bridge.emit({ kind: 'pty_data', sessionId: sid, seq: 0, bytesB64: textToB64('alpha') });
    });
    act(() => {
      useTuiStore.getState().exit();
    });
    expect(bridge.listenerCount()).toBe(0);

    // Cycle 2 — a fresh mirror is built from scratch; the old 'alpha' bytes
    // are gone. The test validates that the subscription count returns to
    // exactly 1 (no leak, no double-subscribe).
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    expect(bridge.listenerCount()).toBe(1);
    act(() => {
      bridge.emit({ kind: 'pty_data', sessionId: sid, seq: 0, bytesB64: textToB64('beta') });
    });
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
  });

  it('does not crash on malformed base64 payloads (decode error is swallowed)', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);
    act(() => {
      bridge.emit({
        kind: 'pty_data',
        sessionId: sid,
        seq: 0,
        // "!!!" is not a valid base64 triplet under strict decoders.
        bytesB64: '!!!',
      });
      // A follow-up valid frame still works — the bad frame did not tear
      // down the subscription or throw.
      bridge.emit({
        kind: 'pty_data',
        sessionId: sid,
        seq: 1,
        bytesB64: textToB64('OK'),
      });
    });
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
    expect(bridge.listenerCount()).toBe(1);
  });

  it('tolerates UTF-8 multibyte characters split across two chunks', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);

    // 한 is `ed 95 9c` — split at byte 2 so the first chunk ends in the
    // middle of a codepoint and the emulator's TextDecoder has to wait.
    const all = new TextEncoder().encode('한글');
    const a = all.slice(0, 2);
    const b = all.slice(2);
    act(() => {
      bridge.emit({ kind: 'pty_data', sessionId: sid, seq: 0, bytesB64: bytesToB64(a) });
      bridge.emit({ kind: 'pty_data', sessionId: sid, seq: 1, bytesB64: bytesToB64(b) });
    });
    // The component is still mounted; a split-UTF-8 feed did not throw.
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
  });

  it('handles rapid-fire chunks without crashing', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);

    act(() => {
      for (let i = 0; i < 500; i += 1) {
        bridge.emit({
          kind: 'pty_data',
          sessionId: sid,
          seq: i,
          bytesB64: textToB64('x'),
        });
      }
    });
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Canvas AT fallback: visually-hidden `<pre>` text mirror.
  // -------------------------------------------------------------------------

  it('mounts a visually-hidden text mirror for assistive tech', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);
    const mirror = screen.getByTestId('tui-at-mirror');
    expect(mirror.tagName.toLowerCase()).toBe('pre');
    expect(mirror.getAttribute('aria-live')).toBe('polite');
    expect(mirror.getAttribute('aria-atomic')).toBe('false');
  });

  it('feeds grid rows into the AT mirror on debounce flush', async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge();
      const sid = 'sess-1' as SessionId;
      act(() => {
        useTuiStore.getState().enter({ sessionId: sid });
      });
      render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);
      // Initial render: the mirror is empty (the emulator just allocated a
      // blank grid).
      const atMirror = screen.getByTestId('tui-at-mirror');
      act(() => {
        bridge.emit({
          kind: 'pty_data',
          sessionId: sid,
          seq: 0,
          bytesB64: textToB64('hello\r\nworld'),
        });
      });
      // The 200 ms debounce hasn't fired yet.
      await act(async () => {
        vi.advanceTimersByTime(205);
        await Promise.resolve();
      });
      const text = atMirror.textContent ?? '';
      expect(text).toContain('hello');
      expect(text).toContain('world');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces high-frequency emits into a single debounced textContent write', async () => {
    vi.useFakeTimers();
    try {
      const bridge = makeBridge();
      const sid = 'sess-1' as SessionId;
      act(() => {
        useTuiStore.getState().enter({ sessionId: sid });
      });
      render(<TuiRenderSurface sessionId={sid} bridge={bridge} />);
      const atMirror = screen.getByTestId('tui-at-mirror');
      // Fire 20 rapid emits within the debounce window.
      act(() => {
        for (let i = 0; i < 20; i += 1) {
          bridge.emit({
            kind: 'pty_data',
            sessionId: sid,
            seq: i,
            bytesB64: textToB64('x'),
          });
        }
      });
      // Not flushed yet — the debounce window is open.
      await act(async () => {
        vi.advanceTimersByTime(100);
        await Promise.resolve();
      });
      await act(async () => {
        vi.advanceTimersByTime(150);
        await Promise.resolve();
      });
      // After the debounce, at least the accumulated text is there.
      const text = atMirror.textContent ?? '';
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('x');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * End-to-end style test: we wire the same VtEmulator + GridMirror plumbing
 * the surface uses, feed it CSI cursor-addressing sequences, and assert the
 * mirror moves the cursor to the expected (row, col). This is the core
 * Option B correctness guarantee: cursor addressing works.
 *
 * We bypass the React surface here because the mirror isn't exposed
 * through props. The identical pipeline runs inside <TuiRenderSurface />;
 * its correctness is proved by VtEmulator + GridMirror unit tests already,
 * and replicated here at the pipeline level to pin the contract.
 */
describe('Grid pipeline (VtEmulator → GridMirror) contract', () => {
  it('CSI H positions the cursor at the target row/col', async () => {
    const { VtEmulator } = await import('../../../shared/lib/vt-emulator/index.js');
    const { GridMirror } = await import('../../../shared/lib/grid-mirror/index.js');
    const { MirrorSource } = await import('../../../shared/ui/cell-renderer/index.js');

    const source = new MirrorSource();
    const mirror = new GridMirror({
      onChange: (d) => source.emit(d),
    });
    const emulator = new VtEmulator({
      sessionId: 'tui-test',
      rows: 24,
      cols: 80,
      onEnvelope: (env) => mirror.apply(env),
    });

    // CUP (CSI 2;1 H) = row 2, col 1 (1-indexed wire → row 1, col 0 zero-indexed).
    const bytes = new TextEncoder().encode('\x1b[2;1HX');
    emulator.feed(bytes);

    // After feeding, the cursor has advanced one column past 'X'.
    const cursor = mirror.getCursor();
    expect(cursor.row).toBe(1);
    expect(cursor.col).toBe(1);
  });

  it('plain text lands at the cursor origin in the grid', async () => {
    const { VtEmulator } = await import('../../../shared/lib/vt-emulator/index.js');
    const { GridMirror } = await import('../../../shared/lib/grid-mirror/index.js');
    const { MirrorSource } = await import('../../../shared/ui/cell-renderer/index.js');

    const source = new MirrorSource();
    const mirror = new GridMirror({ onChange: (d) => source.emit(d) });
    const emulator = new VtEmulator({
      rows: 24,
      cols: 80,
      onEnvelope: (env) => mirror.apply(env),
    });

    emulator.feed(new TextEncoder().encode('hello'));
    const row0 = mirror.getRow(0);
    expect(row0).toBeDefined();
    expect(row0!.cells[0]?.grapheme).toBe('h');
    expect(row0!.cells[1]?.grapheme).toBe('e');
    expect(row0!.cells[2]?.grapheme).toBe('l');
    expect(row0!.cells[3]?.grapheme).toBe('l');
    expect(row0!.cells[4]?.grapheme).toBe('o');
  });
});

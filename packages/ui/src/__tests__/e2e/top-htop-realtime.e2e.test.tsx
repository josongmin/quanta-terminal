/**
 * E2E — top/htop real-time refresh coverage
 *
 * Pins the behavior of high-frequency alt-screen apps (top, htop, watch)
 * that blast rapid pty_data updates while in alt-screen mode. Scenarios:
 *
 *   1. 100-frame pty_data burst — render surface stays mounted, no throws.
 *   2. 'q' keydown mid-burst — bridge.write('q') fires.
 *   3. ArrowDown during rapid updates — emits legacy ESC[B (DECCKM off).
 *   4. Ctrl+C during rapid updates — emits single 0x03 byte.
 *   5. EXIT_1049 after burst — surfaces cleanly unmount.
 *   6. Mouse click in any_event tracking mode — SGR 1006 sequence via
 *      input-host encoder harness (mirrors the htop click-to-highlight path).
 *   7. Re-enter alt-screen after exit — fresh render surface, no residue.
 *
 * pty_data frames are emitted synchronously inside one `act()` batch.
 * In jsdom this collapses all requestAnimationFrame coalescing to one flush;
 * liveness is asserted by the surface remaining mounted after the burst.
 *
 * Covers the gap identified in the CLI-coverage audit: streaming stress
 * tests verify raw GridMirror deltas but do not exercise the full page-level
 * TUI path (TerminalPage → TuiRenderSurface → MemoryBackend) under load.
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

// Same narrow mock set as tui-full-flow.e2e.test.tsx — the alt-screen trio
// (Composer / TuiInputSurface / TuiRenderSurface) is exercised end-to-end.
const { createSessionSpy, getSessionConnectionSpy } = vi.hoisted(() => ({
  createSessionSpy: vi.fn(),
  getSessionConnectionSpy: vi.fn(),
}));

vi.mock('../../widgets/command-palette/index.js', () => ({
  CommandPalette: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="palette" /> : null,
}));
vi.mock('../../widgets/history-search/index.js', () => ({
  HistorySearch: (props: { readonly open: boolean }) =>
    props.open ? <div data-testid="history-search" /> : null,
}));
vi.mock('../../features/session-tabs/index.js', () => ({
  createSession: (...args: unknown[]) => createSessionSpy(...args),
  closeSession: vi.fn(async () => {}),
  switchSession: vi.fn(),
  getSessionConnection: (...args: unknown[]) => getSessionConnectionSpy(...args),
}));
vi.mock('../../entities/block/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../entities/block/index.js')>(
    '../../entities/block/index.js',
  );
  return {
    ...actual,
    createIdbBlockAdapter: () => ({
      async hydrate() {
        return [];
      },
      async saveBlock() {},
      async deleteBlock() {},
    }),
    installBlockPersistence: () => ({ uninstall: () => {} }),
    hydrateFromPersistence: vi.fn(async () => {}),
  };
});
vi.mock('../../features/banner/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/banner/index.js')>(
    '../../features/banner/index.js',
  );
  return { ...actual, installBannerDetectors: () => ({ unsubscribe: () => {} }) };
});
vi.mock('../../features/notifications/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/notifications/index.js')>(
    '../../features/notifications/index.js',
  );
  return { ...actual, installNotificationDetector: () => ({ unsubscribe: () => {} }) };
});
vi.mock('../../features/command/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../features/command/index.js')>(
    '../../features/command/index.js',
  );
  return { ...actual, bindBlockEntity: () => () => {} };
});

import { TerminalPage } from '../../pages/terminal-page/TerminalPage.js';
import { useSessionStore, useSessionsStore } from '../../entities/session/index.js';
import { useBannerStore } from '../../entities/banner/index.js';
import { useTuiStore } from '../../entities/tui/index.js';
import { useBlockStore } from '../../entities/block/index.js';
import {
  __emitRawChunkForTests,
  __resetRawObserversForTests,
} from '../../features/command/route-output.js';
import { setHostBridge } from '../../shared/api/host-bridge.js';

// Input-host encoder harness (mouse tracking in any_event mode).
import { Focus } from '../../features/input/Focus.js';
import { KeyEncoder } from '../../features/input/KeyEncoder.js';
import { MouseEncoder } from '../../features/input/MouseEncoder.js';
import { Paste } from '../../features/input/Paste.js';
import { createStubMirror, ModeSnapshot } from '../../features/input/ModeSnapshot.js';
import { mount as mountInputHost } from '../../features/input/input-host.js';

const ESC = 0x1b;
const ENTER_1049 = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]);
const EXIT_1049 = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c]);

const SESSION_ID = '01J00000000000000000000001' as SessionId;

interface FakeBridge extends HostBridge {
  readonly emit: (event: HostEvent) => void;
  readonly write: ReturnType<typeof vi.fn>;
}

function makeBridge(): FakeBridge {
  const listeners = new Set<HostEventListener>();
  const write = vi.fn().mockResolvedValue(undefined);
  const bridge = {
    capabilities: DEFAULT_CAPABILITIES,
    write,
    async ready() {},
    async spawn() {
      return { sessionId: SESSION_ID, shell: '/bin/sh', cwd: '/tmp' };
    },
    async resize() {},
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
        command: 'top',
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    emit: (event: HostEvent) => {
      for (const l of listeners) l(event);
    },
  } satisfies FakeBridge;
  return bridge;
}

function textToB64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function seedActiveSession(): void {
  useSessionStore.getState().setSession({
    id: SESSION_ID,
    shell: '/bin/zsh',
    cwd: '/tmp',
    health: 'ready',
  });
  useSessionsStore.getState().addSession({
    id: SESSION_ID,
    shell: '/bin/zsh',
    cwd: '/tmp',
    health: 'ready',
  });
  useSessionsStore.getState().setActive(SESSION_ID);
}

async function renderPage(): Promise<void> {
  await act(async () => {
    render(<TerminalPage />);
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Emit N rapid pty_data frames inside one act batch (top's 1 Hz refresh). */
function emitFrameBurst(n: number): void {
  for (let i = 0; i < n; i += 1) {
    bridge.emit({
      kind: 'pty_data',
      sessionId: SESSION_ID,
      seq: i,
      // Simulate top: home cursor + clear screen + a status line
      bytesB64: textToB64(
        `\x1b[H\x1b[2J top - 12:00:${String(i % 60).padStart(2, '0')} up 1 day`,
      ),
    });
  }
}

let bridge: FakeBridge;

beforeEach(() => {
  bridge = makeBridge();
  setHostBridge(bridge);
  (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__ = 'memory';

  createSessionSpy.mockReset();
  createSessionSpy.mockImplementation(async () => ({
    sessionId: SESSION_ID,
    connection: {
      sessionId: SESSION_ID,
      async write() {},
      async close() {},
      async resize() {},
      async cancelBlock() {},
    },
  }));
  getSessionConnectionSpy.mockReset();
  getSessionConnectionSpy.mockReturnValue(undefined);

  __resetRawObserversForTests();
  useSessionStore.getState().reset();
  useSessionsStore.getState().reset();
  useBannerStore.getState().resetAll();
  useTuiStore.getState().reset();
  useBlockStore.getState().resetAll();
});

afterEach(() => {
  cleanup();
  __resetRawObserversForTests();
  useTuiStore.getState().reset();
  useSessionStore.getState().reset();
  useSessionsStore.getState().reset();
  useBannerStore.getState().resetAll();
  useBlockStore.getState().resetAll();
  delete (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__;
});

describe('top/htop real-time refresh (e2e)', () => {
  it('100-frame pty_data burst during alt-screen does not crash the render surface', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();

    act(() => {
      emitFrameBurst(100);
    });

    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
    expect(useTuiStore.getState().active).toBe(true);
  });

  it('"q" keydown mid-burst routes to bridge.write("q")', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });

    const bytesOut: string[] = [];
    bridge.write.mockImplementation(async (_sid: SessionId, data: string) => {
      bytesOut.push(data);
    });

    act(() => {
      emitFrameBurst(20);
      const surface = screen.getByTestId('tui-input-surface');
      surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bytesOut).toContain('q');
  });

  it('ArrowDown during rapid updates emits legacy ESC[B (DECCKM off by default)', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });

    const bytesOut: string[] = [];
    bridge.write.mockImplementation(async (_sid: SessionId, data: string) => {
      bytesOut.push(data);
    });

    act(() => {
      emitFrameBurst(15);
      const surface = screen.getByTestId('tui-input-surface');
      surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bytesOut.length).toBeGreaterThanOrEqual(1);
    expect(bytesOut[bytesOut.length - 1]).toBe('\x1b[B');
  });

  it('Ctrl+C during rapid updates emits a single 0x03 byte', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });

    const bytesOut: string[] = [];
    bridge.write.mockImplementation(async (_sid: SessionId, data: string) => {
      bytesOut.push(data);
    });

    act(() => {
      emitFrameBurst(50);
      const surface = screen.getByTestId('tui-input-surface');
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(bytesOut).toContain('\x03');
  });

  it('EXIT_1049 after burst cleanly unmounts both surfaces', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });
    act(() => {
      emitFrameBurst(60);
    });

    act(() => {
      __emitRawChunkForTests(EXIT_1049);
    });

    expect(screen.queryByTestId('tui-render-surface')).toBeNull();
    expect(screen.queryByTestId('tui-input-surface')).toBeNull();
    expect(useTuiStore.getState().active).toBe(false);
    expect(useTuiStore.getState().depth).toBe(0);
  });

  it('re-enter after exit starts a fresh render surface (no burst residue)', async () => {
    seedActiveSession();
    await renderPage();

    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });
    act(() => {
      emitFrameBurst(30);
    });
    act(() => {
      __emitRawChunkForTests(EXIT_1049);
    });
    expect(screen.queryByTestId('tui-render-surface')).toBeNull();

    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });

    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
    expect(useTuiStore.getState().active).toBe(true);

    // Fresh burst accepted without errors.
    act(() => {
      emitFrameBurst(10);
    });
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
  });

  it('mouse any_event click in input-host harness emits SGR 1006 press sequence', () => {
    // Separate encoder-level harness — mirrors the htop click-to-highlight
    // path where the TUI app enables DECSET 1003 (any_event) + SGR 1006
    // before it starts painting.
    const mirror = createStubMirror({
      mouseTracking: 'any_event',
      mouseEncoding: 'sgr',
    });
    const modeSnapshot = new ModeSnapshot(mirror);
    const keyEncoder = new KeyEncoder({ modeSnapshot });
    const mouseEncoder = new MouseEncoder({ modeSnapshot });
    const paste = new Paste({ modeSnapshot });
    const focus = new Focus({ modeSnapshot });

    const bytesOut: Uint8Array[] = [];
    const container = document.createElement('div');
    container.setAttribute('tabindex', '0');
    document.body.appendChild(container);

    container.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 200,
      right: 200,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const handle = mountInputHost(container, {
      keyEncoder,
      mouseEncoder,
      paste,
      focus,
      platform: 'linux',
      screenToCell: (cx, cy) => ({
        xCell: Math.floor(cx / 10),
        yCell: Math.floor(cy / 20),
      }),
      onBytesOut: (b) => bytesOut.push(b),
    });

    // Click at cell (3, 2) — clientX=30 (col 3), clientY=40 (row 2).
    // input-host listens to pointerdown, not mousedown.
    const PtrCtor: typeof MouseEvent =
      (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
    container.dispatchEvent(
      new PtrCtor('pointerdown', { clientX: 30, clientY: 40, button: 0, bubbles: true }),
    );

    handle.unmount();
    container.remove();

    const total = bytesOut.reduce((n, b) => n + b.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const b of bytesOut) {
      all.set(b, off);
      off += b.length;
    }
    const str = new TextDecoder().decode(all);

    // ESC [ < Cb ; Col ; Row M — button 0, 1-based col=4, 1-based row=3.
    expect(str).toBe('\x1b[<0;4;3M');
  });
});

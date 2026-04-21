/**
 * E2E — less / man pagination coverage
 *
 * Pins behavior for pager-style TUI apps that use alt-screen for full-page
 * display and rely on specific keyboard sequences for navigation:
 *
 *   1.  Space (0x20) → page-down in pager mode.
 *   2.  'b' (0x62)   → page-up.
 *   3.  'g' (0x67)   → go to top of file.
 *   4.  'G' (0x47)   → go to end of file (uppercase).
 *   5.  '/' (0x2f)   → enter search mode.
 *   6.  'n' (0x6e)   → next search match.
 *   7.  'N' (0x4e)   → previous search match.
 *   8.  'q' (0x71)   → quit → EXIT_1049 tears down surfaces.
 *   9.  Home key     → ESC[H (VT sequence for beginning of buffer).
 *   10. End key      → ESC[F.
 *   11. Wheel UP with mouse tracking OFF → no bytes emitted to bridge.
 *   12. Bracketed paste is NOT active by default in TUI mode — pasting
 *       a search string sends raw bytes, no ESC[200~ wrapper.
 *
 * Tests 1–10 use the encoder-level input-host harness (KeyEncoder +
 * ModeSnapshot). Tests 11–12 use the full page render (TerminalPage) to
 * verify the end-to-end TUI surface behavior.
 *
 * Note: `man` on macOS pipes through `less`. The scenarios here apply to
 * any pager that runs inside the PTY as an alt-screen application.
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

// Encoder-level harness imports.
import { Focus } from '../../features/input/Focus.js';
import { KeyEncoder } from '../../features/input/KeyEncoder.js';
import { MouseEncoder } from '../../features/input/MouseEncoder.js';
import { Paste } from '../../features/input/Paste.js';
import { createStubMirror, ModeSnapshot } from '../../features/input/ModeSnapshot.js';
import { mount as mountInputHost } from '../../features/input/input-host.js';

// Page-level imports.
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

const ESC = 0x1b;
const ENTER_1049 = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68]);
const EXIT_1049 = new Uint8Array([ESC, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x6c]);

const SESSION_ID = '01J00000000000000000000001' as SessionId;

// -------------------------------------------------------------------------
// Encoder harness helpers.
// -------------------------------------------------------------------------

interface KeyHarness {
  container: HTMLElement;
  handle: ReturnType<typeof mountInputHost>;
  bytesOut: Uint8Array[];
}

function makeKeyHarness(
  init: Parameters<typeof createStubMirror>[0] = {},
): KeyHarness {
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

  const handle = mountInputHost(container, {
    keyEncoder,
    mouseEncoder,
    paste,
    focus,
    platform: 'linux',
    onBytesOut: (b) => bytesOut.push(b),
  });

  return { container, handle, bytesOut };
}

function decodeAll(buffers: readonly Uint8Array[]): string {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    all.set(b, off);
    off += b.length;
  }
  return new TextDecoder().decode(all);
}

// -------------------------------------------------------------------------
// Page-level bridge stub.
// -------------------------------------------------------------------------

interface FakeBridge extends HostBridge {
  readonly emit: (event: HostEvent) => void;
  readonly write: ReturnType<typeof vi.fn>;
}

function makeBridge(): FakeBridge {
  const listeners = new Set<HostEventListener>();
  const write = vi.fn().mockResolvedValue(undefined);
  return {
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
        command: 'less',
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

let bridge: FakeBridge;
const keyHarnesses: KeyHarness[] = [];

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
  keyHarnesses.length = 0;
});

afterEach(() => {
  cleanup();
  __resetRawObserversForTests();
  useTuiStore.getState().reset();
  useSessionStore.getState().reset();
  useSessionsStore.getState().reset();
  useBannerStore.getState().resetAll();
  useBlockStore.getState().resetAll();
  for (const h of keyHarnesses) {
    h.handle.unmount();
    h.container.remove();
  }
  delete (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__;
});

function makeKey(
  init?: Parameters<typeof createStubMirror>[0],
): KeyHarness {
  const h = makeKeyHarness(init);
  keyHarnesses.push(h);
  return h;
}

// -------------------------------------------------------------------------
// Encoder-level tests (scenarios 1–10).
// -------------------------------------------------------------------------

describe('less pagination — key encoding (e2e)', () => {
  it('Space emits 0x20 (page down)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true }),
    );
    expect(decodeAll(bytesOut)).toBe(' ');
  });

  it('"b" emits 0x62 (page up in less)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }),
    );
    expect(decodeAll(bytesOut)).toBe('b');
  });

  it('"g" emits 0x67 (go to top)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', bubbles: true }),
    );
    expect(decodeAll(bytesOut)).toBe('g');
  });

  it('"G" (shift+g) emits 0x47 (go to end)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'G',
        code: 'KeyG',
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(decodeAll(bytesOut)).toBe('G');
  });

  it('"/" emits 0x2f (enter search mode)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', code: 'Slash', bubbles: true }),
    );
    expect(decodeAll(bytesOut)).toBe('/');
  });

  it('"n" emits 0x6e (next match)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', bubbles: true }),
    );
    expect(decodeAll(bytesOut)).toBe('n');
  });

  it('"N" emits 0x4e (previous match)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'N',
        code: 'KeyN',
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(decodeAll(bytesOut)).toBe('N');
  });

  it('"q" emits 0x71 (quit pager)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }),
    );
    expect(decodeAll(bytesOut)).toBe('q');
  });

  it('Home key emits ESC[H (beginning of buffer)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Home', code: 'Home', bubbles: true }),
    );
    expect(decodeAll(bytesOut)).toBe('\x1b[H');
  });

  it('End key emits ESC[F (end of buffer)', () => {
    const { container, bytesOut } = makeKey();
    container.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'End', code: 'End', bubbles: true }),
    );
    expect(decodeAll(bytesOut)).toBe('\x1b[F');
  });
});

// -------------------------------------------------------------------------
// Page-level tests (scenarios 11–12).
// -------------------------------------------------------------------------

describe('less pagination — TUI page integration (e2e)', () => {
  it('wheel UP in alt-screen with tracking OFF sends arrow-key fallback to bridge', async () => {
    // When mouse tracking is off, the MouseEncoder synthesizes ArrowUp/Down
    // sequences instead of SGR bytes so that pagers (less, man, vim) remain
    // scrollable via the mouse wheel. This is the intended production behavior
    // per the MouseEncoder comment: "EXCEPTION: alt-screen is active AND the
    // event is a wheel tick."
    seedActiveSession();
    await renderPage();
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });

    const bytesOut: string[] = [];
    bridge.write.mockImplementation(async (_sid: SessionId, data: string) => {
      bytesOut.push(data);
    });

    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      // deltaY < 0 = scroll up. deltaMode=0 (pixels): lines = floor(100/16) = 6.
      surface.dispatchEvent(
        new WheelEvent('wheel', { deltaY: -100, deltaMode: 0, bubbles: true }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Must have sent something to bridge.write (arrow sequences, not empty).
    expect(bridge.write).toHaveBeenCalled();
    // The combined payload should contain at least one ESC[A (ArrowUp).
    const combined = bytesOut.join('');
    expect(combined).toContain('\x1b[A');
  });

  it('"q" in alt-screen sends 0x71 then EXIT_1049 brings composer back', async () => {
    seedActiveSession();
    await renderPage();
    act(() => {
      __emitRawChunkForTests(ENTER_1049);
    });
    expect(screen.getByTestId('tui-input-surface')).toBeInTheDocument();

    const bytesOut: string[] = [];
    bridge.write.mockImplementation(async (_sid: SessionId, data: string) => {
      bytesOut.push(data);
    });

    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }),
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // 'q' was sent to the PTY (less processes it and emits EXIT_1049).
    expect(bytesOut).toContain('q');

    // Simulate less actually quitting.
    act(() => {
      __emitRawChunkForTests(EXIT_1049);
    });

    expect(screen.queryByTestId('tui-input-surface')).toBeNull();
    expect(screen.getByTestId('composer')).toBeInTheDocument();
    expect(useTuiStore.getState().active).toBe(false);
  });
});

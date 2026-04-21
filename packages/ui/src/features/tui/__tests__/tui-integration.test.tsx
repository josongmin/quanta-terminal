/**
 * TUI integration tests.
 *
 * These tests exercise the interaction between:
 *   - `TuiRenderSurface` (alt-screen output painter)
 *   - `TuiInputSurface` (alt-screen-gated PTY input sink)
 *   - `Composer` (main-screen textarea)
 *
 * Scope is intentionally limited to what jsdom can faithfully reproduce: the
 * component tree + store transitions + DOM event dispatch. Full page-level
 * concerns (BlockList scroll, TitleBar layout, banner timing) stay in the
 * page-level test suite (`pages/terminal-page/__tests__/`). Everything here
 * pins behaviors that would silently break if someone edits one of the three
 * collaborators without the other two.
 */

import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';

import { TuiInputSurface } from '../TuiInputSurface.js';
import { TuiRenderSurface } from '../TuiRenderSurface.js';
import { Composer } from '../../../widgets/composer/Composer.js';
import { useTuiStore } from '../../../entities/tui/index.js';
import { useSessionStore } from '../../../entities/session/index.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';

interface FakeBridge extends HostBridge {
  emit(event: HostEvent): void;
  listenerCount(): number;
  readonly writes: Array<{ readonly sessionId: SessionId; readonly data: string }>;
}

function makeBridge(): FakeBridge {
  const listeners = new Set<HostEventListener>();
  const writes: FakeBridge['writes'] = [];
  const bridge: FakeBridge = {
    capabilities: DEFAULT_CAPABILITIES,
    writes,
    async ready() {},
    async spawn() {
      return { sessionId: 'sess-stub' as SessionId, shell: '/bin/sh', cwd: '/' };
    },
    async write(sessionId: SessionId, data: string) {
      writes.push({ sessionId, data });
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

/**
 * Shared harness: renders Composer + both TUI surfaces inside a single host
 * tree. The real TerminalPage wraps these in a flex layout with CSS classes
 * that hide the Composer during alt-screen; here we just keep all three in
 * the tree (matching the page-level invariant that the React subtree stays
 * intact across alt-screen transitions — only CSS visibility flips).
 */
function TuiHarness(props: { readonly sessionId: SessionId; readonly bridge: FakeBridge }) {
  return (
    <>
      <TuiRenderSurface sessionId={props.sessionId} bridge={props.bridge} />
      <TuiInputSurface sessionId={props.sessionId} bridge={props.bridge} />
      <Composer />
    </>
  );
}

beforeEach(() => {
  useTuiStore.getState().reset();
  useSessionStore.getState().reset();
  useSessionStore.getState().setSession({ id: 'sess-1' as SessionId });
  // TuiRenderSurface uses Canvas2D by default; jsdom returns null from
  // `getContext('2d')` and `Canvas2DBackend.mount()` crashes. Force the
  // in-memory backend for the duration of these tests.
  (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__ = 'memory';
});

afterEach(() => {
  cleanup();
  useTuiStore.getState().reset();
  useSessionStore.getState().reset();
  delete (window as unknown as { __quantaTuiBackend__?: string }).__quantaTuiBackend__;
  vi.restoreAllMocks();
});

describe('TUI surfaces ↔ Composer integration', () => {
  it('Composer value survives an alt-screen enter → exit round trip (React tree stays intact)', async () => {
    const bridge = makeBridge();
    setHostBridge(bridge);
    const sid = 'sess-1' as SessionId;
    render(<TuiHarness sessionId={sid} bridge={bridge} />);

    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'echo hello');
    expect(input.value).toBe('echo hello');
    // Settle focus state before the surface's auto-focus useEffect causes a
    // native blur on the textarea.
    await act(async () => {
      input.blur();
      await Promise.resolve();
    });

    // Enter alt-screen: the surfaces appear, but the Composer textarea stays
    // in the DOM (the page-level CSS display:none rule is layout-only — the
    // React state is preserved).
    await act(async () => {
      useTuiStore.getState().enter({ sessionId: sid });
      await Promise.resolve();
    });
    expect(screen.getByTestId('tui-input-surface')).toBeInTheDocument();
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
    // Composer is still mounted; the value in its textarea is unchanged.
    expect(input.value).toBe('echo hello');
    expect(input.isConnected).toBe(true);

    // Exit alt-screen: surfaces unmount, Composer remains with its value.
    await act(async () => {
      useTuiStore.getState().exit();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('tui-input-surface')).toBeNull();
    expect(screen.queryByTestId('tui-render-surface')).toBeNull();
    const inputAfter = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    expect(inputAfter.value).toBe('echo hello');
  });

  it('keystrokes while alt-screen is active route to the TUI surface (PTY bytes), not the Composer submit path', async () => {
    const bridge = makeBridge();
    setHostBridge(bridge);
    const sid = 'sess-1' as SessionId;
    render(<TuiHarness sessionId={sid} bridge={bridge} />);

    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'foo');
    // User typed into Composer; no PTY writes yet (Composer buffers until
    // Enter).
    expect(bridge.writes.length).toBe(0);

    // Explicit blur before entering alt-screen so the composer's focus state
    // settles inside an act() scope. Otherwise the TuiInputSurface's auto-
    // focus useEffect would trigger a native blur on the textarea from
    // inside jsdom's sync focus/blur cycle, and Composer's `setFocused(false)`
    // state-update ends up outside the act wrapper.
    await act(async () => {
      input.blur();
      await Promise.resolve();
    });

    // Enter alt-screen — the TuiInputSurface now owns keystroke routing.
    await act(async () => {
      useTuiStore.getState().enter({ sessionId: sid });
      await Promise.resolve();
    });
    const surface = screen.getByTestId('tui-input-surface');
    await act(async () => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    // A keystroke on the TuiInputSurface IS a PTY byte write.
    expect(bridge.writes.length).toBeGreaterThanOrEqual(1);
    expect(bridge.writes.at(-1)!.data).toBe('q');
    // Composer value is still 'foo' — alt-screen did not clear it.
    expect(input.value).toBe('foo');
  });

  it('during alt-screen active, pty_data flows through the render surface bridge subscription and the Composer does not receive it', async () => {
    const bridge = makeBridge();
    setHostBridge(bridge);
    const sid = 'sess-1' as SessionId;
    render(<TuiHarness sessionId={sid} bridge={bridge} />);

    // Before enter: the render surface is unmounted so its subscriber hasn't
    // registered yet. Input surface is also gated on active.
    const baselineListeners = bridge.listenerCount();

    await act(async () => {
      useTuiStore.getState().enter({ sessionId: sid });
      await Promise.resolve();
    });

    // After enter: both the TuiInputSurface (for its own observation) and
    // the TuiRenderSurface subscribe. We just need the render-surface
    // subscription to exist, which grew the listener count by at least 1.
    expect(bridge.listenerCount()).toBeGreaterThan(baselineListeners);

    await act(async () => {
      bridge.emit({
        kind: 'pty_data',
        sessionId: sid,
        seq: 0,
        bytesB64: textToB64('TUI-PAINT'),
      });
      await Promise.resolve();
    });
    // The render surface is mounted; the grid pipeline consumed the bytes
    // without throwing. (Deep cell-content assertions live in the VtEmulator
    // and GridMirror unit tests; here we only prove routing.)
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    expect(input.value).not.toContain('TUI-PAINT');
  });

  it('alt-screen enter grabs focus away from the Composer (TuiInputSurface auto-focuses)', async () => {
    const bridge = makeBridge();
    setHostBridge(bridge);
    const sid = 'sess-1' as SessionId;
    render(<TuiHarness sessionId={sid} bridge={bridge} />);

    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await act(async () => {
      input.focus();
    });
    expect(document.activeElement).toBe(input);

    await act(async () => {
      useTuiStore.getState().enter({ sessionId: sid });
      await Promise.resolve();
    });
    // TuiInputSurface.useEffect fires .focus() on the container when active
    // flips true. The textarea no longer holds focus.
    const tuiSurface = screen.getByTestId('tui-input-surface') as HTMLDivElement;
    expect(document.activeElement).toBe(tuiSurface);
  });

  it('rapid enter → pty_data → exit cycle delivers bytes only during the active window', async () => {
    const bridge = makeBridge();
    setHostBridge(bridge);
    const sid = 'sess-1' as SessionId;
    render(<TuiHarness sessionId={sid} bridge={bridge} />);

    // Inactive: pty_data is not painted because no render surface is mounted.
    await act(async () => {
      bridge.emit({
        kind: 'pty_data',
        sessionId: sid,
        seq: 0,
        bytesB64: textToB64('BEFORE'),
      });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('tui-render-surface')).toBeNull();

    // Active: subscribe, paint.
    await act(async () => {
      useTuiStore.getState().enter({ sessionId: sid });
      await Promise.resolve();
    });
    await act(async () => {
      bridge.emit({
        kind: 'pty_data',
        sessionId: sid,
        seq: 1,
        bytesB64: textToB64('DURING'),
      });
      await Promise.resolve();
    });
    // The render surface is mounted and listening; it consumed the bytes
    // via its grid pipeline. We assert at the subscription level instead of
    // looking at `.textContent` because the grid is painted to a canvas, not
    // to text nodes.
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();

    // Exit: unsubscribe. Bytes after exit should not reach any surface.
    const listenersBeforeExit = bridge.listenerCount();
    await act(async () => {
      useTuiStore.getState().exit();
      await Promise.resolve();
    });
    await act(async () => {
      bridge.emit({
        kind: 'pty_data',
        sessionId: sid,
        seq: 2,
        bytesB64: textToB64('AFTER'),
      });
      await Promise.resolve();
    });
    expect(screen.queryByTestId('tui-render-surface')).toBeNull();
    expect(bridge.listenerCount()).toBeLessThan(listenersBeforeExit);

    // A fresh enter allocates a new emulator + mirror — nothing about the
    // previous cycle's bytes persists.
    await act(async () => {
      useTuiStore.getState().enter({ sessionId: sid });
      await Promise.resolve();
    });
    expect(screen.getByTestId('tui-render-surface')).toBeInTheDocument();
  });

  it('Ctrl+C on the TuiInputSurface reaches the PTY even though the Composer is a sibling in the tree', async () => {
    const bridge = makeBridge();
    setHostBridge(bridge);
    const sid = 'sess-1' as SessionId;
    render(<TuiHarness sessionId={sid} bridge={bridge} />);

    // Without alt-screen Ctrl+C would be handled by the textarea's default
    // behavior (copy) — nothing hits the bridge.
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await act(async () => {
      input.focus();
      fireEvent.keyDown(input, { key: 'c', code: 'KeyC', ctrlKey: true });
    });
    expect(bridge.writes.length).toBe(0);

    // With alt-screen active the TuiInputSurface owns keystroke routing and
    // Ctrl+C becomes SIGINT (0x03) on the wire.
    await act(async () => {
      useTuiStore.getState().enter({ sessionId: sid });
      await Promise.resolve();
    });
    const surface = screen.getByTestId('tui-input-surface');
    await act(async () => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          ctrlKey: true,
          bubbles: true,
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(bridge.writes.length).toBeGreaterThanOrEqual(1);
    expect(bridge.writes.at(-1)!.data.charCodeAt(0)).toBe(0x03);
  });

  it('IME composition on the TuiInputSurface commits bytes without touching the Composer', async () => {
    const bridge = makeBridge();
    setHostBridge(bridge);
    const sid = 'sess-1' as SessionId;
    render(<TuiHarness sessionId={sid} bridge={bridge} />);

    // Seed Composer with something we do NOT want to mutate.
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'stay-put');
    // Settle the composer's focus state inside an act() before the surface
    // auto-focus steals it — see comment on the earlier test.
    await act(async () => {
      input.blur();
      await Promise.resolve();
    });

    await act(async () => {
      useTuiStore.getState().enter({ sessionId: sid });
      await Promise.resolve();
    });
    const surface = screen.getByTestId('tui-input-surface');
    await act(async () => {
      surface.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      surface.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
      surface.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
      await Promise.resolve();
      await Promise.resolve();
    });

    // IME commit went to the PTY.
    expect(bridge.writes.at(-1)!.data).toBe('한');
    // Composer textarea is unchanged — the composition happened on a
    // different DOM node entirely.
    expect(input.value).toBe('stay-put');
  });
});

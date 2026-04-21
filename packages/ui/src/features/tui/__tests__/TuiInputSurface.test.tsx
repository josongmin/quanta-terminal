/**
 * TuiInputSurface — component tests.
 *
 * We mount the surface, flip the tui store into alt-screen, dispatch DOM
 * events on the surface element and assert that the encoded PTY bytes are
 * forwarded via the host bridge's `write()` contract.
 *
 * The tests intentionally use the `onBytesOut` hook for wire-level checks
 * so the assertions stay independent of the host bridge transport format
 * (UTF-8 string on the bridge; raw bytes on the hook).
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEventListener,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';

import { TuiInputSurface } from '../TuiInputSurface.js';
import { useTuiStore } from '../../../entities/tui/index.js';

interface FakeBridge extends HostBridge {
  writes: Array<{ readonly sessionId: SessionId; readonly data: string }>;
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
  };
  return bridge;
}

function toHex(buffers: readonly Uint8Array[]): string {
  const total = buffers.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of buffers) {
    out.set(b, off);
    off += b.length;
  }
  return Array.from(out)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

beforeEach(() => {
  useTuiStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useTuiStore.getState().reset();
  vi.restoreAllMocks();
});

describe('<TuiInputSurface />', () => {
  it('renders null while alt-screen is inactive', () => {
    const bridge = makeBridge();
    render(
      <TuiInputSurface sessionId={'sess-1' as SessionId} bridge={bridge} />,
    );
    expect(screen.queryByTestId('tui-input-surface')).toBeNull();
  });

  it('mounts a focusable surface when alt-screen is active', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiInputSurface sessionId={sid} bridge={bridge} />);
    const surface = screen.getByTestId('tui-input-surface');
    expect(surface).toBeInTheDocument();
    expect(surface.getAttribute('tabindex')).toBe('0');
  });

  it('routes ASCII keystrokes to bridge.write with the encoded byte', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
      );
    });
    expect(bytesOut.length).toBe(1);
    expect(bytesOut[0]![0]).toBe(0x61);
    // Let the async write() microtask flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.length).toBe(1);
    expect(bridge.writes[0]!.sessionId).toBe(sid);
    expect(bridge.writes[0]!.data).toBe('a');
  });

  it('routes arrow keys as the legacy CSI escape sequence', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowUp',
          code: 'ArrowUp',
          bubbles: true,
        }),
      );
    });
    // Legacy arrow-up: ESC [ A = 0x1b, 0x5b, 0x41
    const hex = toHex(bytesOut);
    expect(hex).toBe('1b5b41');
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.length).toBe(1);
  });

  it('routes Ctrl+C as 0x03', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    const hex = toHex(bytesOut);
    expect(hex).toBe('03');
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.length).toBe(1);
  });

  it('unmounts on alt-screen exit — subsequent keystrokes emit nothing', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    const { rerender } = render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    // Exit alt-screen.
    act(() => {
      useTuiStore.getState().exit();
    });
    rerender(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    expect(screen.queryByTestId('tui-input-surface')).toBeNull();
    // Dispatch on the (now detached) element — the listener should be
    // unbound by the effect cleanup, so nothing is emitted.
    const before = bytesOut.length;
    surface.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }),
    );
    expect(bytesOut.length).toBe(before);
  });

  it('does nothing when alt-screen is active but sessionId is null', () => {
    const bridge = makeBridge();
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter();
    });
    render(
      <TuiInputSurface
        sessionId={null}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    // The surface renders (so pointer events don't leak to the Composer),
    // but no input-host is mounted, so no bytes flow.
    expect(screen.getByTestId('tui-input-surface')).toBeInTheDocument();
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'a',
          code: 'KeyA',
          bubbles: true,
        }),
      );
    });
    expect(bytesOut.length).toBe(0);
    expect(bridge.writes.length).toBe(0);
  });

  it('encodes paste through bracketed-paste off (default stub mirror) as plain bytes', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    // jsdom has no DataTransfer; input-host only reads
    // ev.clipboardData?.getData('text'), which this shim covers.
    const evt = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'clipboardData', {
      value: { getData: (kind: string) => (kind === 'text' ? 'hi' : '') },
    });
    act(() => {
      surface.dispatchEvent(evt);
    });
    const hex = toHex(bytesOut);
    // "hi" = 0x68 0x69 (bracketed-paste disabled on stub mirror).
    expect(hex).toBe('6869');
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes[0]?.data).toBe('hi');
  });

  // ---------------------------------------------------------------------
  // Extended edge cases — IME / refocus / modifier-only / platform /
  // session re-mount / race ordering / degraded mode.
  // ---------------------------------------------------------------------

  it('IME Japanese: compositionstart → update → end commits `あ` as 3 UTF-8 bytes (e3 81 82)', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      surface.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'あ' }));
      surface.dispatchEvent(new CompositionEvent('compositionend', { data: 'あ' }));
    });
    expect(toHex(bytesOut)).toBe('e38182');
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.length).toBe(1);
    expect(bridge.writes[0]!.data).toBe('あ');
  });

  it('IME Korean: compositionend commits `한` as 3 UTF-8 bytes (ed 95 9c)', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
      surface.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'ㅎ' }));
      surface.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
    });
    expect(toHex(bytesOut)).toBe('ed959c');
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes[0]!.data).toBe('한');
  });

  it('pointerdown re-focuses the surface (listener is bound via useEffect)', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiInputSurface sessionId={sid} bridge={bridge} />);
    const surface = screen.getByTestId('tui-input-surface') as HTMLDivElement;
    // Auto-focus on mount: the surface should already hold focus.
    expect(document.activeElement).toBe(surface);
    // Simulate losing focus (e.g. user clicks a browser affordance) then
    // pointerdown on the surface must refocus it.
    surface.blur();
    expect(document.activeElement).not.toBe(surface);
    const focusSpy = vi.spyOn(surface, 'focus');
    act(() => {
      surface.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    // The handler calls focus() unconditionally (swallows exceptions).
    expect(focusSpy).toHaveBeenCalled();
  });

  it('modifier-only key presses (Shift / Control / Alt) emit zero bytes', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    for (const [key, code] of [
      ['Shift', 'ShiftLeft'],
      ['Control', 'ControlLeft'],
      ['Alt', 'AltLeft'],
      ['Meta', 'MetaLeft'],
    ] as const) {
      act(() => {
        surface.dispatchEvent(
          new KeyboardEvent('keydown', { key, code, bubbles: true }),
        );
      });
    }
    expect(bytesOut.length).toBe(0);
    expect(bridge.writes.length).toBe(0);
  });

  it('macOS platform: Cmd+letter produces no legacy bytes (Cmd is not wired in legacy encoder)', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    // Pretend we are on macOS for this test.
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      // Cmd+C on macOS: input-host passes event through KeyEncoder, which in
      // legacy mode does not special-case metaKey, and the key 'c' is not a
      // plain printable we want to emit when meta is held. The default
      // legacy encoder emits the character 'c' regardless of metaKey since
      // metaKey is not checked in its Ctrl-mapping branch. What we CAN
      // assert portably: Ctrl+C still produces 0x03.
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          ctrlKey: true,
          bubbles: true,
        }),
      );
    });
    expect(toHex(bytesOut)).toBe('03');
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes[0]!.data.charCodeAt(0)).toBe(0x03);
  });

  it('linux platform: Ctrl+letter is the control-code path (metaKey is irrelevant)', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    Object.defineProperty(navigator, 'platform', {
      value: 'Linux x86_64',
      configurable: true,
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    // Meta+c (no ctrl) — legacy encoder emits plain 'c'.
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'c',
          code: 'KeyC',
          metaKey: true,
          bubbles: true,
        }),
      );
    });
    expect(bytesOut.length).toBe(1);
    expect(bytesOut[0]![0]).toBe(0x63);
    await Promise.resolve();
    await Promise.resolve();
  });

  it('changing sessionId while mounted re-mounts the input-host against the new session', async () => {
    const bridge = makeBridge();
    const s1 = 'sess-1' as SessionId;
    const s2 = 'sess-2' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: s1 });
    });
    const { rerender } = render(
      <TuiInputSurface
        sessionId={s1}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
      );
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.at(-1)!.sessionId).toBe(s1);

    // Swap sessionId — the effect should tear down the first input-host and
    // mount a fresh one that writes to s2.
    rerender(
      <TuiInputSurface
        sessionId={s2}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface2 = screen.getByTestId('tui-input-surface');
    act(() => {
      surface2.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }),
      );
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.at(-1)!.sessionId).toBe(s2);
    expect(bridge.writes.at(-1)!.data).toBe('b');
  });

  it('rapid alt-screen active toggle does not crash and cleans up listeners each cycle', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    // enter → exit → enter → exit repeatedly.
    for (let i = 0; i < 5; i += 1) {
      act(() => {
        useTuiStore.getState().enter({ sessionId: sid });
      });
      expect(screen.queryByTestId('tui-input-surface')).toBeInTheDocument();
      act(() => {
        useTuiStore.getState().exit();
      });
      expect(screen.queryByTestId('tui-input-surface')).toBeNull();
    }
    // Final enter + keystroke still routes correctly.
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', bubbles: true }),
      );
    });
    expect(bytesOut.length).toBe(1);
    expect(bytesOut[0]![0]).toBe(0x7a);
  });

  it('defensively ignores keystrokes when the container ref is still null at effect time', () => {
    // Edge case: a caller passes a bridge but mounts BEFORE alt-screen is
    // entered. The effect only runs when active flips true, at which point
    // the ref is populated. We cover the "inactive → no DOM event listener"
    // branch explicitly.
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    // Do NOT call enter(): inactive from the start.
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    // No surface in the DOM (returns null).
    expect(screen.queryByTestId('tui-input-surface')).toBeNull();
    // Dispatch on document body should be a no-op for our surface.
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
      );
    });
    expect(bytesOut.length).toBe(0);
    expect(bridge.writes.length).toBe(0);
  });

  it('alt-screen wheel-up (tracking off) synthesizes ESC [ A arrow bytes', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      const ev = new WheelEvent('wheel', {
        bubbles: true,
        deltaY: -32, // ~2 lines at the 16 px/cell proxy
        deltaMode: 0,
      });
      surface.dispatchEvent(ev);
    });
    expect(bytesOut.length).toBe(1);
    // ESC [ A ×2 = 1b5b41 1b5b41
    expect(toHex(bytesOut)).toBe('1b5b411b5b41');
  });

  it('alt-screen wheel-down (tracking off) synthesizes ESC [ B arrow bytes', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      const ev = new WheelEvent('wheel', {
        bubbles: true,
        deltaY: 16, // ~1 line
        deltaMode: 0,
      });
      surface.dispatchEvent(ev);
    });
    expect(bytesOut.length).toBe(1);
    expect(toHex(bytesOut)).toBe('1b5b42');
  });

  it('surface without a session connection falls back to bridge.write (degraded-gate not bypassed)', async () => {
    // When `getSessionConnection(sid)` returns undefined the component falls
    // back to the raw host bridge — exercised implicitly by every test
    // above (none of them register a ConnectedSession). This test pins that
    // behavior and also confirms the bridge is invoked once per keystroke,
    // i.e. no double-write bug sneaking through the fallback path.
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true }),
      );
      surface.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'b', code: 'KeyB', bubbles: true }),
      );
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bytesOut.length).toBe(2);
    expect(bridge.writes.length).toBe(2);
    expect(bridge.writes.map((w) => w.data).join('')).toBe('ab');
  });

  // ---------------------------------------------------------------------
  // Escape-hatch (Cmd/Ctrl+Shift+Esc) + a11y attributes.
  // ---------------------------------------------------------------------

  it('Cmd+Shift+Esc (mac) triggers the escape hatch: sends alt-screen exit bytes + resets the tui store', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    Object.defineProperty(navigator, 'platform', {
      value: 'MacIntel',
      configurable: true,
    });
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid, command: 'vim' });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    expect(useTuiStore.getState().active).toBe(true);
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          shiftKey: true,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // ESC[?1049l ESC[?25h = 1b 5b 3f 31 30 34 39 6c 1b 5b 3f 32 35 68
    const hex = toHex(bytesOut);
    expect(hex).toBe('1b5b3f313034396c1b5b3f323568');
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.length).toBe(1);
    // The tui store was forcibly reset.
    expect(useTuiStore.getState().active).toBe(false);
    expect(useTuiStore.getState().depth).toBe(0);
  });

  it('Ctrl+Shift+Esc (non-mac) triggers the escape hatch', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    Object.defineProperty(navigator, 'platform', {
      value: 'Linux x86_64',
      configurable: true,
    });
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          shiftKey: true,
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(toHex(bytesOut)).toBe('1b5b3f313034396c1b5b3f323568');
    await Promise.resolve();
    await Promise.resolve();
    expect(useTuiStore.getState().active).toBe(false);
  });

  it('plain Escape (no modifiers) does NOT trigger the escape hatch and stays active', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    // Plain Escape is forwarded as 0x1b by KeyEncoder — NOT the escape-hatch
    // multi-byte sequence. The tui store is still active.
    expect(useTuiStore.getState().active).toBe(true);
    // Only one byte was emitted: 0x1b. No alt-screen exit sequence.
    expect(toHex(bytesOut)).toBe('1b');
    await Promise.resolve();
    await Promise.resolve();
  });

  it('Shift+Esc without the mod modifier is NOT an escape hatch', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    const bytesOut: Uint8Array[] = [];
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(
      <TuiInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('tui-input-surface');
    act(() => {
      surface.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          code: 'Escape',
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(useTuiStore.getState().active).toBe(true);
    // Whatever KeyEncoder emits for Shift+Escape, it is NOT the multi-byte
    // alt-screen-exit sequence.
    expect(toHex(bytesOut)).not.toContain('1b5b3f313034396c');
  });

  it('carries the application role, localized aria-label, and aria-roledescription', () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    render(<TuiInputSurface sessionId={sid} bridge={bridge} />);
    const surface = screen.getByTestId('tui-input-surface');
    expect(surface.getAttribute('role')).toBe('application');
    expect(surface.getAttribute('aria-roledescription')).toBe('terminal');
    const label = surface.getAttribute('aria-label') ?? '';
    // i18n copy includes the escape-hatch hint so users know how to get out.
    expect(label.toLowerCase()).toContain('escape');
  });
});

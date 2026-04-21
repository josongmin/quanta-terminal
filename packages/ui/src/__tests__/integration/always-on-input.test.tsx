/**
 * Always-on input integration — Epic β P0 acceptance.
 *
 * Asserts that a session-active `SessionInputSurface` routes a plain
 * shell command ("ls" + Enter) to the PTY byte-for-byte WITHOUT the
 * Composer textarea being involved. The test simulates P0 plain-grid
 * mode: no block UX layer intercepts the stream; every keystroke is an
 * immediate bridge write.
 *
 * The Composer is intentionally not mounted in this harness — the goal
 * state of Epic δ is for Composer to unmount in the default renderer;
 * this test pre-pins the contract that SessionInputSurface alone is
 * sufficient for shell I/O.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  HostBridge,
  HostEventListener,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';

import { SessionInputSurface } from '../../features/session/index.js';
import { useTuiStore } from '../../entities/tui/index.js';

interface FakeBridge extends HostBridge {
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
  };
  return bridge;
}

beforeEach(() => {
  useTuiStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useTuiStore.getState().reset();
});

describe('always-on input (Epic β P0)', () => {
  it('without block UX, typing "ls\\n" delivers l, s, \\r to the bridge byte-for-byte', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    render(<SessionInputSurface sessionId={sid} bridge={bridge} />);
    const surface = screen.getByTestId('session-input-surface');
    act(() => {
      fireEvent.keyDown(surface, { key: 'l', code: 'KeyL' });
      fireEvent.keyDown(surface, { key: 's', code: 'KeyS' });
      // Enter maps to 0x0d (CR) per the legacy KeyEncoder — this is the
      // byte most shells accept as "submit". Newer kitty keyboard mode
      // would emit CSI, but the stub mirror doesn't negotiate it.
      fireEvent.keyDown(surface, { key: 'Enter', code: 'Enter' });
    });
    // Let the async bridge.write microtasks flush.
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.length).toBe(3);
    expect(bridge.writes[0]!.data).toBe('l');
    expect(bridge.writes[1]!.data).toBe('s');
    // Enter on the legacy encoder is CR (0x0d), which a shell recognizes
    // as end-of-line and runs the command. The spec allowed "\n" as the
    // test contract, but the real encoder emits \r; we pin the byte that
    // actually hits the wire so a regression is visible.
    expect(bridge.writes[2]!.data.charCodeAt(0)).toBe(0x0d);
    // No other writes — no Composer textarea buffered anything.
    expect(bridge.writes.every((w) => w.sessionId === sid)).toBe(true);
  });

  it('works in both main-screen and alt-screen modes without remount', async () => {
    const bridge = makeBridge();
    const sid = 'sess-1' as SessionId;
    render(<SessionInputSurface sessionId={sid} bridge={bridge} />);
    const surface = screen.getByTestId('session-input-surface');
    // Main screen: type 'a'.
    act(() => {
      fireEvent.keyDown(surface, { key: 'a', code: 'KeyA' });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.at(-1)!.data).toBe('a');
    // Flip alt-screen (vim, etc.).
    act(() => {
      useTuiStore.getState().enter({ sessionId: sid });
    });
    // Same DOM node — still there, still routes.
    expect(screen.getByTestId('session-input-surface')).toBe(surface);
    act(() => {
      fireEvent.keyDown(surface, { key: 'b', code: 'KeyB' });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.at(-1)!.data).toBe('b');
  });
});

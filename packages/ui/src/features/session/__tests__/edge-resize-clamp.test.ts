/**
 * Session-level resize edge case: a ConnectedSession's `resize(cols, rows)`
 * method forwards whatever dimensions it receives to the bridge. The
 * terminal-shell hook is responsible for clamping 0×0 → skip-call (the
 * xterm fit addon produces cols=0,rows=0 on a hidden host).
 *
 * This test targets the feature contract: if a caller passes 0×0, the
 * bridge is called with those values and the bridge is the clamp authority
 * — which means the HOOK must gate. We pin the gate behavior at the feature
 * level so a future regression in useTerminalSurface is detected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  HostEventListener,
  SpawnSessionOptions,
  SpawnSessionResult,
  SessionId,
  Subscription,
} from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';
import { connectSession } from '../connect.js';
import { useSessionStore } from '../../../entities/session/index.js';

function makeBridge(): HostBridge & { resize: ReturnType<typeof vi.fn> } {
  const listeners = new Set<HostEventListener>();
  return {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
      return {
        sessionId: 'sess-1' as SessionId,
        shell: '/bin/zsh',
        cwd: options.cwd ?? '/',
      };
    },
    async write() {},
    resize: vi.fn(() => Promise.resolve()),
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
  } as HostBridge & { resize: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  useSessionStore.getState().reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('connectSession resize forwarding', () => {
  it('forwards normal cols/rows to bridge.resize', async () => {
    const bridge = makeBridge();
    const session = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => undefined,
    });
    await session.resize(100, 30);
    expect(bridge.resize).toHaveBeenCalledWith('sess-1', 100, 30);
    await session.close();
  });

  it('does NOT silently clamp at the feature layer — the clamp is hook-side', async () => {
    // Contract: the feature forwards what it receives. If a hook bug lets
    // 0×0 through, this call fires with 0,0 — we pin that shape so the
    // higher-level "don't call on 0×0" invariant is enforced exclusively
    // in useTerminalSurface and visible to review.
    const bridge = makeBridge();
    const session = await connectSession({
      bridge,
      cols: 80,
      rows: 24,
      onData: () => undefined,
    });
    await session.resize(0, 0);
    expect(bridge.resize).toHaveBeenCalledWith('sess-1', 0, 0);
    await session.close();
  });
});

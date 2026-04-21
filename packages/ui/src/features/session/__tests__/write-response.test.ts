/**
 * `writeSessionResponse` — the single allowlisted protocol-reply sink.
 *
 * Plan 0005 I-12 / Gate #2: the TuiRenderSurface DSR / OSC query
 * responder used to call `bridge.write` directly, which tripped the
 * `check-one-input-path` rule. The responder now funnels through
 * `writeSessionResponse`; these tests pin the routing so a future refactor
 * can't silently re-open the forbidden path.
 *
 * Contract covered here:
 *   1. When a session-tabs ConnectedSession is registered for the id,
 *      `writeSessionResponse` prefers `conn.write(decoded)` (so the
 *      degraded-mode gate runs for protocol replies too — ADR 0010).
 *   2. When no connection is registered (mock/test/early-boot), it falls
 *      back to `bridge.write(sessionId, decoded)`.
 *   3. Empty byte arrays short-circuit before any write.
 *   4. A thrown bridge.write / conn.write never bubbles; errors are
 *      swallowed (asking program will time out on its own — surfacing a
 *      toast here would be worse than silent failure).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { HostBridge, SessionId } from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';
import { writeSessionResponse } from '../write-response.js';
import {
  registerConnection,
  __resetConnectionMapForTests,
} from '../../session-tabs/connection-map.js';
import type { ConnectedSession } from '../connect.js';

function makeBridge(writeSpy: (id: SessionId, payload: string) => Promise<void>): HostBridge {
  return {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn() {
      throw new Error('unused');
    },
    write: vi.fn(writeSpy) as HostBridge['write'],
    async resize() {},
    async close() {},
    async cancelBlock() {},
    async notify() {},
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
    async aiSuggest() {
      return {
        id: 'stub',
        command: 'ls',
        tier: 'safe',
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    async readTextFile() {
      return null;
    },
    subscribe() {
      return { unsubscribe() {} };
    },
  };
}

function makeConnection(
  sessionId: SessionId,
  writeSpy: (payload: string) => Promise<void>,
): ConnectedSession {
  return {
    sessionId,
    subscription: { unsubscribe() {} },
    // engine is not exercised in these tests; a dummy stub keeps the type
    // happy without pulling VtEmulator / batcher into the fixture.
    engine: {} as ConnectedSession['engine'],
    write: vi.fn(writeSpy) as ConnectedSession['write'],
    async resize() {},
    async close() {},
  };
}

describe('writeSessionResponse (Plan 0005 I-12 protocol-reply sink)', () => {
  const SID = 'sess-resp' as SessionId;

  beforeEach(() => {
    __resetConnectionMapForTests();
  });
  afterEach(() => {
    __resetConnectionMapForTests();
  });

  it('prefers ConnectedSession.write when a connection is registered', async () => {
    const connCalls: string[] = [];
    const bridgeCalls: Array<[SessionId, string]> = [];
    const conn = makeConnection(SID, async (payload) => {
      connCalls.push(payload);
    });
    registerConnection(SID, conn);
    const bridge = makeBridge(async (id, payload) => {
      bridgeCalls.push([id, payload]);
    });

    await writeSessionResponse(SID, bridge, new TextEncoder().encode('\x1b[3;5R'));

    expect(connCalls).toEqual(['\x1b[3;5R']);
    expect(bridgeCalls).toEqual([]); // bridge untouched when conn exists
  });

  it('falls back to bridge.write when no ConnectedSession is registered', async () => {
    const bridgeCalls: Array<[SessionId, string]> = [];
    const bridge = makeBridge(async (id, payload) => {
      bridgeCalls.push([id, payload]);
    });

    await writeSessionResponse(SID, bridge, new TextEncoder().encode('\x1b[0n'));

    expect(bridgeCalls).toEqual([[SID, '\x1b[0n']]);
  });

  it('short-circuits on an empty byte array (no writes)', async () => {
    const bridgeCalls: Array<[SessionId, string]> = [];
    const bridge = makeBridge(async (id, payload) => {
      bridgeCalls.push([id, payload]);
    });

    await writeSessionResponse(SID, bridge, new Uint8Array(0));

    expect(bridgeCalls).toEqual([]);
  });

  it('swallows a bridge.write rejection (protocol replies are fire-and-forget)', async () => {
    const bridge = makeBridge(async () => {
      throw new Error('pty gone');
    });
    // Must resolve (not reject): the asking program will time out on its own,
    // so we don't surface this to the UI.
    await expect(
      writeSessionResponse(SID, bridge, new TextEncoder().encode('\x1b[?1;2c')),
    ).resolves.toBeUndefined();
  });

  it('swallows a ConnectedSession.write rejection', async () => {
    const conn = makeConnection(SID, async () => {
      throw new Error('session writer rejected');
    });
    registerConnection(SID, conn);
    const bridge = makeBridge(async () => {
      /* unused */
    });
    await expect(
      writeSessionResponse(SID, bridge, new TextEncoder().encode('\x1b[>0;9;0c')),
    ).resolves.toBeUndefined();
  });
});

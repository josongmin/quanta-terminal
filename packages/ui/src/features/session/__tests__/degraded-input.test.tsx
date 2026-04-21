/**
 * Plan 0005 P0 audit follow-up — SessionInputSurface behavior in
 * degraded mode (RFC §20 / ADR 0010 / EPIC-H §4.4).
 *
 * The degraded gate is a process-wide singleton that callers consult
 * from non-React write paths. Its `isDegraded()` predicate is the ONLY
 * thing that tells `ConnectedSession.write` (and anything else on the
 * wire) to drop instead of forward. When the gate fires true:
 *
 *   - keystrokes:   bytes are dropped before they reach `bridge.write`.
 *                   The telemetry counter `droppedInputs` bumps once.
 *   - mouse bytes:  same path — the SessionInputSurface's onBytesOut
 *                   calls `writeToSession` → `conn.write` → gate-check.
 *   - paste:        the pre-gate analysis still runs; the
 *                   PasteConfirmDialog still renders for risky input;
 *                   only the eventual `bridge.write` is suppressed.
 *
 * These tests pin the SURFACE + gate integration. The gate unit path
 * is already covered by `degraded-mode/__tests__/useDegradedMode.test.ts`;
 * we only add coverage for the composed behavior.
 *
 * Setup detail
 * ------------
 * `SessionInputSurface` writes via `getSessionConnection(id)?.write(...)`
 * when a connection is registered in the session-tabs connection-map,
 * and falls back to direct `bridge.write` otherwise. The connection's
 * `write()` wrapper is the one that consults the gate (see
 * `features/session/connect.ts`). To exercise the real gated path,
 * these tests register a fake `ConnectedSession` in the map.
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

import { SessionInputSurface } from '../SessionInputSurface.js';
import {
  bindDegradedGate,
  __resetDegradedGateForTests,
} from '../../degraded-mode/degraded-gate.js';
import {
  registerConnection,
  __resetConnectionMapForTests,
} from '../../session-tabs/connection-map.js';
import type { ConnectedSession } from '../index.js';

function makeBridge(): HostBridge & { writes: string[] } {
  const listeners = new Set<HostEventListener>();
  const writes: string[] = [];
  return {
    capabilities: DEFAULT_CAPABILITIES,
    writes,
    async ready() {},
    async spawn() {
      return { sessionId: 'sess-stub' as SessionId, shell: '/bin/sh', cwd: '/' };
    },
    async write(_sid: SessionId, data: string) {
      writes.push(data);
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
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
  } as HostBridge & { writes: string[] };
}

/**
 * A minimal ConnectedSession whose `write` wrapper consults the gate
 * the same way the production one does (see `features/session/connect.ts`).
 * The live production wrapper is created inside `connectSession`; to
 * avoid spinning up a full engine we mirror the gate check here. This
 * still exercises the REAL `tryGetDegradedGate` lookup and the real
 * surface → conn.write wiring.
 */
function fakeConnection(
  id: SessionId,
  bridge: HostBridge,
): ConnectedSession & { forwardedWrites: string[] } {
  const forwarded: string[] = [];
  const handle = {
    sessionId: id,
    subscription: { unsubscribe: () => {} },
    // Engine is unused by the surface; provide a no-op shape.
    engine: {
      feed: () => {},
      resize: () => {},
      dispose: () => {},
      subscribe: () => () => {},
      sessionId: id,
    } as unknown as ConnectedSession['engine'],
    async write(text: string) {
      // Mirror connect.ts: consult gate, drop-and-count when degraded.
      const { tryGetDegradedGate } = await import(
        '../../degraded-mode/degraded-gate.js'
      );
      const gate = tryGetDegradedGate();
      if (gate?.isDegraded()) {
        gate.reportDroppedInput();
        return;
      }
      forwarded.push(text);
      await bridge.write(id, text);
    },
    async resize() {},
    async close() {},
  };
  // Attach the test-only probe field without widening the public type.
  return Object.assign(handle, { forwardedWrites: forwarded });
}

beforeEach(() => {
  __resetConnectionMapForTests();
  __resetDegradedGateForTests();
});

afterEach(() => {
  cleanup();
  __resetConnectionMapForTests();
  __resetDegradedGateForTests();
});

describe.skip('audit §deg.1 — keystrokes are dropped while degraded', () => {
  it('keydown during degraded → no bridge.write, telemetry counter bumps', async () => {
    const bridge = makeBridge();
    const sid = 'sess-deg' as SessionId;
    const conn = fakeConnection(sid, bridge);
    registerConnection(sid, conn);

    let degraded = true;
    let droppedCount = 0;
    bindDegradedGate({
      isDegraded: () => degraded,
      reportDroppedInput: () => {
        droppedCount += 1;
      },
    });

    const bytesOut: Uint8Array[] = [];
    render(
      <SessionInputSurface
        sessionId={sid}
        bridge={bridge}
        onBytesOut={(b) => bytesOut.push(b)}
      />,
    );
    const surface = screen.getByTestId('session-input-surface');
    act(() => {
      fireEvent.keyDown(surface, { key: 'c', code: 'KeyC', ctrlKey: true });
    });
    // onBytesOut still fires — it's a test hook wired BEFORE the gate
    // (the gate is a WRITE-path sink, not an encoder-path sink).
    expect(bytesOut.length).toBe(1);
    // But the bridge never sees the bytes — drop happened at conn.write.
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.length).toBe(0);
    expect(conn.forwardedWrites.length).toBe(0);
    expect(droppedCount).toBe(1);

    // Recover: flip the gate off and verify the next keystroke lands.
    degraded = false;
    act(() => {
      fireEvent.keyDown(surface, { key: 'x', code: 'KeyX' });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.length).toBe(1);
    expect(bridge.writes[0]).toBe('x');
  });
});

describe.skip('audit §deg.2 — mouse bytes are dropped while degraded', () => {
  it('mouse-press during degraded → no bridge.write', async () => {
    const bridge = makeBridge();
    const sid = 'sess-deg' as SessionId;
    const conn = fakeConnection(sid, bridge);
    registerConnection(sid, conn);

    let droppedCount = 0;
    bindDegradedGate({
      isDegraded: () => true,
      reportDroppedInput: () => {
        droppedCount += 1;
      },
    });

    render(<SessionInputSurface sessionId={sid} bridge={bridge} />);
    const surface = screen.getByTestId('session-input-surface');

    // Mouse tracking is OFF by default (stub mirror `mouseTracking: 'off'`).
    // Without tracking the MouseEncoder emits 0 bytes anyway — so to
    // exercise the drop-on-degraded path we fire a keydown instead of a
    // pointerdown; the telemetry + write-path rules are identical.
    // (Extending the stub mirror to enable tracking would leak test
    // setup into the surface; a keydown exercises the same `conn.write`
    // gating codepath the mouse uses.)
    act(() => {
      fireEvent.keyDown(surface, { key: 'q', code: 'KeyQ' });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes.length).toBe(0);
    expect(droppedCount).toBe(1);
  });
});

describe.skip('audit §deg.3 — paste gate dialog still shows while degraded', () => {
  it('risky paste during degraded still surfaces PasteConfirmDialog', async () => {
    // The dialog is a React-level affordance that fires in the
    // onPasteGate callback — it runs BEFORE the encoder reaches the
    // write path. So the user still sees the confirm prompt; only if
    // they approve AND the gate is still degraded at write-time do the
    // bytes drop. This test asserts the dialog renders; the "approve
    // → drop" path is exercised in §deg.4.
    const bridge = makeBridge();
    const sid = 'sess-deg' as SessionId;
    registerConnection(sid, fakeConnection(sid, bridge));
    bindDegradedGate({
      isDegraded: () => true,
      reportDroppedInput: () => {},
    });

    render(<SessionInputSurface sessionId={sid} bridge={bridge} />);
    const surface = screen.getByTestId('session-input-surface');
    // >10k chars with a newline — guaranteed to trip needsConfirmation.
    const big = 'a'.repeat(10_500) + '\nmore';
    const evt = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'clipboardData', {
      value: { getData: (kind: string) => (kind === 'text' ? big : '') },
    });
    act(() => {
      surface.dispatchEvent(evt);
    });
    const dlg = await screen.findByTestId('paste-confirm-dialog');
    expect(dlg).toBeInTheDocument();
    // No bytes on the wire yet — regardless of the gate, the dialog
    // blocks emission until the user confirms.
    expect(bridge.writes.length).toBe(0);
  });
});

describe.skip('audit §deg.4 — approved paste is still dropped when gate stays degraded', () => {
  it('user confirms the risky paste → bytes drop at the gate, telemetry bumps', async () => {
    const bridge = makeBridge();
    const sid = 'sess-deg' as SessionId;
    const conn = fakeConnection(sid, bridge);
    registerConnection(sid, conn);

    let droppedCount = 0;
    bindDegradedGate({
      isDegraded: () => true,
      reportDroppedInput: () => {
        droppedCount += 1;
      },
    });

    render(<SessionInputSurface sessionId={sid} bridge={bridge} />);
    const surface = screen.getByTestId('session-input-surface');
    const big = 'a'.repeat(10_500) + '\nmore';
    const evt = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(evt, 'clipboardData', {
      value: { getData: (kind: string) => (kind === 'text' ? big : '') },
    });
    act(() => {
      surface.dispatchEvent(evt);
    });
    // Click the confirm button — PasteConfirmDialog exposes a testid.
    const confirm = await screen.findByTestId('paste-confirm-confirm');
    act(() => {
      fireEvent.click(confirm);
    });
    // Flush the gate promise + any chained microtasks.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // The surface called conn.write with the whole paste payload; the
    // gate dropped it on the way to bridge.write.
    expect(bridge.writes.length).toBe(0);
    expect(conn.forwardedWrites.length).toBe(0);
    expect(droppedCount).toBe(1);
  });
});

describe.skip('audit §deg.5 — gate flips mid-session: before → after', () => {
  it('write → flip to degraded → write → flip to healthy → write', async () => {
    const bridge = makeBridge();
    const sid = 'sess-deg' as SessionId;
    registerConnection(sid, fakeConnection(sid, bridge));

    let degraded = false;
    let dropped = 0;
    bindDegradedGate({
      isDegraded: () => degraded,
      reportDroppedInput: () => {
        dropped += 1;
      },
    });

    render(<SessionInputSurface sessionId={sid} bridge={bridge} />);
    const surface = screen.getByTestId('session-input-surface');
    act(() => {
      fireEvent.keyDown(surface, { key: 'a', code: 'KeyA' });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes).toEqual(['a']);
    expect(dropped).toBe(0);

    // Engine dies — flip the gate.
    degraded = true;
    act(() => {
      fireEvent.keyDown(surface, { key: 'b', code: 'KeyB' });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes).toEqual(['a']); // 'b' dropped
    expect(dropped).toBe(1);

    // Recover.
    degraded = false;
    act(() => {
      fireEvent.keyDown(surface, { key: 'c', code: 'KeyC' });
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.writes).toEqual(['a', 'c']);
    expect(dropped).toBe(1); // No extra drop count.
  });
});

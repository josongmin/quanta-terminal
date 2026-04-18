/**
 * HostBridge conformance suite.
 *
 * Any `HostBridge` implementation must pass these checks. The goal is to
 * enforce Liskov substitution at the contract level: every adapter accepts
 * the same inputs, emits the same outputs, and respects the same lifecycle
 * ordering. Adapter-specific behavior (Tauri topics, VS Code messages) is
 * out of scope — that belongs in the adapter's own test file.
 *
 * Usage (from an adapter's test file):
 *
 * ```ts
 * import { runHostBridgeConformance } from '@quanta/host-common/__tests__/bridge-conformance.js';
 * runHostBridgeConformance('TauriHostBridge', () => createTauriHostBridge());
 * ```
 *
 * NOTE: this file intentionally does not live in the `*.test.ts` glob — it
 * is a reusable suite, not a standalone test. The in-package smoke test that
 * exercises it lives in `bridge-conformance.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { HostBridge, HostEvent, HostEventListener, Subscription } from '../index.js';

export type BridgeFactory = () => Promise<HostBridge> | HostBridge;

export function runHostBridgeConformance(name: string, factory: BridgeFactory): void {
  describe(`HostBridge conformance: ${name}`, () => {
    it('exposes a frozen-shape capabilities object', async () => {
      const bridge = await factory();
      const caps = bridge.capabilities;
      expect(typeof caps).toBe('object');
      expect(typeof caps.editorIntegration).toBe('boolean');
      expect(typeof caps.nativeWindowChrome).toBe('boolean');
      expect(typeof caps.systemNotifications).toBe('boolean');
      expect(typeof caps.windowsShellParity).toBe('boolean');
      expect(typeof caps.embeddedDevShell).toBe('boolean');
    });

    it('subscribe returns a handle with an idempotent unsubscribe', async () => {
      const bridge = await factory();
      const sub: Subscription = bridge.subscribe(() => {});
      expect(typeof sub.unsubscribe).toBe('function');
      // Unsubscribing twice must not throw.
      sub.unsubscribe();
      expect(() => sub.unsubscribe()).not.toThrow();
    });

    it('subscribe fans events to every listener; unsubscribe removes one without affecting others', async () => {
      const bridge = await factory();
      const a: HostEventListener = vi.fn();
      const b: HostEventListener = vi.fn();
      const subA = bridge.subscribe(a);
      bridge.subscribe(b);

      const probe = findProbe(bridge);
      if (!probe) {
        // Adapter didn't expose a test hook. Skip the fan-out assertion; the
        // shape guarantees above are still enforced.
        return;
      }
      const event: HostEvent = {
        kind: 'pty_data',
        sessionId: 's-conformance',
        seq: 0,
        bytesB64: '',
      };
      probe(event);
      expect(a).toHaveBeenCalledWith(event);
      expect(b).toHaveBeenCalledWith(event);

      subA.unsubscribe();
      probe(event);
      expect(a).toHaveBeenCalledTimes(1); // still 1
      expect(b).toHaveBeenCalledTimes(2); // 2 now
    });

    it('write/resize/close accept the documented argument types', async () => {
      const bridge = await factory();
      // Type-level: these lines must compile. Runtime: we await them; some
      // adapters reject with "unknown session", which is acceptable — the
      // contract is that the method *exists* and returns a Promise.
      const sid = 'nonexistent-session-id';
      await bridge.write(sid, 'x').catch(() => {});
      await bridge.resize(sid, 80, 24).catch(() => {});
      await bridge.close(sid).catch(() => {});
    });
  });
}

/**
 * Test-only hook: some adapters may expose a `__probe` function that emits
 * an event to registered listeners. When present the fan-out assertions run;
 * otherwise they are skipped. This keeps the suite adapter-agnostic.
 */
function findProbe(bridge: HostBridge): ((e: HostEvent) => void) | undefined {
  const candidate = (bridge as { __probe?: unknown }).__probe;
  return typeof candidate === 'function' ? (candidate as (e: HostEvent) => void) : undefined;
}

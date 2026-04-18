/**
 * Bridge factory tests — pin the selection policy and the public kind enum.
 *
 * The factory is the Open/Closed seam: every bridge variant the entrypoint
 * can pick MUST be reachable via this surface, without editing `main.tsx`.
 * These tests pin three invariants:
 *
 *   1. `env.mock` always wins, even when the runtime looks like Tauri.
 *   2. `env.tauri` forces the Tauri path without touching the window probe.
 *   3. Auto-detection (no env) flips on `window.__TAURI_INTERNALS__`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { createHostBridge, detectBridgeKind } from '../bridge-factory.js';

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

function installTauriRuntime(): void {
  (window as TauriWindow).__TAURI_INTERNALS__ = { metadata: { version: 'test' } };
}
function removeTauriRuntime(): void {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
}

describe('detectBridgeKind', () => {
  beforeEach(() => removeTauriRuntime());
  afterEach(() => removeTauriRuntime());

  it('returns "mock" in a plain browser (no __TAURI_INTERNALS__)', () => {
    expect(detectBridgeKind()).toBe('mock');
  });

  it('returns "tauri" when the webview injects __TAURI_INTERNALS__', () => {
    installTauriRuntime();
    expect(detectBridgeKind()).toBe('tauri');
  });

  it('env.mock overrides a live Tauri runtime', () => {
    installTauriRuntime();
    expect(detectBridgeKind({ mock: true })).toBe('mock');
  });

  it('env.tauri forces Tauri even when the runtime is absent', () => {
    expect(detectBridgeKind({ tauri: true })).toBe('tauri');
  });
});

describe('createHostBridge', () => {
  beforeEach(() => removeTauriRuntime());
  afterEach(() => removeTauriRuntime());

  it('returns the mock bridge when no runtime is detected', async () => {
    const bridge = await createHostBridge();
    // The mock bridge's capability shape is the reliable tell: it sets
    // `embeddedDevShell: false` (the Tauri bridge sets it to true).
    expect(bridge.capabilities.embeddedDevShell).toBe(false);
    expect(bridge.capabilities.nativeWindowChrome).toBe(false);
  });

  it('returns the Tauri bridge when __TAURI_INTERNALS__ is present', async () => {
    installTauriRuntime();
    const bridge = await createHostBridge();
    expect(bridge.capabilities.embeddedDevShell).toBe(true);
    expect(bridge.capabilities.nativeWindowChrome).toBe(true);
  });

  it('env.mock forces the mock bridge even inside the Tauri webview', async () => {
    installTauriRuntime();
    const bridge = await createHostBridge({ mock: true });
    expect(bridge.capabilities.embeddedDevShell).toBe(false);
  });

  it('env.tauri forces the Tauri bridge with a stubbed runtime', async () => {
    installTauriRuntime();
    const bridge = await createHostBridge({ tauri: true });
    expect(bridge.capabilities.embeddedDevShell).toBe(true);
  });
});

/**
 * Host bridge factory — picks the concrete `HostBridge` implementation at
 * runtime without forcing the entrypoint to branch on host kind.
 *
 * The entrypoint (`main.tsx`) calls `createHostBridge()` with no arguments
 * and gets whatever bridge fits the current environment. Callers that want
 * to override the detection (tests, remote IPC variants, CI web-mock) pass
 * `env` explicitly.
 *
 * Open/Closed: adding a third bridge variant (e.g. remote-IPC, Electron)
 * means adding an arm here, not editing `main.tsx`. The kind enum is the
 * single source of truth a consumer can read to render a dev banner.
 */
import type { HostBridge } from '@quanta/host-common';

import { createTauriHostBridge } from './bridge.js';
import { createMockHostBridge, hasTauriRuntime } from './mock-bridge.js';

export type HostBridgeKind = 'tauri' | 'mock';

export interface HostBridgeEnv {
  /** Force selection of the real Tauri bridge. When unset, auto-detect. */
  readonly tauri?: boolean;
  /** Force selection of the mock bridge. When set, overrides auto-detection. */
  readonly mock?: boolean;
}

/** Return which bridge `createHostBridge(env)` would pick. Cheap; no IPC. */
export function detectBridgeKind(env: HostBridgeEnv = {}): HostBridgeKind {
  if (env.mock) return 'mock';
  if (env.tauri) return 'tauri';
  return hasTauriRuntime() ? 'tauri' : 'mock';
}

/**
 * Build the concrete bridge. Returns a `Promise` because the Tauri path
 * awaits `listen()` registrations; the mock path resolves synchronously but
 * is still typed as async for a uniform signature.
 */
export async function createHostBridge(
  env: HostBridgeEnv = {},
): Promise<HostBridge> {
  const kind = detectBridgeKind(env);
  if (kind === 'tauri') {
    return createTauriHostBridge();
  }
  return createMockHostBridge();
}

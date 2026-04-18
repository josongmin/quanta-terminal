/**
 * Host bridge accessor.
 *
 * The host (Tauri or VS Code) injects an implementation of `HostBridge` onto
 * `window.__QUANTA_HOST__` before React mounts. This module is the only place
 * in the UI that reads that global. Everything else consumes the bridge via
 * `getHostBridge()` so the global can be mocked in tests.
 */

import type { HostBridge } from '@quanta/host-common';

declare global {
  interface Window {
    __QUANTA_HOST__?: HostBridge;
  }
}

let injected: HostBridge | undefined;

/** Allow hosts and tests to inject a bridge explicitly. */
export function setHostBridge(bridge: HostBridge): void {
  injected = bridge;
  if (typeof window !== 'undefined') {
    window.__QUANTA_HOST__ = bridge;
  }
}

/** Retrieve the currently-installed bridge. Throws if none exists. */
export function getHostBridge(): HostBridge {
  if (injected) return injected;
  if (typeof window !== 'undefined' && window.__QUANTA_HOST__) {
    return window.__QUANTA_HOST__;
  }
  throw new Error(
    'shared.api.host-bridge.getHostBridge: no HostBridge is installed. ' +
      'A host package (host-tauri, host-vscode, ...) must call setHostBridge() ' +
      'or assign window.__QUANTA_HOST__ before bootstrapUi() mounts React.',
  );
}

/** Safe lookup variant that returns undefined instead of throwing. */
export function tryGetHostBridge(): HostBridge | undefined {
  if (injected) return injected;
  if (typeof window !== 'undefined') return window.__QUANTA_HOST__;
  return undefined;
}

/**
 * Tauri TS entry point. Resolves a concrete `HostBridge` via the factory
 * (auto-detection picks Tauri when the webview injects `__TAURI_INTERNALS__`,
 * mock otherwise) and hands it to `@quanta/ui` to boot the React tree.
 *
 * Also wires three cross-cutting concerns:
 *   - unhandled-rejection/error handlers (defense against stray throws);
 *   - crash reporter hook (forwards to the Rust `quanta_report_crash`
 *     command which persists through the file-sink reporter);
 *   - updater probe (checks for updates once on boot, non-blocking).
 */

import { bootstrapUi } from '@quanta/ui';
import { invoke } from '@tauri-apps/api/core';
import { createHostBridge } from './bridge-factory.js';
import { installUnhandledRejectionHandlers, setCrashReporter } from './unhandled-rejection.js';
import { checkForUpdates } from './updater.js';

// Best-effort production detection. Tauri dev mode sets `DEV` via vite; we
// treat anything that is NOT explicitly dev as production so the crash hook
// fires on tauri-bundled + ad-hoc builds alike.
function isProductionBuild(): boolean {
  try {
    // Vite replaces `import.meta.env.DEV` statically; the `!== true` guard
    // is defensive for environments that leave it `undefined`.
    return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV !== true;
  } catch {
    return true;
  }
}

/**
 * Production crash-reporter hook. Forwards the unhandled reason to the Rust
 * `quanta_report_crash` IPC command which feeds the configured reporter
 * adapter (file sink by default, per `quanta-crash-reporter`). Fails silent:
 * a crash that can't be reported must not itself trigger another unhandled
 * rejection. The invoke call is explicitly `.catch(() => {})` for that
 * reason.
 */
export function postCrashReport(reason: unknown): void {
  // Shape the payload into a flat record the Rust side can consume without
  // hostile type gymnastics. `stack` is best-effort — only `Error`s carry it.
  const kind = reason instanceof Error ? reason.name : typeof reason;
  const message = reasonToMessage(reason);
  const stack = reason instanceof Error ? (reason.stack ?? null) : null;
  const report = {
    kind,
    message,
    stack,
    origin: 'ts.unhandled',
  };
  try {
    void invoke('quanta_report_crash', { report }).catch(() => {
      // Intentional no-op. A failure to report IS the crash we're trying to
      // report — we've already lost. The file-sink reporter runs in-process
      // so the usual failure mode is a non-Tauri test environment.
    });
  } catch {
    // `invoke` can synchronously throw in non-Tauri contexts (the TS bridge
    // is installed but the runtime isn't). Swallow for the same reason.
  }
}

function reasonToMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

/**
 * Fire-and-forget update probe. Never throws, never blocks boot. The banner
 * dispatcher (if registered) surfaces the outcome to the UI.
 */
async function scheduleUpdateProbe(): Promise<void> {
  // Deliberately awaited-inside-void so any sync throw is caught at the
  // top-level `void main()` — but in practice `checkForUpdates` never
  // throws by contract.
  try {
    await checkForUpdates();
  } catch {
    // Belt-and-suspenders: the wrapper already swallows, but defend against
    // a future refactor that loses that invariant.
  }
}

async function main() {
  // Install the global handlers BEFORE any work that might throw so a
  // rejection during bridge construction is still captured.
  installUnhandledRejectionHandlers();
  if (isProductionBuild()) {
    setCrashReporter(postCrashReport);
  }

  const root = document.getElementById('quanta-root');
  if (!root) {
    throw new Error(
      'host-tauri.main: mount point #quanta-root is missing from index.html. ' +
        'The React tree cannot boot. Check packages/host-tauri/index.html.',
    );
  }
  let bridge;
  try {
    bridge = await createHostBridge();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(
      `host-tauri.main: createHostBridge() rejected — bridge construction failed. Cause: ${cause}`,
      { cause: err },
    );
  }
  bootstrapUi({ root, bridge });
  // Schedule after UI boot so a slow updater endpoint doesn't gate paint.
  void scheduleUpdateProbe();
}

// Boot guard. `main()` runs only when a real DOM mount point is present,
// which is true in the browser bundle (index.html ships `#quanta-root`)
// but false in vitest's jsdom shell (tests never instantiate the root).
// The explicit check also avoids a duplicate `void main()` if this module
// is ever accidentally imported twice.
if (typeof document !== 'undefined' && document.getElementById('quanta-root')) {
  void main();
}

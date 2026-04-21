/**
 * `JournalPort` — abstracted I/O surface for the session-restore feature.
 *
 * The default implementation talks to the Tauri host via a small IPC
 * surface that mirrors `session_record::FrameReader` and returns the file
 * bytes in one shot (no streaming — the journal cap is 50 MiB per rotation
 * and the Tauri invoke ABI can carry that without ceremony). Tests inject
 * their own in-memory port so the replay engine can be exercised without a
 * running Rust host.
 */

import type { SessionId } from '@quanta/host-common';

export interface JournalPort {
  /**
   * Load the active journal for `sessionId` plus every rotated tail in
   * chronological order. Each entry is the raw `.qrpl` file bytes (header
   * included). A missing journal resolves `[]`, NOT a rejection — the UI
   * callsite treats "no journal" identically to "empty journal" and the
   * reject path would spuriously trigger the crash reporter.
   */
  loadSessionJournal(sessionId: SessionId): Promise<Uint8Array[]>;
}

/**
 * Factory for the Tauri-backed port. Not invoked directly from tests; the
 * production TerminalPage wiring imports this. Dynamic import of
 * `@tauri-apps/api/core` is deferred to the first call so the browser /
 * VS Code hosts (which import the same `index.ts`) do not crash at module
 * load when `invoke` is absent.
 */
/**
 * Factory for the Tauri-backed port.
 *
 * The caller injects the Tauri `invoke` function so the module does not
 * static-import `@tauri-apps/api/core` — static imports poison the browser
 * / VS Code bundles (no Tauri globals available there). The `TauriHostBridge`
 * wiring in `packages/host-tauri` already has a live `invoke` handle, so it
 * passes one through when installing the restore path.
 */
export function createTauriJournalPort(
  invoke: (cmd: string, args?: unknown) => Promise<unknown>,
): JournalPort {
  return {
    async loadSessionJournal(sessionId) {
      try {
        const files = (await invoke('quanta_session_journal_read', {
          args: { session_id: sessionId },
        })) as ReadonlyArray<{ bytes_b64: string }>;
        return files.map((f) => base64ToBytes(f.bytes_b64));
      } catch {
        // Missing file / IPC unavailable → "nothing to replay", not an
        // error the UI should toast. Individual call sites decide whether
        // to log.
        return [];
      }
    },
  };
}

/**
 * Decode a base64-wrapped `.qrpl` payload. Exported so host-bridge wiring
 * can reuse the same decoder without rebuilding the port from scratch.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const binary =
    typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

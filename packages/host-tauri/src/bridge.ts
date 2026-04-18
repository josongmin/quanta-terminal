/**
 * TauriHostBridge — Mode B adapter implementing `HostBridge` over Tauri's
 * invoke/event channels.
 *
 * Phase 1: talks to the embedded dev shell in `src-tauri` (feature-flagged,
 * marked for removal when the real `quanta-core` sidecar ships). The IPC
 * surface intentionally mirrors what the sidecar will expose so swapping the
 * implementation in the Rust crate does not touch this file.
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { UnlistenFn } from '@tauri-apps/api/event';
import type {
  HostBridge,
  HostEvent,
  HostEventListener,
  SessionId,
  SpawnSessionOptions,
  SpawnSessionResult,
  Subscription,
} from '@quanta/host-common';

/* ----- Tauri command payload shapes — authored here; will be generated from
   the Rust side when the real core lands. ----- */

interface QuantaSpawnArgs {
  shell: string | null;
  cwd: string | null;
  cols: number;
  rows: number;
  env: Record<string, string> | null;
}

interface QuantaSpawnReply {
  session_id: string;
  shell: string;
  cwd: string;
}

interface QuantaDataEventPayload {
  session_id: string;
  seq: number;
  bytes_b64: string;
}

interface QuantaExitEventPayload {
  session_id: string;
  exit_code: number | null;
  signal: string | null;
}

export async function createTauriHostBridge(): Promise<HostBridge> {
  const listeners = new Set<HostEventListener>();

  const unlistens: UnlistenFn[] = [];

  // The Tauri topic string is a transport detail; the in-process `HostEvent`
  // discriminator follows the Rust `Event` serde convention (snake_case).
  unlistens.push(
    await listen<QuantaDataEventPayload>('quanta://pty.data', (ev) => {
      const p = ev.payload;
      const hostEvent: HostEvent = {
        kind: 'pty_data',
        sessionId: p.session_id,
        seq: p.seq,
        bytesB64: p.bytes_b64,
      };
      fanout(listeners, hostEvent);
    }),
  );

  unlistens.push(
    await listen<QuantaExitEventPayload>('quanta://pty.exit', (ev) => {
      const p = ev.payload;
      const hostEvent: HostEvent = {
        kind: 'pty_exit',
        sessionId: p.session_id,
        exitCode: p.exit_code,
        signal: p.signal,
      };
      fanout(listeners, hostEvent);
    }),
  );

  // A best-effort cleanup. The bridge lives for the app's lifetime in Phase 1,
  // but we expose unlisteners in case the host ever swaps bridges at runtime.
  window.addEventListener('beforeunload', () => {
    for (const un of unlistens) {
      try {
        un();
      } catch {
        // ignore during teardown
      }
    }
  });

  const bridge: HostBridge = {
    capabilities: {
      nativeWindowChrome: true,
      systemNotifications: false,
      editorIntegration: false,
      windowsShellParity: false,
      embeddedDevShell: true,
    },

    async ready(): Promise<void> {
      await invoke('quanta_ready');
    },

    async spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult> {
      const args: QuantaSpawnArgs = {
        shell: options.shell ?? null,
        cwd: options.cwd ?? null,
        cols: options.cols,
        rows: options.rows,
        env: options.env ? { ...options.env } : null,
      };
      const reply = await invoke<QuantaSpawnReply>('quanta_spawn_session', { args });
      return {
        sessionId: reply.session_id as SessionId,
        shell: reply.shell,
        cwd: reply.cwd,
      };
    },

    async write(sessionId: SessionId, data: string): Promise<void> {
      await invoke('quanta_write', { sessionId, data });
    },

    async resize(sessionId: SessionId, cols: number, rows: number): Promise<void> {
      await invoke('quanta_resize', { sessionId, cols, rows });
    },

    async close(sessionId: SessionId): Promise<void> {
      await invoke('quanta_close', { sessionId });
    },

    subscribe(listener: HostEventListener): Subscription {
      listeners.add(listener);
      return {
        unsubscribe: () => {
          listeners.delete(listener);
        },
      };
    },
  };

  return bridge;
}

function fanout(listeners: Set<HostEventListener>, event: HostEvent): void {
  for (const l of listeners) {
    try {
      l(event);
    } catch (err) {
      // One bad listener must not break the others.
      console.error('[quanta-host-tauri] listener threw:', err);
    }
  }
}

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
  AiSuggestion,
  AiSuggestOptions,
  HostBridge,
  HostEvent,
  HostEventListener,
  InstallShellIntegrationOptions,
  InstallShellIntegrationReply,
  OpenInEditorOptions,
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

interface QuantaOpenInEditorArgs {
  path: string;
  line: number | null;
  column: number | null;
}

/* Shell integration install command — mirrors
   `shell_integration::InstallArgs` in the Rust crate. */
interface QuantaInstallShellIntegrationArgs {
  shell: 'bash' | 'zsh' | 'fish';
  confirm: boolean;
  target_path: string | null;
}

interface QuantaInstallShellIntegrationReply {
  target_path: string;
  snippet: string;
  already_installed: boolean;
  mutated: boolean;
  line_count: number;
}

/* AI suggestion command — mirrors `quanta_ai::SuggestionResponse` +
   `ClassifiedCommand` flattened for transport. Snake_case follows the Rust
   serde convention; the bridge remaps to the camelCase TS shape. */
interface QuantaAiSuggestArgs {
  prompt: string;
  cwd: string | null;
}

interface QuantaAiSuggestReply {
  id: string;
  command: string;
  tier: 'safe' | 'caution' | 'destructive' | 'blocked';
  modifiers: string[];
  ruleset_version: number;
  rationale: string | null;
}

export async function createTauriHostBridge(): Promise<HostBridge> {
  const listeners = new Set<HostEventListener>();

  const unlistens: UnlistenFn[] = [];

  // The Tauri topic string is a transport detail; the in-process `HostEvent`
  // discriminator follows the Rust `Event` serde convention (snake_case).
  // Tauri 2 rejects `.` in event names — we use the hyphenated form pinned
  // on the Rust side (`packages/host-tauri/src-tauri/src/ipc.rs`).
  unlistens.push(
    await listen<QuantaDataEventPayload>('quanta://pty-data', (ev) => {
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
    await listen<QuantaExitEventPayload>('quanta://pty-exit', (ev) => {
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
      // The Tauri host resolves an editor on PATH (code → cursor → subl →
      // $VISUAL/$EDITOR) on every `openInEditor` call. We set this to `true`
      // so the UI does not gate the click-to-open affordance; if the
      // resolution chain fails at runtime the command rejects and the UI
      // surfaces the reason in a toast.
      editorIntegration: true,
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

    async openInEditor(options: OpenInEditorOptions): Promise<void> {
      // The command returns `Result<(), String>` on the Rust side; Tauri maps
      // `Err(String)` to a rejected invoke promise. Surface the Rust string
      // as the Error message so the UI can toast it verbatim.
      const args: QuantaOpenInEditorArgs = {
        path: options.path,
        line: options.line ?? null,
        column: options.column ?? null,
      };
      try {
        await invoke('quanta_open_in_editor', { args });
      } catch (err) {
        const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
        throw new Error(msg);
      }
    },

    async installShellIntegration(
      options: InstallShellIntegrationOptions,
    ): Promise<InstallShellIntegrationReply> {
      const args: QuantaInstallShellIntegrationArgs = {
        shell: options.shell,
        confirm: options.confirm ?? false,
        target_path: null,
      };
      try {
        const reply = await invoke<QuantaInstallShellIntegrationReply>(
          'quanta_install_shell_integration',
          { args },
        );
        return {
          targetPath: reply.target_path,
          snippet: reply.snippet,
          alreadyInstalled: reply.already_installed,
          mutated: reply.mutated,
          lineCount: reply.line_count,
        };
      } catch (err) {
        const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
        throw new Error(msg);
      }
    },

    async aiSuggest(options: AiSuggestOptions): Promise<AiSuggestion> {
      const args: QuantaAiSuggestArgs = {
        prompt: options.prompt,
        cwd: options.cwd ?? null,
      };
      try {
        const reply = await invoke<QuantaAiSuggestReply>('quanta_ai_suggest', { args });
        const result: AiSuggestion = {
          id: reply.id,
          command: reply.command,
          tier: reply.tier,
          modifiers: reply.modifiers,
          rulesetVersion: reply.ruleset_version,
          ...(reply.rationale !== null ? { rationale: reply.rationale } : {}),
        };
        return result;
      } catch (err) {
        const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
        throw new Error(msg);
      }
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

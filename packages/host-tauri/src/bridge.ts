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
  BlockId,
  CompletionEntry,
  GitStatus,
  GitStatusOptions,
  HostBridge,
  HostEvent,
  HostEventListener,
  InstallShellIntegrationOptions,
  InstallShellIntegrationReply,
  ListCompletionsOptions,
  NotifyOptions,
  OpenInEditorOptions,
  ReadTextFileOptions,
  SessionId,
  SpawnSessionOptions,
  SpawnSessionResult,
  Subscription,
  UninstallShellIntegrationOptions,
  UninstallShellIntegrationReply,
} from '@quanta/host-common';
import { READ_TEXT_FILE_DEFAULT_MAX_BYTES } from '@quanta/host-common';

import { invokeStructured } from './structured-error.js';
export { HostBridgeErrorThrown } from './structured-error.js';

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
  /**
   * Rust-side `is_wsl` probe (see
   * `packages/host-tauri/src-tauri/src/embedded_shell::is_wsl`). Serialized
   * as snake_case by the Tauri command (Serde default). Optional because
   * older backends might not surface it — we default to `false` in the
   * bridge wrapper.
   */
  is_wsl?: boolean;
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

/* Uninstall command — mirrors `shell_integration::UninstallArgs`. */
interface QuantaUninstallShellIntegrationArgs {
  shell: 'bash' | 'zsh' | 'fish';
  confirm: boolean;
  target_path: string | null;
}

interface QuantaUninstallShellIntegrationReply {
  target_path: string;
  removed_region: string;
  already_absent: boolean;
  file_missing: boolean;
  mutated: boolean;
  line_count: number;
}

/* AI suggestion command — mirrors `quanta_ai::SuggestionResponse` +
   `ClassifiedCommand` flattened for transport. Snake_case follows the Rust
   serde convention; the bridge remaps to the camelCase TS shape. */
interface QuantaAiSuggestArgs {
  prompt: string;
  cwd: string | null;
  /** FIX 2: caller-supplied hard deadline in milliseconds. `null` lets Rust
   *  apply `AI_SUGGEST_DEFAULT_TIMEOUT_MS` (8 s). A non-positive value is
   *  normalised to `null` here so the Rust default always wins. */
  timeout_ms: number | null;
}

/* Read-text-file command — mirrors `ipc::ReadTextFileArgs` / reply on the
   Rust side. A missing file surfaces as `content: null, missing: true` so
   callers that poll `.git/HEAD` never see a rejection for the common
   "not-in-a-repo" case. */
interface QuantaReadTextFileArgs {
  path: string;
  max_bytes: number;
}

interface QuantaReadTextFileReply {
  content: string | null;
  missing: boolean;
  truncated: boolean;
}

/* git-status command — mirrors `ipc::GitStatusArgs` / `GitStatusReply` on
   the Rust side. A null reply surfaces as "no info" (not a repo, git
   missing, timeout, etc.). */
interface QuantaGitStatusArgs {
  repo_root: string;
}

interface QuantaGitStatusReply {
  branch: string | null;
  dirty: boolean;
  ahead: number;
  behind: number;
  detached: boolean;
}

/* get-home-dir command — mirrors `ipc::GetHomeDirReply` on the Rust side.
   Returns `{ path: null }` when the host could not determine HOME. */
interface QuantaGetHomeDirReply {
  path: string | null;
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
      // Tauri now renders with native decorations (titleBarStyle: Visible +
      // decorations: true). The window manager owns drag, double-click-to-
      // maximize, and the OS context menu; the app's TitleBar widget is a
      // secondary toolbar below the real title bar.
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
      // Populated lazily: Tauri host boots reporting `false`, then flips when
      // the first `quanta_spawn_session` reply surfaces `is_wsl: true`. The
      // session-side `isWsl` flag is the authoritative per-session signal;
      // this cap is here so UI widgets that key off the host-level flag (e.g.
      // a one-shot "WSL detected" hint) can render without waiting on a
      // session mutation.
      wslEnvironment: false,
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
      const reply = await invokeStructured<QuantaSpawnReply>('quanta_spawn_session', { args });
      // Flip the host-level capability the first time a WSL session appears.
      // Once set it stays true — a mixed WSL / non-WSL mix in the same host
      // process is not a shape we support, and the cap is a glanceable hint
      // anyway. Per-session truth still lives on `isWsl` below.
      const wsl = reply.is_wsl === true;
      if (wsl) {
        // `capabilities` is declared `readonly` in the type but is the same
        // object reference held by the bridge. Mutation via index access is
        // intentional here — the cap is a write-once latch.
        (bridge.capabilities as { wslEnvironment: boolean }).wslEnvironment = true;
      }
      return {
        sessionId: reply.session_id as SessionId,
        shell: reply.shell,
        cwd: reply.cwd,
        isWsl: wsl,
      };
    },

    async write(sessionId: SessionId, data: string): Promise<void> {
      await invokeStructured('quanta_write', { sessionId, data });
    },

    async resize(sessionId: SessionId, cols: number, rows: number): Promise<void> {
      await invokeStructured('quanta_resize', { sessionId, cols, rows });
    },

    async close(sessionId: SessionId): Promise<void> {
      await invokeStructured('quanta_close', { sessionId });
    },

    async cancelBlock(sessionId: SessionId, blockId: BlockId): Promise<void> {
      // The Rust-side command already swallows idempotent errors (unknown
      // session, already-terminal block) and resolves `Ok(())`; any rejection
      // here is a genuine transport/IPC failure surfaced as a typed
      // `HostBridgeErrorThrown` the UI can branch on.
      await invokeStructured('quanta_cancel_block', { sessionId, blockId });
    },

    async pausePty(sessionId: SessionId): Promise<void> {
      // Plan 0005 Epic γ PTY flow-control. The Rust side parks the per-
      // session reader thread on a Condvar; the kernel PTY buffer fills up,
      // which transparently back-pressures the child via its write(2).
      // Rejections here are genuine IPC failures; the batcher logs and moves
      // on so a flow-control outage can never take down the data path.
      await invokeStructured('quanta_pause_pty', { args: { sessionId } });
    },

    async resumePty(sessionId: SessionId): Promise<void> {
      await invokeStructured('quanta_resume_pty', { args: { sessionId } });
    },

    async notify(options: NotifyOptions): Promise<void> {
      // Tauri host delegates to the notification plugin on the Rust side.
      // NOTE to Track β: the `tauri-plugin-notification` crate requires
      // `notification:default` in `src-tauri/capabilities/*.json`; if that
      // permission is missing the invoke rejects and we swallow to keep
      // notifications best-effort (the Web API fallback in
      // features/notifications may still succeed).
      try {
        await invokeStructured('quanta_notify', {
          title: options.title,
          body: options.body,
        });
      } catch {
        // Swallow — the UI wrapper falls through to the Web Notification API
        // when the bridge call rejects.
      }
    },

    async openInEditor(options: OpenInEditorOptions): Promise<void> {
      const args: QuantaOpenInEditorArgs = {
        path: options.path,
        line: options.line ?? null,
        column: options.column ?? null,
      };
      await invokeStructured('quanta_open_in_editor', { args });
    },

    async installShellIntegration(
      options: InstallShellIntegrationOptions,
    ): Promise<InstallShellIntegrationReply> {
      const args: QuantaInstallShellIntegrationArgs = {
        shell: options.shell,
        confirm: options.confirm ?? false,
        target_path: null,
      };
      const reply = await invokeStructured<QuantaInstallShellIntegrationReply>(
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
    },

    async uninstallShellIntegration(
      options: UninstallShellIntegrationOptions,
    ): Promise<UninstallShellIntegrationReply> {
      const args: QuantaUninstallShellIntegrationArgs = {
        shell: options.shell,
        confirm: options.confirm ?? false,
        target_path: null,
      };
      const reply = await invokeStructured<QuantaUninstallShellIntegrationReply>(
        'quanta_uninstall_shell_integration',
        { args },
      );
      return {
        targetPath: reply.target_path,
        removedRegion: reply.removed_region,
        alreadyAbsent: reply.already_absent,
        fileMissing: reply.file_missing,
        mutated: reply.mutated,
        lineCount: reply.line_count,
      };
    },

    async readTextFile(options: ReadTextFileOptions): Promise<string | null> {
      // Small, read-only helper. `.git/HEAD` polling is its first caller —
      // see `features/git-branch`. A missing file is an expected outcome
      // (cwd not inside a git repo), so the Rust side surfaces it as a
      // structured reply (`missing: true`) and we translate that to `null`
      // here. Real errors (permission denied, invalid UTF-8, file too
      // large) reject via `invokeStructured` and the caller is expected to
      // swallow and treat the path as unreadable.
      const cap =
        typeof options.maxBytes === 'number' && options.maxBytes > 0
          ? Math.floor(options.maxBytes)
          : READ_TEXT_FILE_DEFAULT_MAX_BYTES;
      const args: QuantaReadTextFileArgs = {
        path: options.path,
        max_bytes: cap,
      };
      try {
        const reply = await invokeStructured<QuantaReadTextFileReply>('quanta_read_text_file', {
          args,
        });
        if (reply.missing) return null;
        return reply.content;
      } catch {
        // The UI caller treats any rejection as "unreadable for now" and
        // retries on the next cwd change; swallowing here keeps the
        // Promise<string | null> contract at the bridge boundary.
        return null;
      }
    },

    async gitStatus(options: GitStatusOptions): Promise<GitStatus | null> {
      // Read-only "shell-out once, cache for a while" helper. See
      // `features/git-branch/read-status` for the caching/debouncing wrapper;
      // the bridge itself is a thin pass-through that normalises rejections
      // into a null return (any failure = "no info", same as the mock path).
      const args: QuantaGitStatusArgs = { repo_root: options.repoRoot };
      try {
        const reply = await invokeStructured<QuantaGitStatusReply | null>(
          'quanta_git_status',
          { args },
        );
        if (reply === null) return null;
        return {
          branch: reply.branch,
          dirty: reply.dirty,
          ahead: reply.ahead,
          behind: reply.behind,
          detached: reply.detached,
        };
      } catch {
        return null;
      }
    },

    async getHomeDir(): Promise<string | null> {
      // Thin pass-through to `quanta_get_home_dir`. A non-resolving HOME is
      // NOT an error — mirror `readTextFile`'s null convention so callers
      // can branch on the result without a try/catch. Any unexpected IPC
      // failure is swallowed and collapsed to `null` at this boundary.
      try {
        const reply = await invokeStructured<QuantaGetHomeDirReply>('quanta_get_home_dir');
        return reply.path ?? null;
      } catch {
        return null;
      }
    },

    async listCompletions(options: ListCompletionsOptions): Promise<CompletionEntry[]> {
      try {
        const args = { prefix: options.prefix, cwd: options.cwd };
        const entries = await invokeStructured<CompletionEntry[]>('quanta_list_completions', { args });
        return entries;
      } catch {
        return [];
      }
    },

    async aiSuggest(options: AiSuggestOptions): Promise<AiSuggestion> {
      // FIX 2: forward the caller's timeout. A non-positive value is treated
      // as "use the default" — we pass null so Rust applies
      // `AI_SUGGEST_DEFAULT_TIMEOUT_MS`. Positive values flow through verbatim.
      const normalizedTimeout =
        typeof options.timeoutMs === 'number' && options.timeoutMs > 0
          ? options.timeoutMs
          : null;
      const args: QuantaAiSuggestArgs = {
        prompt: options.prompt,
        cwd: options.cwd ?? null,
        timeout_ms: normalizedTimeout,
      };
      const reply = await invokeStructured<QuantaAiSuggestReply>('quanta_ai_suggest', { args });
      const result: AiSuggestion = {
        id: reply.id,
        command: reply.command,
        tier: reply.tier,
        modifiers: reply.modifiers,
        rulesetVersion: reply.ruleset_version,
        ...(reply.rationale !== null ? { rationale: reply.rationale } : {}),
      };
      return result;
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

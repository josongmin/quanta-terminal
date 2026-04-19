/**
 * `createMockHostBridge` — in-browser fallback when `window.__TAURI_INTERNALS__`
 * is unavailable (plain `pnpm dev:vite` / opening the URL in a regular browser).
 *
 * This exists so the React tree can be exercised without a Tauri webview. It
 * simulates a PTY that echoes written bytes and prints a greeting banner on
 * spawn. Not durable, not real — purely a UI-development aid.
 */

import type {
  AiSuggestOptions,
  AiSuggestion,
  BlockId,
  HostBridge,
  HostEvent,
  HostEventListener,
  InstallShellIntegrationOptions,
  InstallShellIntegrationReply,
  NotifyOptions,
  OpenInEditorOptions,
  SessionId,
  SpawnSessionOptions,
  SpawnSessionResult,
  Subscription,
  UninstallShellIntegrationOptions,
  UninstallShellIntegrationReply,
} from '@quanta/host-common';
import { MOCK_PROMPT_STRING } from '@quanta/host-common';

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function textToB64(text: string): string {
  return toB64(new TextEncoder().encode(text));
}

export function createMockHostBridge(): HostBridge {
  const listeners = new Set<HostEventListener>();
  let seq = 0;
  let currentSession: SessionId | null = null;

  const emit = (event: HostEvent): void => {
    for (const l of listeners) {
      try {
        l(event);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[quanta-mock-bridge] listener threw', err);
      }
    }
  };

  const emitData = (sessionId: SessionId, text: string): void => {
    seq += 1;
    emit({
      kind: 'pty_data',
      sessionId,
      seq,
      bytesB64: textToB64(text),
    });
  };

  return {
    capabilities: {
      nativeWindowChrome: false,
      systemNotifications: false,
      editorIntegration: false,
      windowsShellParity: false,
      embeddedDevShell: false,
    },

    ready(): Promise<void> {
      return Promise.resolve();
    },

    spawn(_options: SpawnSessionOptions): Promise<SpawnSessionResult> {
      const sessionId =
        `mock-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` as SessionId;
      currentSession = sessionId;
      // Queue a friendly greeting + prompt. setTimeout ensures consumers have
      // time to wire their onData handler after spawn() resolves.
      setTimeout(() => {
        emitData(
          sessionId,
          '\u001b[32m▌ Quanta Terminal — browser dev mode\u001b[0m\r\n' +
            '  \u001b[90mNo Tauri runtime detected — running the UI against a mock shell.\u001b[0m\r\n' +
            "  Type anything; it'll echo back. Launch with \u001b[1mpnpm dev\u001b[0m for the real shell.\r\n" +
            '\r\n' +
            MOCK_PROMPT_STRING,
        );
      }, 16);
      return Promise.resolve({
        sessionId,
        shell: '/bin/mock',
        cwd: '/tmp',
      });
    },

    write(sessionId: SessionId, data: string): Promise<void> {
      if (sessionId !== currentSession) return Promise.resolve();
      // Minimal terminal line discipline. A real PTY's kernel tty layer handles
      // all of this; we reimplement only what users notice:
      //   - `\x7f` (DEL / Backspace) → erase the last visible char with
      //     the standard `\b \b` idiom. Without this, pressing Backspace
      //     in the mock leaves ghost characters.
      //   - `\r` / `\n` → newline + fresh prompt.
      //   - `\x03` (Ctrl+C) → render `^C` and a fresh prompt.
      //   - Printable bytes → echo verbatim.
      let buf = '';
      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (code === 0x7f || code === 0x08) {
          buf += '\b \b';
        } else if (code === 0x03) {
          buf += '^C\r\n' + MOCK_PROMPT_STRING;
        } else if (ch === '\r' || ch === '\n') {
          buf += '\r\n' + MOCK_PROMPT_STRING;
        } else {
          buf += ch;
        }
      }
      if (buf.length > 0) emitData(sessionId, buf);
      return Promise.resolve();
    },

    resize(_sessionId: SessionId, _cols: number, _rows: number): Promise<void> {
      return Promise.resolve();
    },

    close(sessionId: SessionId): Promise<void> {
      if (sessionId === currentSession) {
        currentSession = null;
        emit({
          kind: 'pty_exit',
          sessionId,
          exitCode: 0,
          signal: null,
        });
      }
      return Promise.resolve();
    },

    cancelBlock(sessionId: SessionId, blockId: BlockId): Promise<void> {
      // Browser-dev mode has no sidecar and no real blocks to interrupt.
      // Logging the attempt keeps the wiring observable during UI dev
      // without surfacing a rejection — the Stop button must stay
      // idempotent for adapters that can't physically cancel anything.
      // eslint-disable-next-line no-console
      console.debug('[mock] cancelBlock', sessionId, blockId);
      return Promise.resolve();
    },

    notify(options: NotifyOptions): Promise<void> {
      // Browser-dev mode: the Web Notification API is available via the
      // wrapper in `features/notifications` — this bridge path is a fallback
      // for adapters that want to fan out to a native plugin. Log for
      // developer observability and resolve silently.
      // eslint-disable-next-line no-console
      console.debug('[mock] notify', options.title, options.body);
      return Promise.resolve();
    },

    openInEditor(options: OpenInEditorOptions): Promise<void> {
      // The mock bridge cannot actually open editors (no Tauri IPC, no shell
      // access). It logs the attempt so browser-dev sessions see that the
      // click would have been dispatched, and resolves so the UI still
      // surfaces its "Opened X" toast / visual feedback.
      // eslint-disable-next-line no-console
      console.info('[mock] would open', options.path, options.line ?? null, options.column ?? null);
      return Promise.resolve();
    },

    installShellIntegration(
      options: InstallShellIntegrationOptions,
    ): Promise<InstallShellIntegrationReply> {
      // Browser-dev mode has no dotfiles to touch. We return a canned preview
      // so the wizard can still be exercised against the mock bridge without
      // throwing. `mutated` is never true — the mock never writes to disk.
      const confirm = options.confirm ?? false;
      const snippet =
        `\n# >>> quanta shell integration >>>\n` +
        `# (mock) snippet for ${options.shell}; this host cannot install.\n` +
        `# <<< quanta shell integration <<<\n`;
      return Promise.resolve({
        targetPath: `/mock/${options.shell}rc`,
        snippet,
        alreadyInstalled: false,
        mutated: confirm ? false : false,
        lineCount: 0,
      });
    },

    uninstallShellIntegration(
      options: UninstallShellIntegrationOptions,
    ): Promise<UninstallShellIntegrationReply> {
      // Mock host has no dotfiles; return a "nothing to uninstall" reply.
      // `mutated` is never true — the mock doesn't touch disk. We return
      // `fileMissing: true` so the UI's "uninstalled" toast reports the
      // absence rather than a successful removal.
      return Promise.resolve({
        targetPath: `/mock/${options.shell}rc`,
        removedRegion: '',
        alreadyAbsent: true,
        fileMissing: true,
        mutated: false,
        lineCount: 0,
      });
    },

    aiSuggest(options: AiSuggestOptions): Promise<AiSuggestion> {
      // Browser-dev mode: canned reply. Matches the shape of the real
      // Rust-side `quanta_ai::SuggestionResponse`. Deterministic based on
      // prompt so end-to-end smoke tests are reproducible.
      //
      // FIX 2: when the caller supplies a positive `timeoutMs` we honour it
      // by racing the canned resolution against a `setTimeout` that rejects
      // with an Error whose message carries "timeout" — matching what the
      // Tauri host surfaces after `classify_ai_error` maps
      // `SuggestionProviderError::Timeout`. When `timeoutMs` is absent or
      // non-positive the canned path resolves synchronously as before, so
      // existing callers see no behavioural drift.
      const trimmed = options.prompt.trim();
      if (!trimmed) {
        return Promise.reject(new Error('aiSuggest: empty prompt'));
      }
      const lower = trimmed.toLowerCase();
      const produce = (): AiSuggestion => {
        if (lower.includes('delete') && lower.includes('everything')) {
          return {
            id: 'mock-rm-rf-root',
            command: 'rm -rf /',
            tier: 'blocked',
            modifiers: ['destructive_verb', 'recursion'],
            rulesetVersion: 1,
            rationale: 'Mocked: the classifier blocks this command.',
          };
        }
        if (lower.includes('status')) {
          return {
            id: 'mock-git-status',
            command: 'git status',
            tier: 'safe',
            modifiers: ['allowlist_match'],
            rulesetVersion: 1,
            rationale: 'Mocked: show repository status.',
          };
        }
        return {
          id: 'mock-ls',
          command: 'ls -la',
          tier: 'safe',
          modifiers: ['allowlist_match'],
          rulesetVersion: 1,
          rationale: 'Mocked: list files (default fallback).',
        };
      };
      const timeoutMs =
        typeof options.timeoutMs === 'number' && options.timeoutMs > 0
          ? options.timeoutMs
          : undefined;
      if (timeoutMs === undefined) {
        return Promise.resolve(produce());
      }
      // Both branches of the race are eager: the resolve resolves on the
      // next microtask, the reject after `timeoutMs`. With a positive
      // `timeoutMs` the mock effectively always resolves first, but the
      // structural contract is preserved so callers with a zero-ish
      // timeout observe a rejection rather than a hang.
      return Promise.race<AiSuggestion>([
        Promise.resolve(produce()),
        new Promise<AiSuggestion>((_, reject) =>
          setTimeout(
            () => reject(new Error('aiSuggest: timeout')),
            Math.max(0, timeoutMs),
          ),
        ),
      ]);
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
}

/**
 * Returns true if the current window has Tauri's IPC bridge injected. Used
 * in `main.tsx` to pick between the real Tauri bridge and the mock fallback.
 */
export function hasTauriRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  return typeof w.__TAURI_INTERNALS__ === 'object' && w.__TAURI_INTERNALS__ !== null;
}

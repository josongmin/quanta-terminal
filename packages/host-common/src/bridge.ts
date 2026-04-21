/**
 * Host bridge interfaces.
 *
 * The UI depends only on these contracts. A host package (`@quanta/host-tauri`,
 * `@quanta/host-vscode`) provides concrete implementations and injects them via
 * `window.__QUANTA_HOST__` before the React app mounts.
 *
 * Per ADR 0001:
 *   - `HostBridge`      — session/PTY lifecycle plus the event stream.
 *   - `EditorBridge`    — open/reveal/focus; null-adapter allowed in Mode B.
 *   - `WorkspaceBridge` — workspace root metadata (not needed Phase-1 skeleton).
 *
 * Everything returns plain `Promise`s; hosts implement them over their IPC
 * transport (Tauri invoke, VS Code extension messaging, etc.).
 */

import type { HostCapabilities } from './capabilities.js';
import type { BlockId, HostEvent, SessionId } from './events.js';

export interface SpawnSessionOptions {
  /** Path to the shell binary (e.g. "/bin/zsh"). Host default if omitted. */
  readonly shell?: string;
  /** Working directory to launch the shell in. Host default if omitted. */
  readonly cwd?: string;
  /** Initial PTY size. */
  readonly cols: number;
  readonly rows: number;
  /** Additional env vars to merge on top of the host default. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface SpawnSessionResult {
  readonly sessionId: SessionId;
  readonly shell: string;
  readonly cwd: string;
  /**
   * `true` when the host spawned this shell on the Linux kernel shim that
   * Windows Subsystem for Linux provides (WSL 1 / 2). The Tauri host probes
   * `/proc/version` for "Microsoft" / "WSL" tokens during spawn; see
   * `packages/host-tauri/src-tauri/src/embedded_shell::is_wsl`. Optional so
   * hosts that cannot answer (mock bridge, future third-party shells) omit
   * the field rather than asserting false.
   */
  readonly isWsl?: boolean;
}

/** Handle returned by `HostBridge.subscribe`. Idempotent unsubscribe. */
export interface Subscription {
  readonly unsubscribe: () => void;
}

export type HostEventListener = (event: HostEvent) => void;

/**
 * Options passed to `HostBridge.openInEditor`. Paths MUST be absolute — the UI
 * resolves relative paths against the session cwd before calling the bridge so
 * that hosts do not need to know which session owned the click.
 */
export interface OpenInEditorOptions {
  /** Absolute path to the file. Host MUST reject relative paths. */
  readonly path: string;
  /** 1-based line number. */
  readonly line?: number;
  /** 1-based column. */
  readonly column?: number;
}

/**
 * Shell integration install contract (ADR 0002 §Degraded Mode).
 *
 * Two-phase semantics — "typed-to-confirm":
 *   1. `confirm: false` returns a preview (`snippet`, `targetPath`,
 *      `alreadyInstalled`) WITHOUT touching the dotfile.
 *   2. `confirm: true` appends the guarded block iff it is not already
 *      present. Idempotent: a second call with the guard block already in
 *      the file is a no-op (`mutated: false`, `alreadyInstalled: true`).
 *
 * The UI (`features/shell-integration-wizard`) MUST call the command twice:
 * once to populate the preview step of the modal, once when the user clicks
 * the final Confirm button. Opening the wizard never mutates the dotfile.
 */
export type ShellKind = 'bash' | 'zsh' | 'fish';

export interface InstallShellIntegrationOptions {
  readonly shell: ShellKind;
  /**
   * Must be `true` to append the block. `false` (or omitted) runs in preview
   * mode and returns the snippet the host would have written, with no
   * filesystem mutation.
   */
  readonly confirm?: boolean;
}

export interface InstallShellIntegrationReply {
  /** Absolute path to the dotfile we previewed or mutated. */
  readonly targetPath: string;
  /** The full block (header + script + footer) that would be appended. */
  readonly snippet: string;
  /** True iff the guard block was already present when we inspected the file. */
  readonly alreadyInstalled: boolean;
  /** True only when this invocation mutated the file. */
  readonly mutated: boolean;
  /** Line count of the file after (or before, in preview mode) this call. */
  readonly lineCount: number;
}

/**
 * Inverse of {@link InstallShellIntegrationOptions}. Same two-phase
 * semantics — `confirm: false` returns the region that would be removed
 * without mutating, `confirm: true` actually strips the guarded block.
 * Idempotent: second call when the block is already gone returns
 * `alreadyAbsent: true` and does NOT mutate.
 */
export interface UninstallShellIntegrationOptions {
  readonly shell: ShellKind;
  /** `true` to actually remove the block; `false` (default) = preview only. */
  readonly confirm?: boolean;
}

export interface UninstallShellIntegrationReply {
  /** Absolute path to the dotfile we previewed or mutated. */
  readonly targetPath: string;
  /**
   * The region that was (or would be) removed, including guard markers.
   * Empty string when the block is not present.
   */
  readonly removedRegion: string;
  /** True iff the file existed but contained no guard block. */
  readonly alreadyAbsent: boolean;
  /** True iff the dotfile does not exist at all (treated as "already absent"). */
  readonly fileMissing: boolean;
  /** True only when this invocation mutated the file. */
  readonly mutated: boolean;
  /** Line count of the file AFTER this call (zero when missing / emptied). */
  readonly lineCount: number;
}

/* ------------------------------------------------------------------------ */
/*                  Structured error wire protocol (ADR P1)                  */
/* ------------------------------------------------------------------------ */

/**
 * Closed enumeration of the errors the host bridge can surface. Callers
 * switch on `.code` to branch (e.g. "show Auth re-prompt" vs "show retry
 * banner") rather than string-matching on a localised message. Every new
 * code MUST also be emitted by at least one host to avoid a UI branch that
 * is statically unreachable; the Rust side owns the set of values.
 */
export type HostBridgeErrorCode =
  | 'session-not-found'
  | 'session-unresponsive'
  | 'editor-not-found'
  | 'editor-invalid-path'
  | 'shell-integration-outside-home'
  | 'shell-integration-missing'
  | 'ai-suggest-auth-failed'
  | 'ai-suggest-rate-limited'
  | 'ai-suggest-network'
  | 'ai-suggest-timeout'
  | 'sidecar-unavailable'
  | 'bridge-internal'
  | 'unknown';

/**
 * Structured error shape returned by the Rust side. `code` is the stable
 * machine-readable selector; `userMessage` is the only string the UI is
 * allowed to render verbatim (it has been sanitised on the Rust side so it
 * does not carry file paths, stack traces, or the bare OS error text).
 */
export interface HostBridgeError {
  readonly code: HostBridgeErrorCode;
  readonly userMessage: string;
  /** Structured diagnostic context — safe to log but not display raw. */
  readonly context?: Readonly<Record<string, unknown>>;
}

/* ------------------------------------------------------------------------ */
/*  ISP sub-interfaces — use these for narrower dependency declarations      */
/* ------------------------------------------------------------------------ */

/** Core PTY lifecycle. Use when a module only needs session I/O. */
export interface SessionBridge {
  ready(): Promise<void>;
  spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult>;
  write(sessionId: SessionId, data: string): Promise<void>;
  resize(sessionId: SessionId, cols: number, rows: number): Promise<void>;
  close(sessionId: SessionId): Promise<void>;
  cancelBlock(sessionId: SessionId, blockId: BlockId): Promise<void>;
  subscribe(listener: HostEventListener): Subscription;
}

/** External URL + in-editor file opening. */
export interface ExternalActionBridge {
  openInEditor(options: OpenInEditorOptions): Promise<void>;
  openExternalUrl?(options: OpenExternalUrlOptions): Promise<void>;
}

/** Shell dotfile integration. */
export interface ShellIntegrationBridge {
  installShellIntegration(
    options: InstallShellIntegrationOptions,
  ): Promise<InstallShellIntegrationReply>;
  uninstallShellIntegration(
    options: UninstallShellIntegrationOptions,
  ): Promise<UninstallShellIntegrationReply>;
}

/** File system + git metadata access. */
export interface FileBridge {
  readTextFile(options: ReadTextFileOptions): Promise<string | null>;
  getHomeDir?(): Promise<string | null>;
  gitStatus?(options: GitStatusOptions): Promise<GitStatus | null>;
}

/** OS notification dispatch. */
export interface NotificationBridge {
  notify(options: NotifyOptions): Promise<void>;
}

/** AI command suggestion. */
export interface AiBridge {
  aiSuggest(options: AiSuggestOptions): Promise<AiSuggestion>;
}

/* ------------------------------------------------------------------------ */

/**
 * Phase-1 bridge surface. The real engine will replace this with JSON-RPC over
 * a Unix socket (see ADR 0004); the UI never sees that difference because it
 * only knows this interface.
 *
 * `openInEditor` is required (not optional) so the UI never has to type-narrow
 * before calling it — every concrete bridge (Tauri, VS Code, mock) is expected
 * to implement it. Hosts that genuinely cannot open editors (Mode B without an
 * external editor detected) should still implement the method and either:
 *   - shell out to the user's default editor (`code`, `cursor`, `$EDITOR`, …),
 *   - `open` the file with the OS handler,
 *   - or reject with an informative message the UI can surface as a toast.
 *
 * The return type is `Result<void, string>` expressed as a `Promise<void>` that
 * either resolves (success) or rejects with a human-readable message.
 */
export interface HostBridge
  extends SessionBridge,
    ExternalActionBridge,
    ShellIntegrationBridge,
    FileBridge,
    NotificationBridge,
    AiBridge {
  readonly capabilities: HostCapabilities;

  /** Announce readiness and fetch any persistent session list. */
  ready(): Promise<void>;

  /** Spawn a shell session, returning its id. */
  spawn(options: SpawnSessionOptions): Promise<SpawnSessionResult>;

  /** Write bytes to the session's stdin. UTF-8 string; host re-encodes as needed. */
  write(sessionId: SessionId, data: string): Promise<void>;

  /** Resize the PTY. Host re-sizes child process via ioctl. */
  resize(sessionId: SessionId, cols: number, rows: number): Promise<void>;

  /** Close the session and kill its child process. */
  close(sessionId: SessionId): Promise<void>;

  /**
   * Cancel a running block in a session. The sidecar is the source of truth:
   * it sends a SIGINT (or equivalent) to the block's child and emits the
   * matching `pty_exit` / `BlockCompleted` events so the UI's block store
   * transitions to `canceled` via the existing event fan-out.
   *
   * Idempotency: calling `cancelBlock` on a block that has already reached a
   * terminal state MUST resolve silently rather than reject. The UI's Stop
   * button may double-fire during a status race and we don't want a toast
   * for a no-op. Hosts that cannot cancel (mock bridge, embedded-shell dev
   * mode) resolve silently as well — the method exists on every adapter so
   * the UI never has to type-narrow before calling it.
   */
  cancelBlock(sessionId: SessionId, blockId: BlockId): Promise<void>;

  /** Subscribe to host events. Returns a subscription handle. */
  subscribe(listener: HostEventListener): Subscription;

  /**
   * Open a file at an optional line/column in the user's editor.
   *
   * Phase 3: used by the error-to-code navigation feature to make rustc/tsc/
   * python/node error paths clickable. The host picks the editor — see
   * `packages/host-tauri/src-tauri/src/ipc.rs` for the resolution order.
   *
   * Rejects with a human-readable message on failure (editor not found,
   * path rejected, spawn failed). Never throws synchronously.
   */
  openInEditor(options: OpenInEditorOptions): Promise<void>;

  /**
   * Open an external URL in the user's default browser (or associated
   * protocol handler for non-http schemes). Used by the auto-linkification
   * feature that turns plain-text URLs in block output into clickable
   * affordances — the UI prompts the user for confirmation first and then
   * delegates to this method.
   *
   * OPTIONAL. Hosts that cannot open external URLs (e.g. the browser-dev
   * mock bridge) may omit the method entirely. Callers MUST null-check
   * `bridge.openExternalUrl` before invoking it.
   *
   * Rejects with a human-readable message when the host refuses the URL
   * (blocked scheme, malformed input) or the platform open-url syscall
   * fails. Never throws synchronously.
   */
  openExternalUrl?(options: OpenExternalUrlOptions): Promise<void>;

  /**
   * Install (or preview install of) Quanta's shell integration into the
   * user's dotfile. See `InstallShellIntegrationOptions` for the two-phase
   * semantics.
   *
   * Rejects with a human-readable message when the host cannot locate the
   * dotfile or cannot write to it. Never throws synchronously.
   */
  installShellIntegration(
    options: InstallShellIntegrationOptions,
  ): Promise<InstallShellIntegrationReply>;

  /**
   * Symmetric inverse of {@link HostBridge.installShellIntegration}. Removes
   * the guarded block from the user's dotfile (or previews the region that
   * would be removed). Rejects with a {@link HostBridgeErrorThrown} (host-
   * tauri) carrying `code: 'shell-integration-outside-home'` when the target
   * resolves outside `$HOME`. Returns `alreadyAbsent: true` (no rejection)
   * when the file is missing or already has no block.
   */
  uninstallShellIntegration(
    options: UninstallShellIntegrationOptions,
  ): Promise<UninstallShellIntegrationReply>;

  /**
   * Post an OS-level notification (title + body). Used by the long-running
   * command completion detector (`features/notifications`). Hosts that
   * cannot post notifications — the mock adapter, headless dev shells —
   * resolve silently rather than reject so the UI doesn't have to branch.
   *
   * Tauri note: the host-tauri bridge routes through Tauri's notification
   * plugin which is gated by `notification:default` in
   * `src-tauri/capabilities/`. Track β owns that capabilities file; the
   * UI side only needs the method to exist on every adapter.
   */
  notify(options: NotifyOptions): Promise<void>;

  /**
   * Run `git status --porcelain=v2 --branch --no-renames` in a repository
   * root and return a structured summary (branch, dirty flag, ahead/behind
   * counts, detached-HEAD flag).
   *
   * Why a dedicated command rather than composing from `readTextFile`:
   *   - dirty-state detection without `git` itself is unreliable — we'd
   *     otherwise have to stat the working tree and compare timestamps,
   *     which is both imprecise and quadratic in repo size;
   *   - ahead/behind requires diff-ing local vs remote refs, which git
   *     computes for us in a single process spawn;
   *   - the porcelain-v2 `--branch` output is stable and machine-readable
   *     so parsing is small and well-pinned.
   *
   * Security boundary: the host MUST direct-exec `git` (no shell), MUST
   * validate `repoRoot` as an absolute existing directory containing a
   * `.git` entry, and MUST kill the child after a short timeout (2 s is
   * plenty — `git status` is dominated by the index scan and is reliably
   * sub-second even on large repos).
   *
   * Returns `null` when:
   *   - `repoRoot` is not a repo (no `.git` entry, git emits "fatal: not a
   *     git repository", etc.);
   *   - the host has no `git` binary on PATH;
   *   - the command times out;
   *   - the host simply does not support this capability (mock bridge,
   *     browser dev mode). Callers should treat `null` as "no extra info".
   *
   * Never rejects — the UI polls this on every cwd change and a rejection
   * would force every caller to swallow.
   *
   * OPTIONAL: hosts that cannot shell out (mock bridge, future
   * webview-in-sandbox) may omit the method entirely. Callers MUST null-
   * check `bridge.gitStatus` before invoking it — `readGitStatusForRepo`
   * in `features/git-branch` does this automatically.
   */
  gitStatus?(options: GitStatusOptions): Promise<GitStatus | null>;

  /**
   * Read a small UTF-8 text file from disk through the host.
   *
   * Intended for tiny metadata files the UI inspects to enrich the status
   * bar (e.g. `.git/HEAD` for the current branch). To keep the IPC surface
   * boring and safe:
   *   - reads are capped at {@link ReadTextFileOptions.maxBytes} bytes
   *     (hosts SHOULD enforce an absolute cap of 64 KiB);
   *   - the path MUST be absolute; hosts reject relative paths;
   *   - a missing file resolves to `null` (not a rejection) so pollers
   *     don't have to pattern-match ENOENT;
   *   - any other failure (I/O error, permission denied, invalid UTF-8)
   *     rejects with a human-readable message — the caller is expected to
   *     swallow it and treat the path as unreadable for now.
   *
   * Hosts that have no disk access (e.g. the mock bridge) resolve `null`
   * for every call so the UI never has to branch on `readTextFile === undefined`.
   */
  readTextFile(options: ReadTextFileOptions): Promise<string | null>;

  /**
   * Return the absolute path of the user's home directory, or `null` when the
   * host cannot determine it (mock bridge, browser-dev, cgroup-jailed
   * containers). Used by the shell-history import feature to locate
   * `~/.zsh_history` / `~/.bash_history` / `~/.config/fish/fish_history` via
   * the existing {@link HostBridge.readTextFile} surface.
   *
   * OPTIONAL. Callers MUST null-check `bridge.getHomeDir` before invoking and
   * MUST treat a `null` resolution as "home unknown, skip feature". Never
   * rejects — any host-side failure (HOME env missing, permission denied on
   * `/etc/passwd`, etc.) collapses to `null` at the wire boundary. This
   * matches the {@link HostBridge.gitStatus} null-convention and means UIs
   * can call it unconditionally and branch on the result.
   */
  getHomeDir?(): Promise<string | null>;

  /**
   * Ask the host for an AI suggestion given a natural-language prompt.
   *
   * Phase 5 (ADR 0012): the Tauri host delegates to the `quanta-ai` crate's
   * heuristic classifier + mock provider. A Phase-6 LLM plugs in behind the
   * same bridge call. The return carries both the command and its risk
   * classification so the UI never has to re-classify.
   *
   * Rejects on empty prompt or provider unavailability. The UI treats a
   * rejection as "no suggestion to show"; the `useSuggest` hook swallows
   * the rejection and clears its state so a provider outage cannot crash
   * the widget.
   */
  aiSuggest(options: AiSuggestOptions): Promise<AiSuggestion>;
}

/** Input to `HostBridge.notify`. */
export interface NotifyOptions {
  readonly title: string;
  readonly body: string;
}

/**
 * Input to `HostBridge.openExternalUrl`. The host validates scheme +
 * well-formedness before spawning the platform open-url syscall; callers
 * SHOULD already have presented the URL to the user for confirmation.
 *
 * `url` is the canonical URL string (trailing punctuation already stripped
 * by the caller). Schemes the host is expected to accept at minimum:
 * http, https, ftp, ssh, mailto, file.
 */
export interface OpenExternalUrlOptions {
  readonly url: string;
}

/**
 * Input to `HostBridge.readTextFile`. The path MUST be absolute; hosts
 * reject relative paths with an error. `maxBytes` is a caller-supplied cap
 * so a pathological large file cannot blow the IPC budget — hosts SHOULD
 * still enforce an absolute cap (64 KiB) on their side regardless of the
 * value passed here.
 */
export interface ReadTextFileOptions {
  readonly path: string;
  readonly maxBytes?: number;
}

/**
 * Input to `HostBridge.gitStatus`. The `repoRoot` MUST be an absolute path
 * that the host can stat. Hosts reject relative paths and paths containing
 * control characters / NUL bytes.
 *
 * We pass a root (not a cwd anywhere in the tree) so the host does not have
 * to walk ancestors to find `.git` — the UI already did that via the
 * existing `readGitBranchForCwd` helper and knows where the repo lives.
 */
export interface GitStatusOptions {
  readonly repoRoot: string;
}

/**
 * Result of `HostBridge.gitStatus`. Matches the small subset of
 * `git status --porcelain=v2 --branch` the UI cares about.
 *
 *   - `branch`    — name (e.g. "main") when on a branch, short sha when
 *                   detached, or `null` when the host could not determine
 *                   it (very fresh repo with no commits, weird HEAD).
 *   - `dirty`     — true when the working tree has any untracked OR
 *                   modified OR staged entry (unified "workspace is not
 *                   clean" signal; matches the `*` suffix convention in
 *                   zsh prompts).
 *   - `ahead`     — local is ahead of the configured upstream by N commits.
 *                   0 when there is no upstream or they are in sync.
 *   - `behind`    — local is behind the upstream by N commits.
 *   - `detached`  — HEAD points at a commit, not a branch.
 */
export interface GitStatus {
  readonly branch: string | null;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly detached: boolean;
}

/** Default cap applied when the caller omits `maxBytes`. 64 KiB is ample for
 *  the small metadata files (`.git/HEAD`, workspace manifests) the UI reads
 *  through this channel and still leaves plenty of headroom under the Tauri
 *  IPC string payload limit. */
export const READ_TEXT_FILE_DEFAULT_MAX_BYTES = 64 * 1024;

/** Input to `aiSuggest`. Phase 5 only uses `prompt`; `cwd` is reserved for a
 *  later phase where the classifier weighs workspace-relative paths.
 *
 *  `timeoutMs` (FIX 2): optional caller-supplied hard deadline in
 *  milliseconds. When omitted, hosts apply {@link AI_SUGGEST_DEFAULT_TIMEOUT_MS}
 *  (8 s) — strictly under the Anthropic adapter's 10 s absolute cap so the
 *  caller's deadline always wins. Shorter values let UIs fail fast
 *  (e.g. an inline completion widget) without blocking on a stuck provider.
 *  A non-positive value is treated as "use the default". */
export interface AiSuggestOptions {
  readonly prompt: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/**
 * Default `timeoutMs` applied when `AiSuggestOptions.timeoutMs` is omitted.
 * Mirrors `AI_SUGGEST_DEFAULT_TIMEOUT_MS` on the Rust side; keep the two in
 * lockstep so host + UI never disagree on how long a suggestion is allowed to
 * take. 8 s is generous for LLM-backed providers and strictly under
 * Anthropic's 10 s absolute request cap.
 */
export const AI_SUGGEST_DEFAULT_TIMEOUT_MS = 8_000;

/** Result of `aiSuggest`. Shape mirrors the `quanta-ai` crate's
 *  `SuggestionResponse` + nested `ClassifiedCommand`. */
export interface AiSuggestion {
  readonly id: string;
  readonly command: string;
  readonly tier: AiRiskTier;
  readonly modifiers: readonly string[];
  readonly rulesetVersion: number;
  readonly rationale?: string;
}

/** Four review buckets the approval UI branches on. Mirrors the Rust enum
 *  `quanta_ai::domain::RiskTier`. A change in Rust must be reflected here
 *  (and vice-versa); the classifier ruleset version makes a mismatch
 *  observable at runtime. */
export type AiRiskTier = 'safe' | 'caution' | 'destructive' | 'blocked';

/**
 * EditorBridge — file/range navigation. Mode B (Tauri) supplies a null adapter
 * when no editor is attached; Mode A implements it against the VS Code API.
 */
export interface EditorBridge {
  /** True if an editor surface is attached; false for the null adapter. */
  readonly available: boolean;

  /** Open a file at an optional line/column range. */
  openLocation(spec: EditorOpenLocation): Promise<void>;
}

export interface EditorOpenLocation {
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
}

/** The standard null editor bridge used by Mode B when no editor is attached. */
export const NULL_EDITOR_BRIDGE: EditorBridge = {
  available: false,
  async openLocation() {
    // Intentionally a no-op. The UI gates "open in editor" features on
    // `available` so this is only reached if a caller ignored the gate.
  },
};

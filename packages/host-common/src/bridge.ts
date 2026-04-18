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
import type { HostEvent, SessionId } from './events.js';

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
}

/** Handle returned by `HostBridge.subscribe`. Idempotent unsubscribe. */
export interface Subscription {
  readonly unsubscribe: () => void;
}

export type HostEventListener = (event: HostEvent) => void;

/**
 * Phase-1 bridge surface. The real engine will replace this with JSON-RPC over
 * a Unix socket (see ADR 0004); the UI never sees that difference because it
 * only knows this interface.
 */
export interface HostBridge {
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

  /** Subscribe to host events. Returns a subscription handle. */
  subscribe(listener: HostEventListener): Subscription;
}

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

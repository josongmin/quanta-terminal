/**
 * `features/navigation/open-in-editor` — dispatch a click on a detected
 * `path:line:col` to the host bridge's editor.
 *
 * Responsibilities:
 *   1. Resolve a (potentially relative) path against the session's cwd so the
 *      host only ever sees absolute paths.
 *   2. Call `HostBridge.openInEditor` and surface the result as a
 *      `Promise<NavResult>` the UI can inspect to decide whether to toast.
 *
 * The feature explicitly does NOT depend on the diagnostic parser. Path
 * detection happens at the renderer layer (`shared/lib/path-detect`) over the
 * already-decoded text, so this feature works for every command the user
 * runs, diagnostic-annotated or not.
 *
 * Cross-slice injection
 * ---------------------
 * Feature slices may depend on entities (lower layer) but not on each other.
 * The session cwd is read directly from `entities/session` — that is the same
 * pattern the `features/block/rerun` feature uses.
 */

import { useSessionStore } from '../../entities/session/index.js';
import { getHostBridge, tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { createLogger } from '../../shared/lib/logger.js';

const log = createLogger('features/navigation');

export interface OpenInEditorInput {
  /** File path as detected — may be relative, may start with `~`, may be absolute. */
  readonly path: string;
  /** 1-based line number. */
  readonly line?: number;
  /** 1-based column. */
  readonly column?: number;
  /**
   * Optional explicit cwd. When omitted we read from the session entity. Tests
   * pass an explicit value; production usually omits.
   */
  readonly cwd?: string;
}

export type OpenInEditorResult =
  | { readonly ok: true; readonly resolvedPath: string }
  | {
      readonly ok: false;
      readonly reason: 'no-bridge' | 'bridge-failed' | 'invalid-path';
      readonly error?: Error;
    };

/**
 * Returns true if `path` is absolute in a POSIX or Windows sense. We do not
 * use Node's `path` module here — the UI bundle must stay browser-safe — so
 * the check is a small regex.
 */
export function isAbsolutePath(path: string): boolean {
  if (path.length === 0) return false;
  if (path.startsWith('/')) return true; // POSIX
  // Windows drive letter: `C:\` or `C:/`.
  if (/^[A-Za-z]:[\\/]/u.test(path)) return true;
  return false;
}

/**
 * Resolve `path` against `cwd` without touching the filesystem. Handles:
 *   - `~/foo` → replaced with `$HOME` if available, otherwise returned as-is
 *     (the host will probably reject; we log once).
 *   - absolute paths → returned verbatim.
 *   - relative paths → joined against cwd with a single `/` separator.
 */
export function resolveAbsolutePath(path: string, cwd: string): string {
  if (path.startsWith('~')) {
    // `process` may not be typed in every build; use globalThis lookups. The
    // cast keeps strict-TS happy without leaking `@types/node` into the UI
    // bundle.
    const g = globalThis as {
      process?: { env?: Record<string, string | undefined> };
    };
    const home = g.process?.env?.['HOME'];
    if (home) return home + path.slice(1);
    // No `$HOME` (browser dev): leave tilde and let the host reject. We log
    // so the failure mode is self-explanatory.
    log.warn(
      'open-in-editor: could not expand ~ (no $HOME available); host may reject path',
      path,
    );
    return path;
  }
  if (isAbsolutePath(path)) return path;
  if (cwd.length === 0) return path;
  // Strip a leading `./` so we don't produce `/cwd/./foo`.
  const cleaned = path.startsWith('./') ? path.slice(2) : path;
  // Pick a separator that matches the cwd's platform convention: backslash
  // when the cwd uses backslashes (Windows), forward slash otherwise. If the
  // cwd already ends with a separator no joiner is added.
  const endsWithSep = cwd.endsWith('/') || cwd.endsWith('\\');
  const joiner = endsWithSep ? '' : cwd.includes('\\') ? '\\' : '/';
  return cwd + joiner + cleaned;
}

/**
 * Reject paths that carry control characters. The Rust side validates again,
 * but we fail fast at the UI layer so the toast shows a precise reason.
 */
export function validatePathForNav(path: string): Error | null {
  if (path.length === 0) return new Error('path is empty');
  for (let i = 0; i < path.length; i += 1) {
    const code = path.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return new Error(`path contains control character at offset ${i}`);
    }
  }
  return null;
}

/**
 * Open a detected path in the user's editor. Called from the BlockCard click
 * handler — see `widgets/block-card/BlockCard.tsx`.
 */
export async function openInEditor(input: OpenInEditorInput): Promise<OpenInEditorResult> {
  const bridge = tryGetHostBridge();
  if (!bridge) {
    log.warn('openInEditor: no HostBridge is installed');
    return { ok: false, reason: 'no-bridge' };
  }
  const validationErr = validatePathForNav(input.path);
  if (validationErr) {
    return { ok: false, reason: 'invalid-path', error: validationErr };
  }
  const cwd = input.cwd ?? useSessionStore.getState().cwd;
  const resolved = resolveAbsolutePath(input.path, cwd);
  try {
    await bridge.openInEditor({
      path: resolved,
      ...(input.line !== undefined ? { line: input.line } : {}),
      ...(input.column !== undefined ? { column: input.column } : {}),
    });
    log.info('openInEditor: opened', resolved, input.line, input.column);
    return { ok: true, resolvedPath: resolved };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn('openInEditor: bridge rejected', error.message);
    return { ok: false, reason: 'bridge-failed', error };
  }
}

/** Thin wrapper that throws on no-bridge — useful for call sites that want to
 *  fail-fast during development. */
export async function openInEditorOrThrow(input: OpenInEditorInput): Promise<string> {
  // Deliberately use `getHostBridge` so we throw on missing bridge.
  getHostBridge();
  const result = await openInEditor(input);
  if (!result.ok) throw result.error ?? new Error(`openInEditor failed: ${result.reason}`);
  return result.resolvedPath;
}

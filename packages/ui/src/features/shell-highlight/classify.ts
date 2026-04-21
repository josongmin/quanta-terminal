/**
 * classify — decides whether a command name resolves to something known.
 *
 * "Known" means one of:
 *   1. It appears in the built-in allowlist of ~50 common Unix/devtool names.
 *   2. It has been run before in the user's local history (the block store
 *      serves as our history source — see features/autosuggest/history-source).
 *
 * Case sensitivity: commands are case-sensitive on Unix (`Ls` is not `ls`),
 * so the allowlist lookup is a strict Set.has. History matching is also
 * case-sensitive — if the user ran `My-Tool` before, they should see `My-Tool`
 * resolve to "known" but `my-tool` to "unknown" until they actually run it.
 *
 * We DO strip a leading `./` / `../` / `/` prefix when classifying, because
 * `./my-script` is the user invoking a local binary they clearly know about;
 * any path-like invocation is classified as known. The tokenizer already
 * labels path-like args as `path`, so this helper only runs against the
 * first word which the tokenizer has labelled `command`.
 */

/** Default allowlist of commonly-known commands. Kept at ~50 entries —
 *  covers shell builtins, major devtool binaries, and classic Unix utilities.
 *  Add sparingly: the point is to avoid painting common commands red when a
 *  user has a fresh history. */
export const DEFAULT_KNOWN_COMMANDS: ReadonlySet<string> = new Set<string>([
  // shell builtins / navigation
  'cd', 'ls', 'pwd', 'echo', 'exit', 'export', 'source', 'alias', 'unalias',
  'which', 'type', 'history', 'jobs', 'kill', 'true', 'false',
  // file ops
  'cat', 'less', 'more', 'head', 'tail', 'cp', 'mv', 'rm', 'mkdir', 'rmdir',
  'ln', 'touch', 'chmod', 'chown', 'find', 'locate', 'stat', 'du', 'df',
  // text processing
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed', 'sort', 'uniq', 'cut',
  'tr', 'wc', 'diff', 'patch', 'jq', 'xargs',
  // networking
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'ping', 'nc', 'dig', 'nslookup',
  'ifconfig', 'ip',
  // dev ecosystem
  'git', 'gh', 'hub', 'svn', 'hg',
  'make', 'cmake', 'ninja', 'gcc', 'g++', 'clang', 'clang++', 'rustc',
  'cargo', 'go', 'node', 'deno', 'bun', 'python', 'python3', 'pip', 'pip3',
  'npm', 'pnpm', 'yarn', 'npx',
  'docker', 'podman', 'kubectl', 'helm', 'minikube', 'terraform',
  // editors
  'vim', 'nvim', 'vi', 'nano', 'emacs', 'code', 'subl',
  // misc
  'sudo', 'doas', 'env', 'man', 'clear', 'reset', 'tmux', 'screen', 'htop',
  'top', 'ps', 'open', 'pbcopy', 'pbpaste', 'time',
]);

export interface ClassifyArgs {
  readonly knownCommands?: ReadonlySet<string>;
  /** Command strings already run by the user (history). Case-sensitive. */
  readonly historyCommands?: ReadonlySet<string>;
}

export type Classification = 'known' | 'unknown';

/**
 * Classify a command token. Empty input → 'unknown' (we never paint empty
 * text, but the caller may pass '' after stripping so keep the branch
 * explicit).
 */
export function classifyCommand(
  cmd: string,
  { knownCommands = DEFAULT_KNOWN_COMMANDS, historyCommands }: ClassifyArgs = {},
): Classification {
  if (cmd.length === 0) return 'unknown';
  // Pathy invocation: `./foo`, `/usr/bin/bar`, `../tool` — user is directly
  // targeting a file, classify as known (the tokenizer already paints these
  // as `path`, not `command`, but if a caller forces a classify() here we
  // return 'known' rather than flash red).
  if (cmd.startsWith('./') || cmd.startsWith('../') || cmd.startsWith('/') || cmd.startsWith('~')) {
    return 'known';
  }
  if (knownCommands.has(cmd)) return 'known';
  if (historyCommands && historyCommands.has(cmd)) return 'known';
  return 'unknown';
}

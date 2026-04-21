/**
 * Block export — render one block into a clipboard-friendly string.
 *
 * Three formats:
 *   - `markdown`: command as an H2 heading, output in a triple-backtick code
 *     fence (best-effort language hint inferred from the command), metadata
 *     footer with exit code and duration.
 *   - `json`: full block entity serialized to JSON — output chunks are
 *     encoded as a single base64 string so the consumer can round-trip raw
 *     bytes without losing NUL / high-bit characters.
 *   - `text`: plain "command\n<output>" with ANSI escape sequences stripped.
 *
 * Why this file lives in `features/block`:
 *   - The shape of the block entity is owned by `entities/block`; this
 *     feature composes a read over that shape into a serialized view.
 *   - Exporting is strictly derivable from store state — no side effects
 *     beyond returning a string. The widget adapter (BlockCard) is the
 *     place that does the clipboard write + toast.
 */

import { concatChunks, useBlockStore, type Block, type BlockStatus } from '../../entities/block/index.js';
import { stripAnsi } from '../../shared/lib/ansi-parser/index.js';

export type ExportFormat = 'markdown' | 'json' | 'text';

const DECODER = /* @__PURE__ */ new TextDecoder('utf-8', { fatal: false });

// `stripAnsi` lives in `shared/lib/ansi-parser/strip` so the renderer, copy,
// diff, history-search and export paths share one implementation. Re-exported
// here for backwards compatibility with existing callers / tests.
export { stripAnsi };

/**
 * Best-effort language hint from the command's first token. Used as the
 * info string on a markdown fenced code block. Returns `''` when nothing
 * confident maps — markdown treats an empty info string as "plain".
 */
export function inferCodeFenceLang(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) return '';
  const firstToken = trimmed.split(/\s+/u)[0] ?? '';
  // Strip shell env prefixes ("FOO=bar baz" → "baz") — crude but covers the
  // common case where users inline an env var before the command.
  const afterEnv = firstToken.includes('=')
    ? (trimmed.split(/\s+/u).find((t) => !t.includes('=')) ?? firstToken)
    : firstToken;
  const lower = afterEnv.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  switch (base) {
    case 'node':
    case 'nodejs':
      return 'javascript';
    case 'python':
    case 'python3':
    case 'py':
      return 'python';
    case 'ruby':
    case 'irb':
      return 'ruby';
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'dash':
      return 'bash';
    case 'ts-node':
    case 'tsx':
      return 'typescript';
    case 'psql':
    case 'sqlite3':
    case 'mysql':
      return 'sql';
    case 'cargo':
    case 'rustc':
      return 'rust';
    case 'go':
      return 'go';
    default:
      return '';
  }
}

function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function computeDuration(block: Block): number {
  const end = block.completedAt ?? Date.now();
  return Math.max(0, end - block.startedAt);
}

function statusSummary(status: BlockStatus): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'canceled':
      return 'canceled';
    case 'error':
      return 'error';
  }
}

function decodeOutput(block: Block): string {
  if (block.outputChunks.length === 0) return '';
  return DECODER.decode(concatChunks(block.outputChunks));
}

/**
 * Encode output chunks into a single base64 string for JSON export. We
 * concatenate first so the consumer can round-trip exactly one `Uint8Array`
 * rather than having to re-join an array of base64 strings.
 */
function outputToBase64(block: Block): string {
  if (block.outputChunks.length === 0) return '';
  const all = concatChunks(block.outputChunks);
  // Chunked charCode to avoid the "Maximum call stack" error on very large
  // outputs with `String.fromCharCode(...big)`.
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < all.byteLength; i += CHUNK) {
    const slice = all.subarray(i, Math.min(i + CHUNK, all.byteLength));
    binary += String.fromCharCode(...slice);
  }
  if (typeof btoa === 'function') return btoa(binary);
  // Node fallback for SSR / non-browser test runners. vitest's jsdom exposes
  // `btoa`, but guard anyway.
  const g = globalThis as typeof globalThis & {
    Buffer?: { from: (s: string, enc: string) => { toString: (enc: string) => string } };
  };
  if (g.Buffer) return g.Buffer.from(binary, 'binary').toString('base64');
  throw new Error('exportBlockAs: no base64 encoder available');
}

export function exportAsMarkdown(block: Block): string {
  const lang = inferCodeFenceLang(block.command);
  const decoded = decodeOutput(block);
  const stripped = stripAnsi(decoded);
  const trimmed = stripped.endsWith('\n') ? stripped.slice(0, -1) : stripped;
  const duration = formatDurationMs(computeDuration(block));
  const exitLabel = block.exitCode === null ? 'n/a' : String(block.exitCode);
  const statusLabel = statusSummary(block.status);
  const lines: string[] = [];
  lines.push(`## \`${block.command}\``);
  lines.push('');
  lines.push('```' + lang);
  lines.push(trimmed);
  lines.push('```');
  lines.push('');
  lines.push(`_exit ${exitLabel} · ${duration} · ${statusLabel}_`);
  if (block.errorMessage) {
    lines.push('');
    lines.push(`> error: ${block.errorMessage}`);
  }
  return lines.join('\n');
}

/**
 * Selection-aware copy:
 *   - `selection === null`      → full block: H3 heading with the command +
 *                                 a `shell` code fence around the stripped,
 *                                 CR-rewritten output.
 *   - `{ start, end }` range    → selection only: code fence only (no heading),
 *                                 sliced out of the *rendered* plain-text
 *                                 projection so offsets line up with what the
 *                                 user saw on screen.
 *
 * The output always uses the `shell` language hint (unlike `exportAsMarkdown`,
 * which infers from the command's first token). This matches the "copy output
 * of a terminal" mental model — `shell` is what chat UIs/markdown renderers
 * use for generic shell sessions.
 *
 * Rendering parity with the BlockCard body (see `carriageReturnRewrites` on
 * `AnsiOutput`): a bare `\r` truncates back to the start of the current line.
 * Performing this rewrite AFTER the ANSI strip means SGR-wrapped redraws
 * (e.g. zsh ZLE) collapse to only the final state, matching the visible UI.
 */
export function renderBlockPlainText(block: Block): string {
  const decoded = decodeOutput(block);
  const stripped = stripAnsi(decoded);
  let out = '';
  let lineStart = 0;
  for (const ch of stripped) {
    if (ch === '\n') {
      out += ch;
      lineStart = out.length;
      continue;
    }
    if (ch === '\r') {
      out = out.slice(0, lineStart);
      continue;
    }
    out += ch;
  }
  return out;
}

export interface SelectionRange {
  readonly start: number;
  readonly end: number;
}

export function exportAsMarkdownSelection(
  block: Block,
  selection: SelectionRange | null,
): string {
  const LANG = 'shell';
  const rendered = renderBlockPlainText(block);
  const full = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;

  if (selection === null) {
    const lines: string[] = [];
    lines.push(`### \`${block.command}\``);
    lines.push('');
    lines.push('```' + LANG);
    lines.push(full);
    lines.push('```');
    return lines.join('\n');
  }

  const a = Math.max(0, Math.min(selection.start, selection.end));
  const b = Math.max(0, Math.max(selection.start, selection.end));
  const sliced = rendered.slice(a, Math.min(b, rendered.length));
  const body = sliced.endsWith('\n') ? sliced.slice(0, -1) : sliced;
  return ['```' + LANG, body, '```'].join('\n');
}

export function exportAsJson(block: Block): string {
  const payload = {
    id: block.id,
    sessionId: block.sessionId,
    command: block.command,
    cwd: block.cwd,
    status: block.status,
    startedAt: block.startedAt,
    completedAt: block.completedAt,
    durationMs: computeDuration(block),
    exitCode: block.exitCode,
    errorMessage: block.errorMessage,
    pinned: block.pinned,
    collapsed: block.collapsed,
    rerunOfId: block.rerunOfId,
    outputBytesB64: outputToBase64(block),
    outputChunkCount: block.outputChunks.length,
  };
  return JSON.stringify(payload, null, 2);
}

export function exportAsText(block: Block): string {
  const decoded = decodeOutput(block);
  const stripped = stripAnsi(decoded);
  const out = stripped.endsWith('\n') ? stripped : stripped + '\n';
  return `${block.command}\n${out}`;
}

/**
 * Render the block with the given id as a string in the given format.
 * Returns `null` when the block cannot be found — widget callers surface a
 * toast; tests observe the sentinel directly.
 */
export function exportBlockAs(blockId: string, format: ExportFormat): string | null {
  const block = useBlockStore.getState().entities[blockId];
  if (!block) return null;
  switch (format) {
    case 'markdown':
      return exportAsMarkdown(block);
    case 'json':
      return exportAsJson(block);
    case 'text':
      return exportAsText(block);
  }
}

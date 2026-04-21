/**
 * repl-driver — pushes a `repl` layer when a known REPL's primary prompt is
 * observed in the byte stream. Exits when we see a shell prompt return or
 * the REPL's typical exit marker.
 *
 * Supported REPLs (per P1-D §D4):
 *   - python: `>>> ` primary, `... ` continuation
 *   - node:   `> `    primary, `... ` continuation
 *   - psql:   `<dbname>=# `, `<dbname>=> `
 *   - ruby:   `irb(main):001:0> `
 *
 * We use a simple "line mode" heuristic:
 *   1. Track the last line written to the terminal (bytes-only, no grid).
 *   2. When a full line matching a REPL-primary pattern appears, push the
 *      `repl` layer with `hints.replShell = <kind>`.
 *   3. When a line matching a shell-prompt pattern appears (basic `$ ` or
 *      `# ` at end of line), pop the repl layer.
 *
 * Because the heuristic is line-oriented, the driver is tolerant of ANSI
 * styling — we strip CSI sequences before matching.
 *
 * Input policy for the repl layer:
 *   - `line_edit` — the REPL accepts line-oriented input; the UI can wire
 *     readline bindings instead of raw passthrough.
 *   - mouse: `dropped` — REPLs rarely care about mouse.
 *   - renderHint: `ghost` — composer surfaces REPL affordances (P1-G).
 */

import type { Driver, ModeStackHandle } from './types.js';
import type { ModeLayerHints } from '../mode-stack-store.js';

type Repl = NonNullable<ModeLayerHints['replShell']>;

interface PromptPattern {
  readonly kind: Repl;
  readonly primary: RegExp;
}

const PROMPTS: readonly PromptPattern[] = [
  { kind: 'python', primary: /^>>> ?$/ },
  { kind: 'node', primary: /^> ?$/ },
  // psql default "db=#" (superuser) or "db=>" (regular). We allow any
  // non-empty db name token.
  { kind: 'psql', primary: /^[\w-]+=[#>] ?$/ },
  { kind: 'ruby', primary: /^irb\([^)]+\):\d+:\d+> ?$/ },
];

// Matches the common shell prompt trailing chars: `$`, `#`, `%` (zsh),
// `>` (nushell / fish-ish) — followed by optional single space. We
// additionally require a `@` or cwd-like run earlier on the line to
// avoid confusing single-char output lines with prompts.
const SHELL_PROMPT = /(?:[@~/\w-][ \w~/-]*)?\s*[$#%>] ?$/;

/** Strip CSI / OSC sequences so we only match on the visible prompt text. */
function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '') // DCS
    .replace(/\x1b[@-_]/g, ''); // 2-byte escapes
}

export interface ReplDriverOptions {
  readonly stack: ModeStackHandle;
}

export function createReplDriver(opts: ReplDriverOptions): Driver {
  const { stack } = opts;
  let layerId: string | null = null;
  let currentKind: Repl | null = null;
  let lineBuf = '';

  const push = (kind: Repl): void => {
    if (layerId !== null && currentKind === kind) return;
    if (layerId !== null) stack.pop(layerId);
    currentKind = kind;
    layerId = stack.push({
      kind: 'repl',
      hints: { replShell: kind },
      inputPolicy: 'line_edit',
      mousePolicy: 'dropped',
      renderHint: 'ghost',
    });
  };

  const pop = (): void => {
    if (layerId !== null) {
      stack.pop(layerId);
      layerId = null;
      currentKind = null;
    }
  };

  const evaluate = (rawLine: string): void => {
    const line = stripAnsi(rawLine);
    // Walk known REPL prompts first; a match wins over the shell-prompt
    // regex (because `>>> ` and `mydb=# ` would otherwise also satisfy
    // SHELL_PROMPT's trailing-char fallback).
    for (const { kind, primary } of PROMPTS) {
      if (primary.test(line)) {
        push(kind);
        return;
      }
    }
    // Only pop if we're in a repl and the line looks like a shell prompt.
    if (layerId !== null && SHELL_PROMPT.test(line)) {
      pop();
    }
  };

  return {
    feed(bytes) {
      const chunk = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      for (let i = 0; i < chunk.length; i += 1) {
        const ch = chunk[i];
        if (ch === '\n' || ch === '\r') {
          evaluate(lineBuf);
          lineBuf = '';
        } else {
          // Cap buffer so pathological long lines don't eat memory.
          if (lineBuf.length < 512) lineBuf += ch;
        }
      }
      // ALSO evaluate the in-progress line: REPL prompts don't end with a
      // newline — they're the last thing printed before the shell waits for
      // input. A `>>> ` at the tail of the stream must still trigger.
      evaluate(lineBuf);
    },
    dispose() {
      pop();
      lineBuf = '';
    },
  };
}

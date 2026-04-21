/**
 * Paste-safety heuristics.
 *
 * When the user pastes text into the composer OR directly into the PTY (via
 * bracketed paste), we run this analyzer over the payload FIRST and surface
 * a confirmation dialog for anything that smells dangerous.
 *
 * Scope
 * -----
 * Fixed heuristic list — no user-configurable patterns in Phase 1. False
 * positives are preferable to false negatives: the worst case of a false
 * positive is an annoying confirm dialog; a false negative can let a user
 * paste-execute `rm -rf /` into their shell.
 *
 * Levels
 * ------
 * - `safe`   — trivial single-line paste, nothing interesting.
 * - `warn`   — multi-line OR very large OR contains several suspect tokens
 *              that are not outright dangerous.
 * - `danger` — contains a pattern we consider unambiguously destructive (rm
 *              -rf, curl | sh, sudo, fork bomb).
 *
 * Callers treat `warn` and `danger` identically at the UI layer (both pop
 * the confirmation dialog); the distinction drives only the wording and the
 * default-focused button (Cancel for danger, Paste-Anyway for warn).
 */

export type PasteRiskLevel = 'safe' | 'warn' | 'danger';

export interface PasteAnalysis {
  readonly level: PasteRiskLevel;
  /** Human-readable reason strings ordered most-severe-first. */
  readonly reasons: readonly string[];
  /** Line count (counts `\n` + 1, matches user intuition). */
  readonly lineCount: number;
  /** Total length in UTF-16 code units. */
  readonly length: number;
}

/**
 * Returns true when the text contains an `rm` invocation that has both the
 * `-r`/`-R` (recursive) and `-f` (force) flags, regardless of whether they
 * appear as a combined flag cluster (`-rf`, `-fr`) or as separate arguments
 * (`-r -f`, `-r --no-preserve-root -f`, etc.).
 *
 * We split each shell-word sequence (delimited by `;`, `|`, `&`, or `\n`)
 * into tokens and check only the argument list that follows an `rm` word-
 * boundary, so that a bare mention of "rm" in prose doesn't trigger it.
 */
function hasRmRf(text: string): boolean {
  // Split into individual "commands" at common shell separators.
  const segments = text.split(/[;|&\n]+/u);
  for (const seg of segments) {
    const tokens = seg.trim().split(/\s+/u);
    // Find the `rm` token (case-insensitive for completeness, though `rm` is
    // always lowercase in practice).
    const rmIdx = tokens.findIndex((t) => /^rm$/iu.test(t));
    if (rmIdx === -1) continue;
    // Gather all flag tokens after `rm`.
    const flags = tokens.slice(rmIdx + 1).filter((t) => t.startsWith('-'));
    // Flatten all flag characters (handles both `-rf` and `-r -f`).
    const allChars = flags.join('').toLowerCase();
    if (allChars.includes('r') && allChars.includes('f')) return true;
  }
  return false;
}

const DANGER_PATTERNS: ReadonlyArray<{
  readonly test: (text: string) => boolean;
  readonly reason: string;
}> = [
  // rm -rf / rm -r -f (combined or split flags)
  {
    test: hasRmRf,
    reason: 'Contains `rm -rf` — recursive delete',
  },
  {
    test: (t) => /\bcurl\s+[^|]*\|\s*(sh|bash|zsh)\b/i.test(t),
    reason: 'Pipes `curl` output into a shell — executes remote code',
  },
  {
    test: (t) => /\bwget\s+[^|]*\|\s*(sh|bash|zsh)\b/i.test(t),
    reason: 'Pipes `wget` output into a shell — executes remote code',
  },
  { test: (t) => /\bsudo\s/i.test(t), reason: 'Contains `sudo` — elevated privileges' },
  // Classic fork bomb: `:(){ :|:& };:`  — we match the defining shape
  // without requiring exact whitespace.
  { test: (t) => /:\(\)\s*\{[^}]*\}\s*;?\s*:/.test(t), reason: 'Looks like a fork bomb' },
];

/** Thresholds for the "very long" heuristic. */
const MAX_CHARS = 10_000;
const MAX_LINES = 200;

/**
 * Analyze a paste payload and decide whether the composer / PTY should
 * prompt before accepting it.
 */
export function analyze(text: string): PasteAnalysis {
  const length = text.length;
  // Count lines as `\n` + 1, but treat an empty string as 0 lines.
  let newlines = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 10 /* \n */ || ch === 13 /* \r */) newlines += 1;
  }
  const lineCount = length === 0 ? 0 : newlines + 1;

  const reasons: string[] = [];
  let level: PasteRiskLevel = 'safe';

  // Danger patterns come first so their reasons lead the list.
  for (const p of DANGER_PATTERNS) {
    if (p.test(text)) {
      reasons.push(p.reason);
      level = 'danger';
    }
  }

  // Multi-line pastes are classified as `warn` (or stay `danger` if a danger
  // pattern already fired). Multi-line is by itself a concern because most
  // shells execute each line on receipt.
  if (newlines > 0) {
    reasons.push(
      `Multi-line paste (${lineCount} lines) — each line auto-executes in shells`,
    );
    if (level !== 'danger') level = 'warn';
  }

  if (length > MAX_CHARS) {
    reasons.push(`Very long paste (${length.toLocaleString()} characters)`);
    if (level !== 'danger') level = 'warn';
  }

  if (lineCount > MAX_LINES) {
    reasons.push(`Very large paste (${lineCount.toLocaleString()} lines)`);
    if (level !== 'danger') level = 'warn';
  }

  return {
    level,
    reasons,
    lineCount,
    length,
  };
}

/** Convenience: true when the analyzer thinks the paste should be confirmed
 *  by the user before insertion. The UI layer uses this as its single gate. */
export function needsConfirmation(analysis: PasteAnalysis): boolean {
  return analysis.level !== 'safe';
}

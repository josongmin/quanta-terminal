/**
 * suggestCorrection — Warp-style "did you mean?" ranking for commands that
 * exited with 127 (command not found).
 *
 * Pipeline
 * --------
 * 1. Gate: the input must be a SINGLE token. Anything containing whitespace,
 *    pipes, redirections, or subshell markers is rejected outright. Otherwise
 *    `make foo` would tempt us into suggesting "make" when the user meant
 *    `make` with a typo'd argument — a worse UX than silence.
 * 2. Hard-coded typo map. A small, uncontroversial list of common finger-slip
 *    corrections (`gti → git`, `lls → ls`, `sl → ls`, `ehco → echo`). These
 *    win over history because they're more intentional — we KNOW the user
 *    meant the canonical form. Returns `confidence: 'high'`.
 * 3. History matches scoped to the same `cwd`, with Levenshtein distance ≤ 2.
 *    Ranked by (distance asc, runCount desc, recency desc).
 *    Returns `confidence: 'medium'` (distance 2) or `'high'` (distance 1).
 * 4. History matches across all cwds, distance ≤ 1. Tightened threshold
 *    because cross-directory hits lack the workspace-specific confidence
 *    signal. Returns `confidence: 'medium'`.
 * 5. Nothing in any bucket → returns `null`.
 *
 * Scope guardrails
 * ----------------
 * No network calls, no AI suggestions — `features/ai-suggest/` owns those
 * paths separately. This module is a deterministic, in-memory helper whose
 * output must render instantly below a failed block without waiting.
 */

import { levenshtein } from './levenshtein.js';

/**
 * Common finger-slip corrections. Kept short and high-confidence — every
 * entry should map a clearly-typo'd form to a single canonical command.
 * Locale-specific corrections are OUT of scope; everything here is a
 * POSIX / developer-tooling name that's the same across every English
 * keyboard layout. When in doubt, leave it out — a wrong "did you mean"
 * is worse than no hint.
 */
export const TYPO_MAP: Readonly<Record<string, string>> = Object.freeze({
  // Finger-slip transpositions
  gti: 'git',
  sl: 'ls',
  lls: 'ls',
  lss: 'ls',
  cd: 'cd', // no-op — here so callers can see a hit-set without surprise
  ehco: 'echo',
  ecoh: 'echo',
  // Doubled-letter slips
  mkae: 'make',
  maek: 'make',
  // Common CLI typos
  pythoon: 'python',
  pythn: 'python',
  pyhton: 'python',
  nom: 'npm',
  npn: 'npm',
  nmp: 'npm',
  pnmp: 'pnpm',
  pnpn: 'pnpm',
  // Kubernetes / container tooling
  kubctl: 'kubectl',
  kuebctl: 'kubectl',
  docekr: 'docker',
  dokcer: 'docker',
  // Text utilities
  grpe: 'grep',
  grpep: 'grep',
  catt: 'cat',
  // Misc
  clera: 'clear',
  exti: 'exit',
  quti: 'quit',
  vmi: 'vim',
  nnao: 'nano',
});

// Strip the trivial self-mapping `cd → cd` for the lookup. Kept in the
// exported map to document the "identity entries are fine" invariant but
// filtered at runtime so it never wins over a real suggestion.
const TYPO_LOOKUP: ReadonlyMap<string, string> = new Map(
  Object.entries(TYPO_MAP).filter(([k, v]) => k !== v),
);

/** The source of the correction — surfaces to the UI for badge/styling. */
export type CorrectionSource = 'typo' | 'history' | 'path-hint';

export interface Correction {
  readonly suggested: string;
  readonly confidence: 'high' | 'medium';
  readonly source: CorrectionSource;
}

/** History entry for suggestion ranking. Matches the shape used elsewhere
 *  (features/autosuggest/suggest.ts) so callers can reuse their existing
 *  history index. We only read `command` / `cwd` / `lastRunAt` / `runCount`. */
export interface CorrectionHistoryEntry {
  readonly command: string;
  readonly cwd: string;
  readonly lastRunAt: number;
  readonly runCount: number;
}

export interface SuggestCorrectionArgs {
  /** The command that failed — raw user text. Tokenization happens inside. */
  readonly command: string;
  /** Working directory of the failed block; drives the same-cwd boost. */
  readonly cwd: string;
  /** Known history entries. Caller decides the upstream scoping. */
  readonly history: readonly CorrectionHistoryEntry[];
}

/**
 * Test whether a raw command is a single token suitable for correction.
 * We look at the entire string rather than `command.split(' ')[0]` because
 * even `make foo` with a leading typo has arguments the correction map
 * doesn't understand — the "did you mean `ls`?" UX makes no sense when the
 * user is carrying args through.
 *
 * Rejects: whitespace, pipes, redirections, quoting, command separators,
 * subshells, variable expansions. Accepts ASCII identifiers, dots, hyphens,
 * plus-signs — everything a normal command name can legitimately contain.
 */
export function isSingleToken(command: string): boolean {
  const trimmed = command.trim();
  if (trimmed.length === 0) return false;
  // Quickest reject: any whitespace inside the trimmed form means multi-token.
  if (/\s/u.test(trimmed)) return false;
  // Reject control / shell meta characters. This list is intentionally
  // permissive on identifier chars and strict on anything the shell would
  // interpret (pipes, redirections, subshells, quoting, globs).
  if (/[|&;<>()`$"'*?\\[\]{}!~#=,]/u.test(trimmed)) return false;
  return true;
}

function normalizeCase(s: string): string {
  return s.toLowerCase();
}

/**
 * Rank history entries by similarity to `token` within `threshold` distance.
 * Same-cwd entries are returned first; tiebreakers are run-count and recency.
 *
 * Filters out exact matches (we don't suggest the user rerun what they
 * already ran) and equal-token-distinct-arguments (history stores the FULL
 * command; we compare the first whitespace-free token to the failed token).
 */
function rankHistoryMatches(
  token: string,
  cwd: string,
  history: readonly CorrectionHistoryEntry[],
  threshold: number,
  sameCwdOnly: boolean,
): CorrectionHistoryEntry | null {
  const lowerToken = normalizeCase(token);
  interface Scored {
    readonly entry: CorrectionHistoryEntry;
    readonly distance: number;
    readonly firstToken: string;
    readonly sameCwd: boolean;
  }
  const candidates: Scored[] = [];
  for (const entry of history) {
    if (entry.command.length === 0) continue;
    // Extract the first token — history entries may or may not have args.
    // We only correct to single-token commands, so the history suggestion
    // must be "use this other bare command", not "use this command with
    // these arguments". Entries whose first token differs from the full
    // command (i.e. have args) are eligible, but we only surface the FIRST
    // token in the correction UI.
    const firstRaw = entry.command.split(/\s+/u, 2)[0] ?? '';
    if (firstRaw.length === 0) continue;
    const firstToken = normalizeCase(firstRaw);
    if (firstToken === lowerToken) continue; // exact match — don't suggest
    const sameCwd = entry.cwd === cwd;
    if (sameCwdOnly && !sameCwd) continue;
    const distance = levenshtein(firstToken, lowerToken, threshold);
    if (distance > threshold) continue;
    if (distance === 0) continue; // safety: shouldn't happen after exact filter
    candidates.push({ entry, distance, firstToken, sameCwd });
  }
  if (candidates.length === 0) return null;
  // Merge by first-token so ranking considers the best-per-command across
  // possibly many history hits (each with its own runCount / recency).
  const byToken = new Map<
    string,
    { entry: CorrectionHistoryEntry; distance: number; runCount: number; lastRunAt: number; sameCwd: boolean }
  >();
  for (const c of candidates) {
    const prev = byToken.get(c.firstToken);
    if (!prev) {
      byToken.set(c.firstToken, {
        entry: c.entry,
        distance: c.distance,
        runCount: c.entry.runCount,
        lastRunAt: c.entry.lastRunAt,
        sameCwd: c.sameCwd,
      });
    } else {
      byToken.set(c.firstToken, {
        entry: prev.sameCwd ? prev.entry : c.sameCwd ? c.entry : prev.entry,
        distance: Math.min(prev.distance, c.distance),
        runCount: prev.runCount + c.entry.runCount,
        lastRunAt: Math.max(prev.lastRunAt, c.entry.lastRunAt),
        sameCwd: prev.sameCwd || c.sameCwd,
      });
    }
  }
  const merged = [...byToken.values()];
  merged.sort((a, b) => {
    // same-cwd wins absolutely
    if (a.sameCwd !== b.sameCwd) return a.sameCwd ? -1 : 1;
    if (a.distance !== b.distance) return a.distance - b.distance;
    if (a.runCount !== b.runCount) return b.runCount - a.runCount;
    return b.lastRunAt - a.lastRunAt;
  });
  return merged[0]?.entry ?? null;
}

/**
 * Compute a `Correction` for a failed command, or `null` when no confident
 * suggestion can be offered. See the module docblock for the pipeline.
 */
export function suggestCorrection(args: SuggestCorrectionArgs): Correction | null {
  const { command, cwd, history } = args;
  if (!isSingleToken(command)) return null;
  const token = command.trim();
  const lower = normalizeCase(token);

  // Step 1 — typo map. Case-insensitive lookup; suggestion is the canonical
  // form (which may itself be lower- or mixed-case depending on the map
  // entry). An exact identity (`cd → cd`) is filtered from the lookup so
  // unchanged commands don't produce a no-op suggestion.
  const typo = TYPO_LOOKUP.get(lower);
  if (typo !== undefined && typo !== lower) {
    return { suggested: typo, confidence: 'high', source: 'typo' };
  }

  // Step 2 — same-cwd history, distance ≤ 2.
  const inCwd = rankHistoryMatches(token, cwd, history, 2, true);
  if (inCwd !== null) {
    const firstRaw = inCwd.command.split(/\s+/u, 2)[0] ?? '';
    if (firstRaw.length > 0) {
      const distance = levenshtein(normalizeCase(firstRaw), lower, 2);
      return {
        suggested: firstRaw,
        confidence: distance <= 1 ? 'high' : 'medium',
        source: 'history',
      };
    }
  }

  // Step 3 — cross-cwd history, distance ≤ 1. Tightened threshold.
  const crossCwd = rankHistoryMatches(token, cwd, history, 1, false);
  if (crossCwd !== null) {
    const firstRaw = crossCwd.command.split(/\s+/u, 2)[0] ?? '';
    if (firstRaw.length > 0) {
      return {
        suggested: firstRaw,
        confidence: 'medium',
        source: 'history',
      };
    }
  }

  return null;
}

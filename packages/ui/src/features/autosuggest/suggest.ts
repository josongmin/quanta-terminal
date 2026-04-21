/**
 * suggestFromHistory — Fish-shell-style inline autosuggest ranking.
 *
 * Given a prefix and a list of history entries, return the best full-command
 * completion whose text begins with `prefix`. "Best" means the entry that
 * (a) starts with the prefix as a strict string prefix — case-sensitive so
 * "Cd" doesn't suggest "cd packages/ui" against the user's typed casing,
 * (b) is strictly longer than the prefix (no suggestion when the prefix
 * already equals an entry exactly), and (c) has the highest combined
 * recency + frequency score, with an optional cwd boost.
 *
 * Scope discipline — this is the INLINE suggestion ranker only:
 *   - no fuzzy matching (the palette owns fuzzy via BM25);
 *   - no LLM (features/ai-suggest owns that);
 *   - no boosting against output / diagnostics (inline tail must reflect a
 *     command the user actually ran, not a substring appearing in logs).
 *
 * Ranking formula (mirrors Fish's "recency + frequency"):
 *   score = w_recency * exp(-Δt / halfLife)
 *         + w_frequency * log1p(runCount)
 *         + (cwdBoost when entry.cwd === currentCwd)
 *
 * The entry with the highest score wins. Ties resolve by recency (newer
 * entry wins) — this matches user expectation that pressing → after typing
 * the last command re-runs the most recent invocation.
 */

export interface HistoryEntry {
  /** The command text as the user originally typed it. */
  readonly command: string;
  /** Epoch ms the user last ran this command. */
  readonly lastRunAt: number;
  /**
   * How many times the command has been run. ≥ 1. Aggregated by normalized
   * command, but the inline ranker treats distinct cwds as distinct entries
   * because `cd packages/ui` from `/repo` and from `/other` are different
   * commands in user terms.
   */
  readonly runCount: number;
  /** Absolute working directory the command was run in. */
  readonly cwd: string;
}

export interface SuggestOptions {
  /** Current working directory. When provided, entries sharing this cwd get the
   *  `cwdBoost`. Undefined disables the cwd contribution entirely. */
  readonly currentCwd?: string;
  /** Now-in-ms for recency decay. Defaults to Date.now(). Tests supply this. */
  readonly now?: number;
}

const W_RECENCY = 1.0;
const W_FREQUENCY = 0.4;
/** Additive boost when entry.cwd === currentCwd. Tuned to beat a marginally
 *  older entry from another cwd while not overwhelming a clearly-more-recent
 *  entry: 0.6 ≈ one half-life worth of recency. */
const CWD_BOOST = 0.6;
/** Half-life of the recency decay, in milliseconds. One week mirrors the
 *  history search module (weights.ts) so inline suggest and palette search
 *  agree on "how recent is recent". */
const RECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

function recencyDecay(timestamp: number, now: number): number {
  const delta = Math.max(0, now - timestamp);
  return Math.pow(0.5, delta / RECENCY_HALF_LIFE_MS);
}

/**
 * Word-prefix match: every space-separated token in `prefix` must be a prefix
 * of some word in `target`, in left-to-right order. Used as a fuzzy fallback
 * when strict prefix matching yields nothing.
 *
 * Examples (case-sensitive intentional — user casing is respected):
 *   wordPrefixMatch('git co', 'git commit -m "msg"') → true  (git→git, co→commit)
 *   wordPrefixMatch('ls u',   'ls packages/ui')       → false (strict char matching)
 *   wordPrefixMatch('ls -',   'ls -la /tmp')           → true
 */
function wordPrefixMatch(prefix: string, target: string): boolean {
  const pWords = prefix.trimEnd().split(/\s+/u).filter(Boolean);
  if (pWords.length < 2) return false; // single-token → handled by strict prefix
  const tWords = target.split(/\s+/u).filter(Boolean);
  let ti = 0;
  for (const pw of pWords) {
    // Find the next target word that starts with this prefix word.
    let found = false;
    while (ti < tWords.length) {
      if (tWords[ti]!.startsWith(pw)) {
        ti += 1;
        found = true;
        break;
      }
      ti += 1;
    }
    if (!found) return false;
  }
  return true;
}

/**
 * Return the best completion text whose command begins with `prefix`, or
 * `null` when nothing matches.
 *
 * Pass 1 — strict prefix match (original Fish-shell behaviour): the entry
 *   must start with `prefix` exactly and be strictly longer.
 *
 * Pass 2 — word-prefix fallback (new): when pass 1 yields nothing and the
 *   prefix contains multiple space-separated tokens, we look for entries
 *   whose words share those prefixes in order. This lets `git co` suggest
 *   `git commit -m "init"` even though the full string doesn't start with
 *   `git co`. Ghost tail rendering is skipped for word-prefix matches; the
 *   caller detects this via the normal `suggestion.startsWith(prefix)` check.
 *
 * Contract
 *  - prefix === '' → returns null (empty input has no suggestion in Fish).
 *  - no entry strictly starts with prefix (prefix === entry.command counts
 *    as "already finished" and is excluded) → null.
 *  - the returned string is the FULL command, not just the tail. Callers
 *    render the tail by slicing `result.slice(prefix.length)`.
 */
export function suggestFromHistory(
  prefix: string,
  history: readonly HistoryEntry[],
  opts: SuggestOptions = {},
): string | null {
  if (prefix.length === 0) return null;
  if (history.length === 0) return null;

  const now = opts.now ?? Date.now();
  const currentCwd = opts.currentCwd;

  let bestCommand: string | null = null;
  let bestScore = -Infinity;
  let bestTimestamp = -Infinity;

  // Pass 1: strict prefix match.
  for (const entry of history) {
    const cmd = entry.command;
    if (cmd.length <= prefix.length) continue;
    if (!cmd.startsWith(prefix)) continue;

    const recencyScore = W_RECENCY * recencyDecay(entry.lastRunAt, now);
    const frequencyScore = W_FREQUENCY * Math.log1p(Math.max(1, entry.runCount));
    const cwdScore =
      currentCwd !== undefined && entry.cwd === currentCwd ? CWD_BOOST : 0;
    const score = recencyScore + frequencyScore + cwdScore;

    if (
      score > bestScore ||
      (score === bestScore && entry.lastRunAt > bestTimestamp)
    ) {
      bestScore = score;
      bestCommand = cmd;
      bestTimestamp = entry.lastRunAt;
    }
  }

  if (bestCommand !== null) return bestCommand;

  // Pass 2: word-prefix fallback — only kicks in for multi-token prefixes
  // (e.g. `git co`, `docker r`, `npm run`) to avoid false positives on
  // short single-token inputs like `l`.
  if (!prefix.includes(' ')) return null;

  bestScore = -Infinity;
  bestTimestamp = -Infinity;

  for (const entry of history) {
    const cmd = entry.command;
    if (cmd === prefix) continue; // exact match → nothing to suggest
    if (!wordPrefixMatch(prefix, cmd)) continue;

    const recencyScore = W_RECENCY * recencyDecay(entry.lastRunAt, now);
    const frequencyScore = W_FREQUENCY * Math.log1p(Math.max(1, entry.runCount));
    const cwdScore =
      currentCwd !== undefined && entry.cwd === currentCwd ? CWD_BOOST : 0;
    // Slight penalty vs. strict prefix matches so a strict match always wins
    // if it's available (prevents bizarre ghost tails when a strict match
    // exists but scores slightly lower than the word-prefix candidate).
    const score = (recencyScore + frequencyScore + cwdScore) * 0.85;

    if (
      score > bestScore ||
      (score === bestScore && entry.lastRunAt > bestTimestamp)
    ) {
      bestScore = score;
      bestCommand = cmd;
      bestTimestamp = entry.lastRunAt;
    }
  }

  return bestCommand;
}

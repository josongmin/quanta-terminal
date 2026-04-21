/**
 * Secret detector — scans a decoded-text chunk for any of the patterns
 * registered in `patterns.ts` and returns absolute character offsets suitable
 * for the renderer to paint redaction spans.
 *
 * API shape
 * ---------
 * The mission spec pins the return shape as `{ start, end, kind }[]`. We
 * also attach the matched substring (`value`) because every caller we have
 * so far wants it for the hover-to-reveal tooltip, and re-slicing the source
 * every render is wasteful. Adding an extra (optional-on-consumer) field is
 * additive and does not violate the contract.
 *
 * Output guarantees
 * -----------------
 * - Sorted ascending by `start`.
 * - Non-overlapping: when two raw matches overlap, the LONGER one wins (ties
 *   broken by pattern order in the registry, which is registered most-
 *   specific-first). This is how a JWT beats the loose `aws-secret` pattern
 *   when the base64 body happens to be exactly 40 chars long.
 * - Zero-width matches are skipped; we guard against infinite loops when a
 *   pattern could theoretically match the empty string.
 *
 * Performance
 * -----------
 * `findSecrets` walks each pattern once over the full input, collecting
 * matches into a scratch array, then de-duplicates. For 1 MB of output with
 * 9 patterns this is ~9 MB of scans — well under the 100 ms target on a
 * modern laptop. We deliberately do NOT try to combine patterns into a
 * single regex (performance similar, maintainability much worse).
 */

import { SECRET_PATTERNS, type SecretKind, type SecretPattern } from './patterns.js';

export interface SecretMatch {
  /** Inclusive start offset in the input string (UTF-16 code units). */
  readonly start: number;
  /** Exclusive end offset in the input string. */
  readonly end: number;
  /** Which pattern matched. */
  readonly kind: SecretKind;
  /** The matched substring. Always equals `text.slice(start, end)`. */
  readonly value: string;
}

/**
 * Scan `text` and return every secret range, sorted and non-overlapping.
 *
 * Empty input short-circuits to an empty array without allocating.
 */
export function detectSecrets(text: string): ReadonlyArray<SecretMatch> {
  if (text.length === 0) return [];
  const raw: SecretMatch[] = [];
  for (const entry of SECRET_PATTERNS) {
    collectMatches(text, entry, raw);
  }
  if (raw.length <= 1) return raw;
  return dedupeAndSort(raw);
}

/**
 * Collect all matches for one pattern. Mutates `out` in place to avoid a
 * per-pattern scratch allocation. The regex's `lastIndex` is reset before
 * the scan and explicitly bumped when a zero-width match is encountered.
 */
function collectMatches(text: string, entry: SecretPattern, out: SecretMatch[]): void {
  const re = entry.re;
  re.lastIndex = 0;
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const groupIndex = entry.group;
    if (groupIndex !== undefined) {
      const captured = m[groupIndex];
      if (captured !== undefined && captured.length > 0) {
        // Find the group's absolute offset. A capture group is always a
        // substring of the whole match and occurs AT OR AFTER `m.index`,
        // so `indexOf(captured, m.index)` is correct and O(match-length).
        const groupStart = text.indexOf(captured, m.index);
        if (groupStart >= 0) {
          out.push({
            kind: entry.kind,
            start: groupStart,
            end: groupStart + captured.length,
            value: captured,
          });
        }
      }
    } else {
      const whole = m[0];
      if (whole.length > 0) {
        out.push({
          kind: entry.kind,
          start: m.index,
          end: m.index + whole.length,
          value: whole,
        });
      }
    }
    // Zero-width match guard: if the regex did not advance `lastIndex`,
    // bump by one to avoid an infinite loop. Real patterns always advance
    // but a future registry entry could trip this.
    if (re.lastIndex === m.index) re.lastIndex += 1;
    m = re.exec(text);
  }
}

/**
 * Sort by start-ascending, longest-first on ties; then greedily accept
 * while skipping / replacing overlaps with the LONGER candidate.
 *
 * Tie policy: if two candidates share the same start AND the same length,
 * the one that appears first in `raw` (i.e. the pattern earlier in the
 * registry) wins. JavaScript's `Array.prototype.sort` is stable since
 * ES2019 so this is guaranteed by the runtime.
 */
function dedupeAndSort(raw: SecretMatch[]): ReadonlyArray<SecretMatch> {
  const sorted = [...raw].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    // Longer first at the same start.
    return b.end - b.start - (a.end - a.start);
  });
  const accepted: SecretMatch[] = [];
  for (const candidate of sorted) {
    const last = accepted[accepted.length - 1];
    if (!last || candidate.start >= last.end) {
      accepted.push(candidate);
      continue;
    }
    // Overlap. Keep the longer range; ties keep the already-accepted one
    // because it was registered earlier (more-specific prefix).
    const lastLen = last.end - last.start;
    const curLen = candidate.end - candidate.start;
    if (curLen > lastLen) {
      accepted[accepted.length - 1] = candidate;
    }
  }
  return accepted;
}

/**
 * Build a masked string where each detected secret is replaced with a
 * fixed-length dot run plus a human-readable suffix — e.g.
 *   `export GITHUB_TOKEN=••••••••••• [hidden GitHub PAT]`
 *
 * This is the text-mode fallback used when we need a flat string (copy-to-
 * clipboard, plain-text transcript export). The interactive BlockBody path
 * uses `detectSecrets` directly and lets the renderer paint a reveal span.
 *
 * We intentionally DO NOT preserve the original length — emitting a fixed
 * 11-dot run means a redacted 60-char JWT is not visually distinguishable
 * from a redacted 20-char API key. Leaking the length would give an
 * attacker a free lower-bound on the secret.
 */
export function maskSecretsInText(text: string): string {
  const matches = detectSecrets(text);
  if (matches.length === 0) return text;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    if (cursor < m.start) out += text.slice(cursor, m.start);
    out += `${FIXED_DOT_RUN} [hidden ${labelFromKind(m.kind)}]`;
    cursor = m.end;
  }
  if (cursor < text.length) out += text.slice(cursor);
  return out;
}

const FIXED_DOT_RUN = '•••••••••••';

function labelFromKind(kind: SecretKind): string {
  // Locally defined mirror of `labelForKind` to avoid a circular import via
  // the package index. The registry is tiny so the linear scan is fine.
  const entry = SECRET_PATTERNS.find((p) => p.kind === kind);
  return entry ? entry.label : 'secret';
}

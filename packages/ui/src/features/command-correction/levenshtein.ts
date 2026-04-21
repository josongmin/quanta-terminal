/**
 * levenshtein — classic dynamic-programming edit distance with an early-exit
 * threshold.
 *
 * Used by `suggestCorrection` to rank history-based "did you mean" hints. We
 * only ever care about distances up to a small bound (≤ 2 in-cwd, ≤ 1
 * cross-cwd), so we short-circuit the moment the minimum distance reachable
 * from the current row exceeds the caller's threshold. This keeps the inner
 * loop O(|a|·|b|) in the worst case but much cheaper on the common case where
 * two commands diverge immediately (`ls` vs `git`, `ps` vs `docker compose`).
 *
 * Scope
 * -----
 * Classic Levenshtein: substitution / insertion / deletion each cost 1. No
 * Damerau transposition (which would make `gti → git` distance 1 instead of
 * 2) because the typo map already handles the few transpositions we care
 * about explicitly. Keeping the algorithm minimal avoids cases where two
 * different histories tie at "distance 1" via different edit flavors.
 */

/**
 * Compute the Levenshtein distance between `a` and `b`. When `threshold` is
 * provided and the true distance would exceed it, returns a value strictly
 * greater than `threshold` (the exact value is unspecified — callers MUST
 * only compare against the threshold, never use the return as the true
 * distance when it's above the bound).
 *
 * Special cases:
 *   - `a === b` returns 0.
 *   - Either string empty returns the other's length.
 */
export function levenshtein(a: string, b: string, threshold?: number): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Fast length-based rejection: the minimum possible distance is the
  // difference in lengths (you must insert or delete that many characters).
  // If that already exceeds the threshold there's no point building the DP
  // table at all.
  const lengthDiff = Math.abs(a.length - b.length);
  if (threshold !== undefined && lengthDiff > threshold) {
    return threshold + 1;
  }

  // Two-row DP: `prev` holds row i-1, `curr` is being built as row i.
  // We allocate once and swap references on each outer-loop iteration to
  // avoid per-row allocation pressure in the hot path.
  const aLen = a.length;
  const bLen = b.length;
  let prev = new Array<number>(bLen + 1);
  let curr = new Array<number>(bLen + 1);
  for (let j = 0; j <= bLen; j += 1) prev[j] = j;

  for (let i = 1; i <= aLen; i += 1) {
    curr[0] = i;
    let rowMin = curr[0]!;
    const aChar = a.charCodeAt(i - 1);
    for (let j = 1; j <= bLen; j += 1) {
      const cost = aChar === b.charCodeAt(j - 1) ? 0 : 1;
      // Min of substitution, insertion, deletion.
      const sub = prev[j - 1]! + cost;
      const ins = curr[j - 1]! + 1;
      const del = prev[j]! + 1;
      const v = sub < ins ? (sub < del ? sub : del) : ins < del ? ins : del;
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    // Early exit: the minimum value in the completed row is a LOWER BOUND on
    // the final distance, because each subsequent row only adds to it
    // monotonically along any single diagonal. If every cell in this row
    // already exceeds `threshold`, no further row can bring the final cell
    // below it — bail out with threshold + 1.
    if (threshold !== undefined && rowMin > threshold) {
      return threshold + 1;
    }
    // Swap prev/curr without reallocating.
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[bLen]!;
}

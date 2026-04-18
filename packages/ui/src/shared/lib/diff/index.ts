/**
 * Line-level diff — LCS-based.
 *
 * Used exclusively by the Phase-4 rerun Compare panel. Returns an ordered
 * `DiffLine[]` describing the transformation from `left` to `right`:
 *
 *   - kind === ' ': a common line, present in both sides at `leftIdx` / `rightIdx`
 *   - kind === '-': present only in `left` at `leftIdx`
 *   - kind === '+': present only in `right` at `rightIdx`
 *
 * The algorithm is an O(n·m) Longest-Common-Subsequence DP followed by a
 * backward walk to emit operations. We picked LCS over Myers for two reasons:
 * the implementation is ~40 lines of obvious code, and the Compare panel only
 * cares about correctness + a readable unified trace (not minimal-hunk
 * reporting). If that changes we can swap in Myers without changing the
 * caller-visible shape.
 *
 * Safety rails:
 *   - Inputs are split on `\n`. A final trailing newline produces a final
 *     empty segment — we drop it so "`foo\n`" and "`foo`" are considered
 *     equal under this comparator (typical for terminal output which
 *     conventionally ends with a newline).
 *   - `MAX_LINES_PER_SIDE` caps the DP allocation at 10k² = 100M — big, but
 *     the caller is expected to honour `didTruncate` and render a marker
 *     rather than panic. We clamp per side rather than by the matrix size
 *     because the UI wants symmetric truncation.
 *   - Stripping ANSI is the caller's job. We compare the strings byte-for-
 *     byte; the Compare feature decodes with a text decoder and strips SGR
 *     before handing lines here so colored / uncolored lines of the same
 *     visible text register as equal (see spec §Fixtures).
 *
 * Zero runtime deps. Pure, synchronous, no throws on well-formed input.
 */

export interface DiffLine {
  readonly kind: '+' | '-' | ' ';
  readonly text: string;
  /** 0-based index into the `left` input, present on `' '` / `'-'`. */
  readonly leftIdx?: number;
  /** 0-based index into the `right` input, present on `' '` / `'+'`. */
  readonly rightIdx?: number;
}

export interface DiffResult {
  readonly lines: DiffLine[];
  /**
   * True when either input exceeded `MAX_LINES_PER_SIDE`. When truncated the
   * excess portion is NOT in `lines` — the caller renders a "diff truncated"
   * marker and asks the user to compare shorter outputs. We prefer a visible
   * truncation to a silently-incorrect O(n·m) blow-up.
   */
  readonly didTruncate: boolean;
  /**
   * The effective line counts actually fed into the diff (after truncation).
   * Exposed so the Compare panel's header can say "diff truncated to 10k
   * lines per side" without recomputing.
   */
  readonly leftLineCount: number;
  readonly rightLineCount: number;
}

/**
 * Cap to keep DP memory bounded. At the default 10k × 10k this allocates a
 * 100-million-cell integer matrix (≈400 MB of Uint32Array), which is the
 * upper bound. Most rerun diffs are <1000 lines per side. If users regularly
 * hit this we'll swap for Myers; in the meantime the marker is the contract.
 */
export const MAX_LINES_PER_SIDE = 10_000;

/**
 * Split a chunk of text on `\n`. A bare trailing newline is dropped — it
 * represents "text ends with a newline" which is the canonical state for
 * terminal output, not a meaningful empty final line.
 */
export function splitLines(source: string): string[] {
  if (source.length === 0) return [];
  const lines = source.split('\n');
  // Drop a terminal empty produced by the split of a trailing newline.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/**
 * Diff two strings at line granularity. See DiffLine / DiffResult for shape.
 * The output is a full linear trace suitable for a unified-view render; hunk
 * coalescing is a panel-side concern (keyboard nav groups contiguous `+`/`-`
 * into hunks via `computeHunks`).
 */
export function diffLines(left: string, right: string): DiffResult {
  const leftAll = splitLines(left);
  const rightAll = splitLines(right);

  const didTruncate =
    leftAll.length > MAX_LINES_PER_SIDE || rightAll.length > MAX_LINES_PER_SIDE;

  const leftLines = leftAll.length > MAX_LINES_PER_SIDE
    ? leftAll.slice(0, MAX_LINES_PER_SIDE)
    : leftAll;
  const rightLines = rightAll.length > MAX_LINES_PER_SIDE
    ? rightAll.slice(0, MAX_LINES_PER_SIDE)
    : rightAll;

  const lines = runDiff(leftLines, rightLines);
  return {
    lines,
    didTruncate,
    leftLineCount: leftLines.length,
    rightLineCount: rightLines.length,
  };
}

/**
 * Core LCS-based diff on pre-split line arrays. Kept separate from
 * `diffLines` so tests can exercise the pure algorithm without going through
 * `splitLines`, and so the Compare feature can feed already-tokenized ANSI-
 * stripped arrays (avoiding a second split).
 */
export function runDiff(left: readonly string[], right: readonly string[]): DiffLine[] {
  const n = left.length;
  const m = right.length;

  // Fast paths. Two pathological but common cases: one side empty, or the
  // sides are literally the same reference/content (identical output, by
  // far the most common rerun outcome).
  if (n === 0 && m === 0) return [];
  if (n === 0) {
    return right.map(
      (text, rightIdx): DiffLine => ({ kind: '+', text, rightIdx }),
    );
  }
  if (m === 0) {
    return left.map(
      (text, leftIdx): DiffLine => ({ kind: '-', text, leftIdx }),
    );
  }

  // LCS length matrix. `dp[i][j]` holds the length of the LCS of
  // `left[0..i]` and `right[0..j]`. Using a 1-D Uint32Array plus arithmetic
  // indexing to avoid the n+1 nested-array allocations (cheaper under V8).
  const cols = m + 1;
  const dp = new Uint32Array((n + 1) * cols);
  for (let i = 1; i <= n; i += 1) {
    const li = left[i - 1]!;
    const row = i * cols;
    const prevRow = (i - 1) * cols;
    for (let j = 1; j <= m; j += 1) {
      if (li === right[j - 1]) {
        dp[row + j] = dp[prevRow + (j - 1)]! + 1;
      } else {
        const a = dp[prevRow + j]!;
        const b = dp[row + (j - 1)]!;
        dp[row + j] = a >= b ? a : b;
      }
    }
  }

  // Backward walk — emit operations into a buffer and reverse at the end.
  // The standard LCS backtrack: prefer diagonal (equal) if the cells are
  // equal; otherwise move in the direction of the larger predecessor.
  const out: DiffLine[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      out.push({ kind: ' ', text: left[i - 1]!, leftIdx: i - 1, rightIdx: j - 1 });
      i -= 1;
      j -= 1;
      continue;
    }
    const up = dp[(i - 1) * cols + j]!;
    const left_ = dp[i * cols + (j - 1)]!;
    // Tie-break toward INSERTIONS during the reverse walk. After the final
    // `reverse()` call the output reads deletions-before-insertions, which
    // matches the "left is older → show removals above additions" convention
    // used by unified-diff tools (GNU diff, git diff). Without the strict
    // `>`, a replacement pair would render as `+/-` (insert above delete),
    // which is counter to user expectation (see diff fixture
    // `whitespace-only change`).
    if (up > left_) {
      out.push({ kind: '-', text: left[i - 1]!, leftIdx: i - 1 });
      i -= 1;
    } else {
      out.push({ kind: '+', text: right[j - 1]!, rightIdx: j - 1 });
      j -= 1;
    }
  }
  while (i > 0) {
    out.push({ kind: '-', text: left[i - 1]!, leftIdx: i - 1 });
    i -= 1;
  }
  while (j > 0) {
    out.push({ kind: '+', text: right[j - 1]!, rightIdx: j - 1 });
    j -= 1;
  }
  out.reverse();
  return out;
}

/**
 * A `Hunk` is a contiguous run of non-equal lines (`+` or `-` mixed together).
 * The Compare panel uses these for `j`/`k` keyboard nav: each press jumps to
 * the next / previous hunk start. Equal-line runs are implicit gaps; the
 * panel does NOT coalesce visually — the whole linear trace renders.
 */
export interface DiffHunk {
  /** Inclusive index into the `DiffLine[]` where the hunk starts. */
  readonly start: number;
  /** Exclusive index where the hunk ends. `end - start >= 1`. */
  readonly end: number;
}

/**
 * Scan a `DiffLine[]` once and emit the `DiffHunk[]` for keyboard nav. A hunk
 * is a maximal contiguous run of non-`' '` lines; a single flipped line
 * produces a one-line hunk.
 */
export function computeHunks(lines: readonly DiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (!l) continue;
    if (l.kind === ' ') {
      if (start !== -1) {
        hunks.push({ start, end: i });
        start = -1;
      }
    } else if (start === -1) {
      start = i;
    }
  }
  if (start !== -1) hunks.push({ start, end: lines.length });
  return hunks;
}

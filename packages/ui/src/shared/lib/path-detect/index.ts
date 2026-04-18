/**
 * Path detector — scan a block of plain text and return every `path:line[:col]`
 * occurrence along with its byte-range in the source.
 *
 * Used by Phase-3 error-to-code navigation (`features/navigation`) to turn
 * rustc/tsc/python/node error lines into clickable affordances without having
 * to parse the diagnostic format itself. The sibling diagnostic parser agent
 * may eventually emit structured events; this detector works independently
 * and continues to be useful for any free-form text a command streams.
 *
 * Design choices:
 *
 *   - ONE regex pass per input, returning non-overlapping matches, so the
 *     caller can interleave detected spans with plain-text fragments and
 *     re-assemble the AnsiSpan list in `AnsiOutput` without fragile state.
 *   - The path portion is DOT-required. This is the single heuristic that
 *     distinguishes `src/main.rs:12:3` from clock strings like `12:34:56` and
 *     from Windows drive collisions like `C:\Users\alice:12:3` (the latter has
 *     no `.` before the first `:` and therefore is not matched).
 *   - URLs are explicitly excluded via a lookbehind-like prefix test.
 *   - Matches carry 1-based line and column numbers, matching every compiler
 *     in scope (rustc, tsc, python, node, go).
 *
 * OUT OF SCOPE:
 *   - No filesystem access. Whether a detected path actually exists is the
 *     caller's problem; false positives where the "path" is a non-existent
 *     file are harmless (the editor will create / prompt).
 *   - No path normalization. `../foo.ts:1:2` and `./foo.ts:1:2` are both
 *     reported verbatim; the navigation feature resolves against the session
 *     cwd.
 */

export interface DetectedPath {
  /** Byte offset into the input where the match starts. */
  readonly start: number;
  /** Byte offset into the input where the match ends (exclusive). */
  readonly end: number;
  /** Full match text, e.g. `src/main.rs:12:3`. */
  readonly match: string;
  /** File portion, e.g. `src/main.rs`. */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column, if present. */
  readonly column?: number;
}

/**
 * Shortest path we'll accept. Without a floor, `a:1` registers as a match on
 * every prose reference to timestamps or labels. The 3-character floor keeps
 * legitimate short paths (`a.ts`, `.x`) and rejects the noise.
 */
const MIN_PATH_LENGTH = 3;

/**
 * Characters that cannot appear in a detected path. Whitespace terminates,
 * colons separate line/col, `"` and `'` and backtick and `<`/`>` and `|` bound
 * quoted strings / shell fragments. `$` bounds shell variables. `\u0000` and
 * other control chars are filtered by an explicit test below.
 */
const PATH_CHAR_CLASS = String.raw`[^\s:"'\`<>|()\[\]{}$]`;

/**
 * Single regex that captures both plain `path:line:col` and the Windows
 * `C:\Users\...\file.ext:line:col` variant.
 *
 * Group layout:
 *   1: full path (without line/column)
 *   2: line (digits)
 *   3: column (digits, optional)
 */
const PATH_LINE_COL_RE = new RegExp(
  // Drive-prefix-aware path. We require either:
  //   - a Windows drive letter followed by `\` or `/` (e.g. `C:\` or `C:/`),
  //     then one-or-more path chars, OR
  //   - a bare path run with no leading drive.
  //
  // The drive-letter branch uses a negative lookbehind `(?<![A-Za-z])` so
  // that URL schemes like `https:` do not trip the one-letter drive branch.
  // Without the lookbehind the engine happily matches `s:/` inside `https:/`
  // and consumes the rest of the URL as a path, mis-reading the port as a
  // line number. See the `https URL with port and path` fixture.
  String.raw`((?:(?<![A-Za-z])[A-Za-z]:[\\/]${PATH_CHAR_CLASS}+|${PATH_CHAR_CLASS}+)):(\d+)(?::(\d+))?`,
  'g',
);

/**
 * Reject matches that are part of a URL. Two shapes are possible:
 *
 *   1. The match starts immediately after `://` (stack-trace URLs embedded in
 *      `at <anon>:https://foo/bar.js:1:1` where the regex starts at the path
 *      chunk of the URL).
 *   2. The match starts with `//` preceded by `scheme:` — this is the "regex
 *      started at the first `/` of `https://…`" case. We look backwards for
 *      a nearby `[A-Za-z]+:` right before the `//` to confirm.
 */
function isPrecededByUrlSchemeEnd(input: string, start: number, matched: string): boolean {
  if (start >= 3) {
    if (input.slice(start - 3, start) === '://') return true;
  }
  // Shape #2: match begins with `//` and the bytes directly before `//` look
  // like a URL scheme. We require the two chars right before `start` to be
  // `:/` — together with the `/` at `start` we get `:/` + `/`, i.e. `://`
  // straddling the boundary.
  if (matched.startsWith('//') && start >= 1 && input[start - 1] === ':') {
    // Walk back to see if it was `<letters>:`.
    let i = start - 2;
    let sawLetter = false;
    while (i >= 0) {
      const ch = input.charCodeAt(i);
      const isLetter =
        (ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39);
      if (!isLetter) break;
      sawLetter = true;
      i -= 1;
    }
    if (sawLetter) return true;
  }
  return false;
}

/**
 * Does `path` contain a `.`? We require this so that clock strings (`12:34:56`)
 * and Windows drive collisions (`C:\\Users\\alice:12:3`, no dot before the
 * first `:`) don't register as paths.
 */
function pathHasDot(path: string): boolean {
  return path.includes('.');
}

/**
 * Detect every `path:line[:col]` occurrence inside `text`. Returns matches in
 * source order, non-overlapping.
 */
export function detectPaths(text: string): DetectedPath[] {
  if (text.length === 0) return [];
  const out: DetectedPath[] = [];
  const re = new RegExp(PATH_LINE_COL_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const pathText = m[1] ?? '';
    const lineText = m[2] ?? '';
    const colText = m[3];
    // Shortest acceptable path length filter.
    if (pathText.length < MIN_PATH_LENGTH) continue;
    // URL-prefix exclusion.
    if (isPrecededByUrlSchemeEnd(text, start, m[0])) continue;
    // Require a dot to avoid bare-identifier collisions like `Foo:12:3` and
    // `Error at 12:34:56`.
    if (!pathHasDot(pathText)) continue;
    // A trailing punctuation-only path like `file.:1:2` — `file.` does have a
    // dot but is degenerate. We require at least one char after the final
    // dot (basename has a real extension or name part).
    const lastDot = pathText.lastIndexOf('.');
    if (lastDot === pathText.length - 1) continue;
    const line = parseInt(lineText, 10);
    if (!Number.isFinite(line) || line <= 0) continue;
    let column: number | undefined;
    if (colText !== undefined) {
      const c = parseInt(colText, 10);
      if (Number.isFinite(c) && c > 0) column = c;
    }
    const hit: DetectedPath = column !== undefined
      ? { start, end, match: m[0], path: pathText, line, column }
      : { start, end, match: m[0], path: pathText, line };
    out.push(hit);
  }
  return out;
}

/**
 * Split `text` into an alternating sequence of plain text fragments and
 * detected path hits. Useful for the AnsiOutput renderer which needs to
 * produce one React node per fragment.
 *
 * The resulting array is always "text, hit, text, hit, ..., text" — plain
 * fragments can be empty strings, but their positions are preserved so the
 * consumer doesn't have to track indices.
 */
export type TextFragment =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'path'; readonly hit: DetectedPath };

export function splitTextByPaths(text: string): TextFragment[] {
  const hits = detectPaths(text);
  if (hits.length === 0) return [{ kind: 'text', text }];
  const out: TextFragment[] = [];
  let cursor = 0;
  for (const h of hits) {
    out.push({ kind: 'text', text: text.slice(cursor, h.start) });
    out.push({ kind: 'path', hit: h });
    cursor = h.end;
  }
  out.push({ kind: 'text', text: text.slice(cursor) });
  return out;
}

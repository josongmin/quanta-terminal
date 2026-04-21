/**
 * Query compilation for the output-search feature.
 *
 * Upgrade spec: the search bar now supports three orthogonal modes —
 *   - `regex`          : interpret `text` as a JavaScript regular expression
 *   - `caseSensitive`  : honour case in both plain and regex modes
 *   - `wholeWord`      : wrap the compiled pattern in `\b…\b` word boundaries
 *
 * All three fold down to a single `RegExp` that `findMatchesWithQuery` uses in
 * a `exec` loop. The compile step is pure and synchronous; invalid user input
 * (e.g. `[` as regex) is caught and returned as `{ ok: false, error }` so the
 * UI can render "invalid regex" inline without bringing down the widget.
 *
 * Match ordering / overlap semantics match the legacy `findMatches`:
 *   - non-overlapping hits (cursor advances past each match),
 *   - zero-length regex matches (e.g. `^`) are rejected so `\b` on an empty
 *     line doesn't produce an infinite loop.
 */

export interface SearchQuery {
  readonly text: string;
  readonly regex: boolean;
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
}

export const EMPTY_QUERY: SearchQuery = {
  text: '',
  regex: false,
  caseSensitive: false,
  wholeWord: false,
};

export type CompiledQuery =
  | { readonly ok: true; readonly pattern: RegExp; readonly empty: false }
  | { readonly ok: true; readonly pattern: null; readonly empty: true }
  | { readonly ok: false; readonly error: string };

/**
 * Escape a string so every character becomes a regex-literal. Used by the
 * plain-text path; the regex path never touches this.
 */
export function escapeRegex(src: string): string {
  return src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a `SearchQuery` into a single global `RegExp`. Never throws;
 * invalid regexes produce `{ ok: false }` with the JS error message so the
 * widget can show "/invalid regex/".
 *
 * Flags:
 *   - `g` always — navigation walks hits with `exec`.
 *   - `i` when `caseSensitive === false`.
 *   - `u` always — so surrogate pairs in the user's query match the rendered
 *     text offsets (the renderer slices by UTF-16 code units, which lines up
 *     because `u` mode still reports indices in code units).
 */
export function compileQuery(q: SearchQuery): CompiledQuery {
  if (q.text.length === 0) {
    return { ok: true, pattern: null, empty: true };
  }
  let body = q.regex ? q.text : escapeRegex(q.text);
  if (q.wholeWord) body = `\\b(?:${body})\\b`;
  const flags = `g${q.caseSensitive ? '' : 'i'}u`;
  try {
    return { ok: true, pattern: new RegExp(body, flags), empty: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'invalid regex';
    return { ok: false, error: message };
  }
}

export interface Range {
  readonly start: number;
  readonly length: number;
}

/**
 * Run a compiled pattern over `text` producing non-overlapping ranges. The
 * caller guarantees `pattern.global === true`; we still reset `lastIndex` to
 * 0 on entry (the RegExp may be re-used across blocks).
 *
 * Zero-length matches advance the cursor by one code unit so anchors like
 * `^` / `\b` don't spin. This mirrors Chrome's find-in-page behaviour on
 * regex search.
 */
export function findMatchesWithPattern(text: string, pattern: RegExp): Range[] {
  if (text.length === 0) return [];
  pattern.lastIndex = 0;
  const out: Range[] = [];
  // Guard against pathological patterns that match more times than the
  // string has characters (can happen with look-arounds in rare engines).
  const cap = text.length * 2 + 16;
  let iter = 0;
  for (;;) {
    if (iter++ > cap) break;
    const m = pattern.exec(text);
    if (m === null) break;
    const start = m.index;
    const length = m[0].length;
    if (length === 0) {
      // Advance past empty match to avoid infinite loop.
      pattern.lastIndex = Math.min(text.length + 1, pattern.lastIndex + 1);
      continue;
    }
    out.push({ start, length });
    // Non-overlap: advance cursor past the match even though `exec` with
    // `g` already does, in case of weird engine edge cases.
    pattern.lastIndex = start + length;
  }
  return out;
}

/**
 * Convenience wrapper — compile + run. Returns `[]` on empty or invalid query.
 * Exposed for tests and for the recompute fallback that used to call
 * `findMatches(text, query)` (plain substring search, case-insensitive).
 */
export function findMatchesForQuery(text: string, query: SearchQuery): Range[] {
  const compiled = compileQuery(query);
  if (!compiled.ok || compiled.empty) return [];
  return findMatchesWithPattern(text, compiled.pattern);
}

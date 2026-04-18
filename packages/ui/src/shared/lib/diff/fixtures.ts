/**
 * Fixtures for the LCS line diff. Ten scenarios covering the interesting
 * shapes of rerun output the Compare panel needs to render: identical,
 * completely different, insert-at-top, delete-at-bottom, middle edits,
 * ANSI-colored (must strip SGR before equality — that's the caller's job
 * in practice; here we model the "already-stripped" post-condition), CJK,
 * trailing-newline normalization, whitespace-only change, and truncation.
 */

export interface DiffFixture {
  readonly name: string;
  readonly left: string;
  readonly right: string;
  /**
   * Expected `kind` sequence — compact form so test failures print a legible
   * pattern. A string of `+ - =` characters, one per emitted line, with `=`
   * standing in for the context marker (`' '`) because a literal space in a
   * test name is harder to read.
   */
  readonly kinds: string;
}

const enc = (s: string[]): string => s.join('\n');

export const DIFF_FIXTURES: readonly DiffFixture[] = [
  {
    name: 'identical',
    left: enc(['a', 'b', 'c']),
    right: enc(['a', 'b', 'c']),
    kinds: '===',
  },
  {
    name: 'empty both',
    left: '',
    right: '',
    kinds: '',
  },
  {
    name: 'completely different',
    left: enc(['a', 'b', 'c']),
    right: enc(['x', 'y', 'z']),
    // LCS length = 0; we emit all deletions, then all insertions.
    kinds: '---+++',
  },
  {
    name: 'insert-at-top',
    left: enc(['b', 'c']),
    right: enc(['a', 'b', 'c']),
    kinds: '+==',
  },
  {
    name: 'delete-at-bottom',
    left: enc(['a', 'b', 'c']),
    right: enc(['a', 'b']),
    kinds: '==-',
  },
  {
    name: 'middle edit',
    left: enc(['a', 'b', 'c']),
    right: enc(['a', 'B', 'c']),
    // Replacement is emitted as delete + insert (deletions first by tie-break).
    kinds: '=-+=',
  },
  {
    name: 'trailing newline on left only',
    // Canonically a terminal ends with '\n'. The splitter drops that, so
    // these should be considered identical.
    left: 'hello\n',
    right: 'hello',
    kinds: '=',
  },
  {
    name: 'ansi-stripped equal',
    // These strings represent text AFTER the caller strips ANSI. The literal
    // text is the same; kinds must all be equal.
    left: enc(['error: oops', 'retry']),
    right: enc(['error: oops', 'retry']),
    kinds: '==',
  },
  {
    name: 'cjk lines',
    left: enc(['你好', '世界']),
    right: enc(['你好', '月球']),
    // Last line changed; deletion then insertion.
    kinds: '=-+',
  },
  {
    name: 'whitespace-only change',
    left: enc(['hello world', 'bye']),
    right: enc(['hello  world', 'bye']),
    // Different spacing is a different line.
    kinds: '-+=',
  },
] as const;

/**
 * Extract the path token at the cursor position.
 *
 * A path token is the longest sequence of non-whitespace characters ending
 * at `caret` that looks like a filesystem path. Token boundaries are shell
 * word separators: space, tab, |, ;, &, (, ), <, >, backtick, and =.
 *
 * Returns null when there is no path-like token at the cursor.
 */

const WORD_BOUNDARY = /[\s|;&()><`=]/;

export interface PathToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function extractPathToken(value: string, caret: number): PathToken | null {
  const slice = value.slice(0, caret);
  let start = slice.length;
  while (start > 0 && !WORD_BOUNDARY.test(slice[start - 1]!)) {
    start--;
  }
  const text = slice.slice(start);
  if (text.length === 0) return null;
  if (!looksLikePath(text)) return null;
  return { text, start, end: caret };
}

export function looksLikePath(token: string): boolean {
  return (
    token.startsWith('/') ||
    token.startsWith('~/') ||
    token.startsWith('./') ||
    token.startsWith('../') ||
    token === '~' ||
    token === '.' ||
    token === '..' ||
    token.includes('/')
  );
}

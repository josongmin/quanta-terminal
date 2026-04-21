/**
 * shell-tokenize — minimalist shell syntax tokenizer for live highlighting.
 *
 * This is NOT a full shell parser. It's a left-to-right, regex-driven
 * classifier that labels byte-ranges of the input string with a token kind
 * so the Composer can paint a syntax-highlighted overlay in real time.
 *
 * Supported constructs
 *   - commands (first non-whitespace word, plus words that follow a pipe,
 *     operator, or `$(` — those reset the "next word is a command" flag).
 *   - flags (-a, --verbose), path-like args (contain `/`, or start with
 *     ./ ../ ~ or /), variables ($FOO, ${FOO}), string literals with escape
 *     handling, operators (|, &&, ||, ;, >, >>, <), subshells ($(...) and
 *     backtick `...`), and `# ...` comments.
 *
 * Out of scope
 *   - heredocs (<<EOF): detected only to the extent of not breaking — the
 *     `<<` operator tokenizes normally and the following word stays `text`.
 *   - brace expansion, globs, process substitution with <( >(.
 *   - nested backticks (rare in practice; the tokenizer treats a closing
 *     backtick as the terminator).
 *
 * Error recovery: unterminated strings tokenize to the end of input as
 * strings so the overlay still paints something useful while the user is
 * mid-word. That means a half-typed `"foo` will color the trailing text
 * green until the user finishes the quote.
 */

export type TokenKind =
  | 'command'
  | 'flag'
  | 'string'
  | 'path'
  | 'var'
  | 'operator'
  | 'subshell'
  | 'comment'
  | 'text';

export interface Token {
  readonly start: number;
  readonly end: number;
  readonly kind: TokenKind;
}

/** Single-character operators that split statements. */
const OP_SINGLE: ReadonlySet<string> = new Set(['|', ';', '<', '>', '&']);

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isWordStart(ch: string): boolean {
  // Anything that isn't whitespace, an operator char, a quote, or a comment
  // opener is fair game for a word. We keep this permissive so pathy args
  // like `./foo` and URLs like `https://...` tokenize as a single word.
  return (
    !isWhitespace(ch) &&
    !OP_SINGLE.has(ch) &&
    ch !== '"' &&
    ch !== "'" &&
    ch !== '`' &&
    ch !== '#' &&
    ch !== '$'
  );
}

/** Classify a word (non-quoted, non-variable) into command/flag/path/text. */
function classifyWord(word: string, expectingCommand: boolean): TokenKind {
  if (word.length === 0) return 'text';
  if (expectingCommand) return 'command';
  if (word.startsWith('--') || (word.startsWith('-') && word.length > 1 && word !== '-')) {
    return 'flag';
  }
  if (
    word.startsWith('./') ||
    word.startsWith('../') ||
    word.startsWith('/') ||
    word.startsWith('~') ||
    word.includes('/')
  ) {
    return 'path';
  }
  return 'text';
}

/**
 * Tokenize `input` into a flat, non-overlapping, start-sorted token list
 * covering the full string. Whitespace regions are NOT emitted — callers
 * reconstruct the rendered overlay by splicing whitespace between tokens
 * using the `start`/`end` offsets.
 */
export function tokenize(input: string): Token[] {
  const out: Token[] = [];
  const len = input.length;
  let i = 0;
  // After a command-resetting punctuator (start-of-input, |, ||, &&, ;, $(
  // newline), the next word is classified as a command.
  let expectingCommand = true;

  while (i < len) {
    const ch = input[i]!;

    // Whitespace: skip, does NOT reset the expectingCommand flag on its own.
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }

    // Comment — `#` starting a word (not embedded in a word, checked below
    // by virtue of hitting the `#` at word-start). Everything to the next
    // newline is a single comment token.
    if (ch === '#') {
      let j = i + 1;
      while (j < len && input[j] !== '\n') j += 1;
      out.push({ start: i, end: j, kind: 'comment' });
      i = j;
      expectingCommand = true;
      continue;
    }

    // Operators. Order matters: check the 2-char operators before the
    // 1-char ones so `&&` doesn't tokenize as two `&` errors.
    if (ch === '&' && input[i + 1] === '&') {
      out.push({ start: i, end: i + 2, kind: 'operator' });
      i += 2;
      expectingCommand = true;
      continue;
    }
    if (ch === '|' && input[i + 1] === '|') {
      out.push({ start: i, end: i + 2, kind: 'operator' });
      i += 2;
      expectingCommand = true;
      continue;
    }
    if (ch === '>' && input[i + 1] === '>') {
      out.push({ start: i, end: i + 2, kind: 'operator' });
      i += 2;
      // A redirection target is an arg, not a command.
      expectingCommand = false;
      continue;
    }
    if (ch === '<' && input[i + 1] === '<') {
      // Heredoc opener. Out of scope — emit the `<<` as operator and leave
      // the following word to tokenize as a regular arg.
      out.push({ start: i, end: i + 2, kind: 'operator' });
      i += 2;
      expectingCommand = false;
      continue;
    }
    if (ch === '|' || ch === ';') {
      out.push({ start: i, end: i + 1, kind: 'operator' });
      i += 1;
      expectingCommand = true;
      continue;
    }
    if (ch === '>' || ch === '<') {
      out.push({ start: i, end: i + 1, kind: 'operator' });
      i += 1;
      expectingCommand = false;
      continue;
    }
    if (ch === '&') {
      // Bare `&` (background). Treat as operator + reset.
      out.push({ start: i, end: i + 1, kind: 'operator' });
      i += 1;
      expectingCommand = true;
      continue;
    }

    // Strings: single or double quoted. Consume until matching closing quote
    // OR end-of-input (unterminated). Inside double quotes we honour
    // backslash escapes. Inside single quotes nothing escapes (POSIX).
    if (ch === '"') {
      let j = i + 1;
      while (j < len) {
        const c = input[j]!;
        if (c === '\\' && j + 1 < len) {
          j += 2;
          continue;
        }
        if (c === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      out.push({ start: i, end: j, kind: 'string' });
      i = j;
      expectingCommand = false;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < len && input[j] !== "'") j += 1;
      if (j < len) j += 1; // consume the closing quote
      out.push({ start: i, end: j, kind: 'string' });
      i = j;
      expectingCommand = false;
      continue;
    }

    // Backtick subshell. Emit a single `subshell` token covering the whole
    // backticked region (including the backticks). Everything inside stays
    // opaque — this tokenizer does not recurse.
    if (ch === '`') {
      let j = i + 1;
      while (j < len && input[j] !== '`') j += 1;
      if (j < len) j += 1;
      out.push({ start: i, end: j, kind: 'subshell' });
      i = j;
      expectingCommand = false;
      continue;
    }

    // Variable or $(...) subshell. `$(` starts a subshell that ALSO resets
    // the expectingCommand flag inside it — we simulate that by emitting a
    // `subshell` token for the `$(` sigil, then letting the main loop
    // re-enter with expectingCommand=true.
    if (ch === '$') {
      const next = input[i + 1];
      if (next === '(') {
        out.push({ start: i, end: i + 2, kind: 'subshell' });
        i += 2;
        expectingCommand = true;
        continue;
      }
      if (next === '{') {
        // ${FOO} — scan to the matching `}` (no nesting support).
        let j = i + 2;
        while (j < len && input[j] !== '}') j += 1;
        if (j < len) j += 1;
        out.push({ start: i, end: j, kind: 'var' });
        i = j;
        expectingCommand = false;
        continue;
      }
      // Plain `$FOO` — consume identifier chars.
      let j = i + 1;
      while (j < len) {
        const c = input[j]!;
        if (
          (c >= 'a' && c <= 'z') ||
          (c >= 'A' && c <= 'Z') ||
          (c >= '0' && c <= '9') ||
          c === '_'
        ) {
          j += 1;
          continue;
        }
        break;
      }
      // Special case: a bare `$` with no identifier → treat as plain text.
      if (j === i + 1) {
        out.push({ start: i, end: j, kind: 'text' });
      } else {
        out.push({ start: i, end: j, kind: 'var' });
      }
      i = j;
      expectingCommand = false;
      continue;
    }

    // `)` closes a `$(` subshell — treat as subshell sigil so its styling
    // matches the opener.
    if (ch === ')') {
      out.push({ start: i, end: i + 1, kind: 'subshell' });
      i += 1;
      // After the subshell closes, the outer statement may still expect args.
      expectingCommand = false;
      continue;
    }

    // Word. Collect until whitespace or a token-terminator. Note: we break
    // on `$` so embedded `$VAR` tokenizes separately — Fish does the same.
    if (isWordStart(ch)) {
      let j = i;
      while (j < len) {
        const c = input[j]!;
        if (
          isWhitespace(c) ||
          c === '|' ||
          c === ';' ||
          c === '<' ||
          c === '>' ||
          c === '&' ||
          c === '"' ||
          c === "'" ||
          c === '`' ||
          c === '$' ||
          c === ')'
        ) {
          break;
        }
        j += 1;
      }
      const word = input.slice(i, j);
      const kind = classifyWord(word, expectingCommand);
      out.push({ start: i, end: j, kind });
      i = j;
      // Once we've emitted a command, subsequent words are args until a
      // punctuator resets the flag.
      if (expectingCommand) expectingCommand = false;
      continue;
    }

    // Unknown single char — emit as text so offsets still cover the input.
    out.push({ start: i, end: i + 1, kind: 'text' });
    i += 1;
  }

  return out;
}

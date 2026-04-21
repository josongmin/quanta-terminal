import { describe, expect, it } from 'vitest';
import { tokenize, type Token, type TokenKind } from '../index.js';

/** Utility: rebuild a `{kind, text}[]` projection for easier assertions. */
function projection(input: string, tokens: Token[]): Array<{ kind: TokenKind; text: string }> {
  return tokens.map((t) => ({ kind: t.kind, text: input.slice(t.start, t.end) }));
}

describe('tokenize', () => {
  it('returns [] for empty input', () => {
    expect(tokenize('')).toEqual([]);
  });

  it('single command', () => {
    const input = 'ls';
    expect(projection(input, tokenize(input))).toEqual([
      { kind: 'command', text: 'ls' },
    ]);
  });

  it('command with flag and path arg', () => {
    const input = 'ls -la /etc';
    expect(projection(input, tokenize(input))).toEqual([
      { kind: 'command', text: 'ls' },
      { kind: 'flag', text: '-la' },
      { kind: 'path', text: '/etc' },
    ]);
  });

  it('long flag --verbose', () => {
    const input = 'git --verbose';
    const toks = projection(input, tokenize(input));
    expect(toks[1]).toEqual({ kind: 'flag', text: '--verbose' });
  });

  it('pipe resets expectingCommand', () => {
    const input = 'ls -la | grep foo';
    expect(projection(input, tokenize(input))).toEqual([
      { kind: 'command', text: 'ls' },
      { kind: 'flag', text: '-la' },
      { kind: 'operator', text: '|' },
      { kind: 'command', text: 'grep' },
      { kind: 'text', text: 'foo' },
    ]);
  });

  it('double ampersand resets to command', () => {
    const input = 'cd foo && ls';
    expect(projection(input, tokenize(input))).toEqual([
      { kind: 'command', text: 'cd' },
      { kind: 'text', text: 'foo' },
      { kind: 'operator', text: '&&' },
      { kind: 'command', text: 'ls' },
    ]);
  });

  it('double pipe (||) resets to command', () => {
    const input = 'a || b';
    const kinds = tokenize(input).map((t) => t.kind);
    expect(kinds).toEqual(['command', 'operator', 'command']);
  });

  it('semicolon resets to command', () => {
    const input = 'a; b';
    const kinds = tokenize(input).map((t) => t.kind);
    expect(kinds).toEqual(['command', 'operator', 'command']);
  });

  it('redirection > does NOT reset to command (arg follows)', () => {
    const input = 'echo hi > out.txt';
    expect(projection(input, tokenize(input))).toEqual([
      { kind: 'command', text: 'echo' },
      { kind: 'text', text: 'hi' },
      { kind: 'operator', text: '>' },
      { kind: 'text', text: 'out.txt' },
    ]);
  });

  it('>> tokenizes as single operator', () => {
    const input = 'echo hi >> a';
    const ops = tokenize(input).filter((t) => t.kind === 'operator');
    expect(ops).toHaveLength(1);
    expect(input.slice(ops[0]!.start, ops[0]!.end)).toBe('>>');
  });

  it('double-quoted string', () => {
    const input = 'echo "hello world"';
    expect(projection(input, tokenize(input))).toEqual([
      { kind: 'command', text: 'echo' },
      { kind: 'string', text: '"hello world"' },
    ]);
  });

  it('single-quoted string (no escape inside)', () => {
    const input = "echo 'it\\'s'";
    const toks = tokenize(input);
    // Single quotes end at the first unescaped `'` — POSIX.
    const strTok = toks.find((t) => t.kind === 'string');
    expect(strTok).toBeDefined();
    expect(input.slice(strTok!.start, strTok!.end)).toBe("'it\\'");
  });

  it('escaped quote inside double-quoted string', () => {
    const input = 'echo "he said \\"hi\\""';
    const toks = tokenize(input);
    const str = toks.find((t) => t.kind === 'string')!;
    expect(input.slice(str.start, str.end)).toBe('"he said \\"hi\\""');
  });

  it('unterminated double-quoted string tokenizes to EOL', () => {
    const input = 'echo "unterminated';
    const toks = tokenize(input);
    const str = toks.find((t) => t.kind === 'string')!;
    expect(str.end).toBe(input.length);
  });

  it('variable $FOO', () => {
    const input = 'echo $HOME';
    expect(projection(input, tokenize(input))).toEqual([
      { kind: 'command', text: 'echo' },
      { kind: 'var', text: '$HOME' },
    ]);
  });

  it('variable ${FOO}', () => {
    const input = 'echo ${HOME}';
    const toks = tokenize(input);
    const v = toks.find((t) => t.kind === 'var')!;
    expect(input.slice(v.start, v.end)).toBe('${HOME}');
  });

  it('path with ./ prefix', () => {
    const input = 'cat ./foo';
    const kinds = tokenize(input).map((t) => t.kind);
    expect(kinds).toEqual(['command', 'path']);
  });

  it('path with ~ prefix', () => {
    const input = 'cd ~/src';
    const kinds = tokenize(input).map((t) => t.kind);
    expect(kinds).toEqual(['command', 'path']);
  });

  it('comment to end of line', () => {
    const input = 'ls # list files';
    expect(projection(input, tokenize(input))).toEqual([
      { kind: 'command', text: 'ls' },
      { kind: 'comment', text: '# list files' },
    ]);
  });

  it('backtick subshell', () => {
    const input = 'echo `date`';
    const toks = tokenize(input);
    const sub = toks.find((t) => t.kind === 'subshell')!;
    expect(input.slice(sub.start, sub.end)).toBe('`date`');
  });

  it('$( subshell sigil emits a subshell token and resets to command', () => {
    const input = 'echo $(date)';
    const toks = tokenize(input);
    // Expect: command 'echo', subshell '$(', command 'date', subshell ')'
    const kinds = toks.map((t) => t.kind);
    expect(kinds).toContain('subshell');
    // The word inside should be classified as a command (expectingCommand reset).
    const dateTok = toks.find(
      (t) => input.slice(t.start, t.end) === 'date',
    );
    expect(dateTok?.kind).toBe('command');
  });

  it('heredoc opener tokenizes << without breaking', () => {
    const input = 'cat <<EOF';
    const toks = tokenize(input);
    const kinds = toks.map((t) => t.kind);
    expect(kinds[0]).toBe('command');
    expect(kinds).toContain('operator');
  });

  it('tokens are start-sorted and non-overlapping', () => {
    const input = 'ls -la | grep "x" > out';
    const toks = tokenize(input);
    for (let i = 1; i < toks.length; i += 1) {
      expect(toks[i]!.start).toBeGreaterThanOrEqual(toks[i - 1]!.end);
    }
  });

  it('comment at start of input', () => {
    const input = '# just a note';
    expect(projection(input, tokenize(input))).toEqual([
      { kind: 'comment', text: '# just a note' },
    ]);
  });
});

/**
 * Parser unit tests.
 *
 * Each parser has three axes we exercise:
 *   1. The canonical happy path (plain zsh, EXTENDED zsh, timestamped bash,
 *      YAML-ish fish).
 *   2. Edge cases — adjacent-dedup, empty input, 5 000 cap, multi-line
 *      continuations, escape decoding.
 *   3. Malformed input — parsers must degrade gracefully, never throw.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_ENTRIES_PER_FILE,
  MAX_ENTRY_LENGTH,
  parseBashHistory,
  parseFishHistory,
  parseZshHistory,
} from '../parse.js';

describe('parseZshHistory', () => {
  it('parses plain (non-EXTENDED) entries', () => {
    const raw = ['ls', 'cd packages/ui', 'pnpm vitest run'].join('\n');
    expect(parseZshHistory(raw)).toEqual([
      'ls',
      'cd packages/ui',
      'pnpm vitest run',
    ]);
  });

  it('parses EXTENDED_HISTORY entries and strips the header', () => {
    const raw = [
      ': 1700000000:0;ls',
      ': 1700000001:5;git status',
      ': 1700000002:12;pnpm test',
    ].join('\n');
    expect(parseZshHistory(raw)).toEqual(['ls', 'git status', 'pnpm test']);
  });

  it('handles mixed plain + extended lines in the same file', () => {
    const raw = [': 1700000000:0;ls', 'cd packages/ui', ': 1700000002:0;pwd'].join(
      '\n',
    );
    expect(parseZshHistory(raw)).toEqual(['ls', 'cd packages/ui', 'pwd']);
  });

  it('collapses only ADJACENT duplicates, not non-adjacent repeats', () => {
    const raw = ['ls', 'ls', 'ls', 'cd /tmp', 'ls'].join('\n');
    // Three adjacent `ls` collapse to one; the final `ls` after `cd` is
    // preserved because recency matters.
    expect(parseZshHistory(raw)).toEqual(['ls', 'cd /tmp', 'ls']);
  });

  it('decodes \\n escapes and preserves literal backslashes', () => {
    const raw = `: 1700000000:0;echo 'multi\\nline'\n: 1700000001:0;printf '\\\\n'`;
    const parsed = parseZshHistory(raw);
    // First: \n is decoded to a real newline.
    expect(parsed[0]).toBe("echo 'multi\nline'");
    // Second: the literal "\n" sequence (from a printf call) round-trips.
    expect(parsed[1]).toBe("printf '\\n'");
  });

  it('joins multi-line commands on trailing-backslash continuations', () => {
    const raw = ['foo \\', 'bar \\', 'baz'].join('\n');
    expect(parseZshHistory(raw)).toEqual(['foo \nbar \nbaz']);
  });

  it('caps at MAX_ENTRIES_PER_FILE keeping the most recent', () => {
    const rows: string[] = [];
    const extra = 123; // push us over the cap deliberately
    for (let i = 0; i < MAX_ENTRIES_PER_FILE + extra; i += 1) {
      rows.push(`cmd-${i}`);
    }
    const parsed = parseZshHistory(rows.join('\n'));
    expect(parsed.length).toBe(MAX_ENTRIES_PER_FILE);
    // The tail is the most recent; we kept the LAST MAX_ENTRIES_PER_FILE.
    expect(parsed[parsed.length - 1]).toBe(`cmd-${MAX_ENTRIES_PER_FILE + extra - 1}`);
    expect(parsed[0]).toBe(`cmd-${extra}`);
  });

  it('handles empty input', () => {
    expect(parseZshHistory('')).toEqual([]);
  });

  it('tolerates malformed EXTENDED_HISTORY lines (missing semicolon)', () => {
    const raw = [': 1700000000:0 malformed', 'ls'].join('\n');
    // The malformed line becomes the "best-effort" command body —
    // parser must not throw.
    expect(() => parseZshHistory(raw)).not.toThrow();
    const parsed = parseZshHistory(raw);
    expect(parsed).toContain('ls');
  });

  it('tolerates \\r line endings (files from windows editors)', () => {
    const raw = 'ls\r\ncd /tmp\r\n';
    expect(parseZshHistory(raw)).toEqual(['ls', 'cd /tmp']);
  });

  it('truncates a 2000-char zsh entry to MAX_ENTRY_LENGTH, does not drop it', () => {
    const longCmd = 'a'.repeat(2000);
    const raw = `: 1700000000:0;${longCmd}`;
    const parsed = parseZshHistory(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(MAX_ENTRY_LENGTH);
    expect(parsed[0]).toBe('a'.repeat(MAX_ENTRY_LENGTH));
  });

  it('does NOT truncate a zsh entry that is exactly MAX_ENTRY_LENGTH chars', () => {
    const exactCmd = 'b'.repeat(MAX_ENTRY_LENGTH);
    const raw = `: 1700000000:0;${exactCmd}`;
    const parsed = parseZshHistory(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(MAX_ENTRY_LENGTH);
  });
});

describe('parseBashHistory', () => {
  it('parses simple one-command-per-line format', () => {
    expect(parseBashHistory(['ls', 'cd', 'pwd'].join('\n'))).toEqual([
      'ls',
      'cd',
      'pwd',
    ]);
  });

  it('drops #<epoch> timestamp lines', () => {
    const raw = [
      '#1700000000',
      'ls',
      '#1700000001',
      'cd',
      '#1700000002',
      'pwd',
    ].join('\n');
    expect(parseBashHistory(raw)).toEqual(['ls', 'cd', 'pwd']);
  });

  it('preserves `#` that are part of a real comment (non-all-digit)', () => {
    const raw = ['# this is a comment', 'ls'].join('\n');
    expect(parseBashHistory(raw)).toEqual(['# this is a comment', 'ls']);
  });

  it('collapses adjacent duplicates', () => {
    const raw = ['ls', 'ls', 'ls'].join('\n');
    expect(parseBashHistory(raw)).toEqual(['ls']);
  });

  it('handles empty input', () => {
    expect(parseBashHistory('')).toEqual([]);
  });

  it('caps at MAX_ENTRIES_PER_FILE', () => {
    const rows: string[] = [];
    for (let i = 0; i < MAX_ENTRIES_PER_FILE + 50; i += 1) {
      rows.push(`cmd-${i}`);
    }
    const parsed = parseBashHistory(rows.join('\n'));
    expect(parsed.length).toBe(MAX_ENTRIES_PER_FILE);
    expect(parsed[parsed.length - 1]).toBe(`cmd-${MAX_ENTRIES_PER_FILE + 49}`);
  });

  it('truncates a 1025-char bash entry to MAX_ENTRY_LENGTH, does not drop it', () => {
    const longCmd = 'x'.repeat(1025);
    const parsed = parseBashHistory(longCmd);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(MAX_ENTRY_LENGTH);
  });

  it('does NOT truncate a bash entry that is exactly MAX_ENTRY_LENGTH chars', () => {
    const exactCmd = 'y'.repeat(MAX_ENTRY_LENGTH);
    const parsed = parseBashHistory(exactCmd);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(MAX_ENTRY_LENGTH);
  });
});

describe('parseFishHistory', () => {
  it('parses a typical fish_history block set', () => {
    const raw = [
      '- cmd: ls',
      '  when: 1700000000',
      '- cmd: cd /tmp',
      '  when: 1700000001',
      '  paths:',
      '    - /tmp',
      '- cmd: pwd',
      '  when: 1700000002',
    ].join('\n');
    expect(parseFishHistory(raw)).toEqual(['ls', 'cd /tmp', 'pwd']);
  });

  it('decodes \\n in cmd values into real newlines', () => {
    const raw = ['- cmd: echo foo\\nbar', '  when: 1700000000'].join('\n');
    expect(parseFishHistory(raw)).toEqual(['echo foo\nbar']);
  });

  it('collapses adjacent duplicates', () => {
    const raw = [
      '- cmd: ls',
      '  when: 1',
      '- cmd: ls',
      '  when: 2',
      '- cmd: ls',
      '  when: 3',
    ].join('\n');
    expect(parseFishHistory(raw)).toEqual(['ls']);
  });

  it('handles empty input', () => {
    expect(parseFishHistory('')).toEqual([]);
  });

  it('ignores unrelated keys (paths, when) between cmd blocks', () => {
    const raw = [
      '- cmd: ls',
      '  when: 1',
      '  paths:',
      '    - /a',
      '    - /b',
      '- cmd: pwd',
    ].join('\n');
    expect(parseFishHistory(raw)).toEqual(['ls', 'pwd']);
  });

  it('truncates a 2000-char fish cmd to MAX_ENTRY_LENGTH, does not drop it', () => {
    const longCmd = 'z'.repeat(2000);
    const raw = `- cmd: ${longCmd}\n  when: 1700000000`;
    const parsed = parseFishHistory(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(MAX_ENTRY_LENGTH);
  });

  it('does NOT truncate a fish cmd that is exactly MAX_ENTRY_LENGTH chars', () => {
    const exactCmd = 'w'.repeat(MAX_ENTRY_LENGTH);
    const raw = `- cmd: ${exactCmd}\n  when: 1700000000`;
    const parsed = parseFishHistory(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toHaveLength(MAX_ENTRY_LENGTH);
  });
});

import { describe, expect, it } from 'vitest';
import { parseGitHead } from '../parse-head.js';

describe('parseGitHead', () => {
  it('parses a standard `ref: refs/heads/<branch>` line', () => {
    const parsed = parseGitHead('ref: refs/heads/main\n');
    expect(parsed).toEqual({ branch: 'main', detached: false, shortSha: null });
  });

  it('handles branch names containing slashes', () => {
    const parsed = parseGitHead('ref: refs/heads/feature/nested-path\n');
    expect(parsed.branch).toBe('feature/nested-path');
  });

  it('surfaces a short sha when HEAD is detached (sha1)', () => {
    const parsed = parseGitHead('0123456789abcdef0123456789abcdef01234567\n');
    expect(parsed.detached).toBe(true);
    expect(parsed.shortSha).toBe('0123456');
    expect(parsed.branch).toBeNull();
  });

  it('recognises sha256 object ids', () => {
    const sha = 'a'.repeat(64);
    const parsed = parseGitHead(sha + '\n');
    expect(parsed.detached).toBe(true);
    expect(parsed.shortSha).toBe('aaaaaaa');
  });

  it('returns null for empty / garbage input', () => {
    expect(parseGitHead('').branch).toBeNull();
    expect(parseGitHead('').detached).toBe(false);
    expect(parseGitHead('something weird\n').branch).toBeNull();
  });

  it('falls back to the last segment for non-`refs/heads` symbolic refs', () => {
    const parsed = parseGitHead('ref: refs/tags/v1.2.3\n');
    expect(parsed.branch).toBe('v1.2.3');
    expect(parsed.detached).toBe(false);
  });
});

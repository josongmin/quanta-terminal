/**
 * Detector — pattern coverage + overlap resolution. Every test here exercises
 * one of the acceptance criteria from the 2026 security-essential mission.
 */

import { describe, expect, it } from 'vitest';
import { detectSecrets, maskSecretsInText } from '../detector.js';

describe('detectSecrets — AWS access key', () => {
  it('matches a well-formed AKIA prefix + 16 uppercase-alnum suffix', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const text = `export AWS_ACCESS_KEY_ID=${key}`;
    const matches = detectSecrets(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.kind).toBe('aws-access-key');
    expect(matches[0]!.value).toBe(key);
    // Byte-exact offsets line up with the source string.
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe(key);
  });

  it('rejects a short AKIA-prefixed string (false-positive guard)', () => {
    // 15-char suffix — one short of the AWS spec.
    const text = 'AKIA123456789012345';
    const matches = detectSecrets(text).filter((m) => m.kind === 'aws-access-key');
    expect(matches).toHaveLength(0);
  });
});

describe('detectSecrets — GitHub tokens', () => {
  it('matches a ghp_ PAT', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123';
    const matches = detectSecrets(`auth: ${token}`);
    const github = matches.filter((m) => m.kind === 'github-pat');
    expect(github).toHaveLength(1);
    expect(github[0]!.value).toBe(token);
  });

  it('matches a gho_ OAuth token under a different kind', () => {
    // 36-char alphanumeric suffix (GitHub's published PAT body length).
    const token = 'gho_abcdefghijklmnopqrstuvwxyz0123456789';
    const matches = detectSecrets(`header ${token} footer`);
    expect(matches.some((m) => m.kind === 'github-oauth' && m.value === token)).toBe(true);
  });
});

describe('detectSecrets — JWT', () => {
  it('matches a three-segment base64url token', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const matches = detectSecrets(jwt);
    const jwtMatches = matches.filter((m) => m.kind === 'jwt');
    expect(jwtMatches).toHaveLength(1);
    expect(jwtMatches[0]!.value).toBe(jwt);
  });

  it('does not match a two-segment base64url-looking string', () => {
    const notJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0';
    const matches = detectSecrets(notJwt).filter((m) => m.kind === 'jwt');
    expect(matches).toHaveLength(0);
  });
});

describe('detectSecrets — OpenAI / Slack / SSH header', () => {
  it('matches sk-<40+ alnum>', () => {
    const key = 'sk-' + 'a'.repeat(48);
    const matches = detectSecrets(`key: ${key}`);
    expect(matches.some((m) => m.kind === 'openai-key' && m.value === key)).toBe(true);
  });

  it('matches xoxb-… Slack bot tokens', () => {
    const token = 'xoxb-12345678901-1234567890-ABCDEFabcdef1234567890';
    const matches = detectSecrets(token);
    expect(matches.some((m) => m.kind === 'slack-token')).toBe(true);
  });

  it('matches an SSH private key header line', () => {
    const header = '-----BEGIN OPENSSH PRIVATE KEY-----';
    const matches = detectSecrets(`${header}\nbase64body\n-----END OPENSSH PRIVATE KEY-----`);
    expect(matches.some((m) => m.kind === 'ssh-private-key' && m.value === header)).toBe(true);
  });
});

describe('detectSecrets — multiple matches', () => {
  it('finds every hit in a multi-secret string and returns them sorted', () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const ghToken = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123';
    const text = `echo "aws=${awsKey}"; echo "gh=${ghToken}"; done`;
    const matches = detectSecrets(text);
    // Both secrets are found.
    expect(matches.some((m) => m.value === awsKey)).toBe(true);
    expect(matches.some((m) => m.value === ghToken)).toBe(true);
    // Output is sorted by start ascending.
    for (let i = 1; i < matches.length; i += 1) {
      expect(matches[i]!.start).toBeGreaterThanOrEqual(matches[i - 1]!.end);
    }
  });
});

describe('detectSecrets — overlap resolution', () => {
  it('prefers the longer match when two patterns overlap', () => {
    // A 40-char base64 run that also happens to be a valid JWT fragment —
    // the JWT pattern is longer over the overlap so it should win.
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
      'eyJzdWIiOiJhYmNkIn0.' +
      'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const matches = detectSecrets(jwt);
    // The JWT pattern wins — no stray aws-secret match eats part of it.
    const jwtHits = matches.filter((m) => m.kind === 'jwt');
    const awsSecretHits = matches.filter((m) => m.kind === 'aws-secret');
    expect(jwtHits).toHaveLength(1);
    expect(jwtHits[0]!.start).toBe(0);
    expect(jwtHits[0]!.end).toBe(jwt.length);
    // Any aws-secret match that existed as "raw" must have been dropped in
    // favour of the JWT range — we expect ZERO aws-secret matches here.
    expect(awsSecretHits).toHaveLength(0);
  });

  it('returns non-overlapping ranges even with a generic-token fallback', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123';
    const line = `api_key="${token}"`;
    const matches = detectSecrets(line);
    // Non-overlapping invariant holds.
    for (let i = 1; i < matches.length; i += 1) {
      expect(matches[i]!.start).toBeGreaterThanOrEqual(matches[i - 1]!.end);
    }
  });
});

describe('detectSecrets — performance / ReDoS guard', () => {
  it('scans ~100 KB of benign text in well under 100 ms', () => {
    const benign = 'hello world '.repeat(10_000); // ~120 KB
    const start = performance.now();
    const matches = detectSecrets(benign);
    const elapsed = performance.now() - start;
    expect(matches).toHaveLength(0);
    expect(elapsed).toBeLessThan(100);
  });

  it('does not hang on an adversarial string of repeated A characters', () => {
    // A classic ReDoS probe: a long run of a single character. Each of our
    // patterns has bounded quantifiers, so this should be linear.
    const adversarial = 'A'.repeat(50_000);
    const start = performance.now();
    detectSecrets(adversarial);
    expect(performance.now() - start).toBeLessThan(100);
  });
});

describe('detectSecrets — empty / unaffected inputs', () => {
  it('returns [] for the empty string without allocating', () => {
    const out = detectSecrets('');
    expect(out).toEqual([]);
  });

  it('returns [] for text with no secrets', () => {
    expect(detectSecrets('hello world')).toEqual([]);
  });
});

describe('maskSecretsInText', () => {
  it('replaces a GitHub PAT with bullets + human label, keeping surrounding text', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEF0123';
    const masked = maskSecretsInText(`before ${token} after`);
    expect(masked).not.toContain(token);
    expect(masked).toContain('[hidden GitHub PAT]');
    expect(masked.startsWith('before ')).toBe(true);
    expect(masked.endsWith(' after')).toBe(true);
  });

  it('returns the input untouched when no secrets are detected', () => {
    const unchanged = 'just a harmless log line';
    expect(maskSecretsInText(unchanged)).toBe(unchanged);
  });
});

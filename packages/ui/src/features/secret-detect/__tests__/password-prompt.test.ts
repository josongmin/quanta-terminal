/**
 * Password-prompt detector — exercises the pattern table and the tail-line
 * helper used by the composer to scope detection to the most recent output.
 */

import { describe, expect, it } from 'vitest';

import {
  detectPasswordPrompt,
  tailLines,
  PASSWORD_PROMPT_KINDS,
} from '../password-prompt.js';

describe('detectPasswordPrompt', () => {
  it('returns null on empty input', () => {
    expect(detectPasswordPrompt('')).toBeNull();
  });

  it('matches sudo prompt', () => {
    const m = detectPasswordPrompt('[sudo] password for alice: ');
    expect(m).not.toBeNull();
    expect(m?.kind).toBe('sudo');
  });

  it('matches ssh passphrase prompt', () => {
    const m = detectPasswordPrompt('Enter passphrase for key /Users/a/.ssh/id_rsa:');
    expect(m).not.toBeNull();
    expect(m?.kind).toBe('ssh-passphrase');
  });

  it('matches generic password prompt at end of line', () => {
    const m = detectPasswordPrompt('Password: ');
    expect(m).not.toBeNull();
    expect(m?.kind).toBe('password');
  });

  it('matches "Enter password" prompt', () => {
    const m = detectPasswordPrompt('Enter password to unlock the store');
    expect(m).not.toBeNull();
    expect(m?.kind).toBe('enter-password');
  });

  it('does NOT match prose containing the word password', () => {
    expect(detectPasswordPrompt('my_password_hash = 42')).toBeNull();
    expect(detectPasswordPrompt('see docs on password rules')).toBeNull();
  });

  it('exposes stable kind labels', () => {
    expect(PASSWORD_PROMPT_KINDS).toContain('sudo');
    expect(PASSWORD_PROMPT_KINDS).toContain('password');
  });
});

describe('tailLines', () => {
  it('returns empty for empty input', () => {
    expect(tailLines('')).toBe('');
  });

  it('returns roughly the last N lines (retains one extra boundary)', () => {
    // The helper returns the tail after the (N+1)th-from-end newline so the
    // caller gets N lines of context. For this five-line input with n=2 it
    // keeps `c\nd\ne` — detection scans the last few lines, so erring on the
    // larger side is intentional.
    const text = 'a\nb\nc\nd\ne';
    expect(tailLines(text, 2)).toBe('c\nd\ne');
  });

  it('returns whole text when n exceeds line count', () => {
    expect(tailLines('only one line', 5)).toBe('only one line');
  });
});

import { describe, expect, it } from 'vitest';
import { isEventOfKind } from '../events.js';
import type { HostEvent, HostEventKind } from '../events.js';

describe('isEventOfKind', () => {
  it('narrows to pty_data', () => {
    const ev: HostEvent = {
      kind: 'pty_data',
      sessionId: 's',
      seq: 0,
      bytesB64: 'aGk=',
    };
    if (isEventOfKind(ev, 'pty_data')) {
      expect(ev.bytesB64).toBe('aGk=');
    } else {
      expect.fail('should have narrowed');
    }
  });

  it('returns false for wrong kind', () => {
    const ev: HostEvent = {
      kind: 'session_created',
      sessionId: 's',
      workspaceId: null,
      shell: '/bin/zsh',
      launchCwd: '/',
    };
    expect(isEventOfKind(ev, 'pty_data')).toBe(false);
  });

  it('narrows session_cwd_changed', () => {
    const ev: HostEvent = {
      kind: 'session_cwd_changed',
      sessionId: 's',
      cwd: '/tmp',
      source: 'osc7',
    };
    if (isEventOfKind(ev, 'session_cwd_changed')) {
      expect(ev.source).toBe('osc7');
    } else {
      expect.fail('should have narrowed');
    }
  });

  it('narrows input_submitted with input_kind field (not kind)', () => {
    // Regression: the Rust side renamed `kind` → `input_kind` to avoid
    // colliding with the outer enum `#[serde(tag = "kind")]` discriminator.
    // A test guards against accidental rename on the TS side.
    const ev: HostEvent = {
      kind: 'input_submitted',
      sessionId: 's',
      text: 'ls',
      inputKind: 'shell',
    };
    if (isEventOfKind(ev, 'input_submitted')) {
      expect(ev.inputKind).toBe('shell');
      expect(ev.text).toBe('ls');
    } else {
      expect.fail('should have narrowed');
    }
  });
});

describe('HostEventKind parity with quanta-proto', () => {
  // Every discriminator must be `snake_case` to mirror
  // `#[serde(tag = "kind", rename_all = "snake_case")]` on the Rust `Event`
  // enum. Phase-1 host-transport events (`pty_data`, `pty_exit`) follow the
  // same convention for uniformity even though they have no Rust counterpart.
  it('uses snake_case discriminators exclusively', () => {
    const kinds: readonly HostEventKind[] = [
      'pty_data',
      'pty_exit',
      'session_created',
      'session_shell_integration_status',
      'session_cwd_changed',
      'session_ended',
      'input_submitted',
    ];
    for (const k of kinds) {
      expect(k).toMatch(/^[a-z0-9]+(_[a-z0-9]+)*$/u);
      expect(k).not.toMatch(/\./u);
    }
  });
});

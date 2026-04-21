/**
 * Session profiles store tests.
 *
 * Covers the store-level contract:
 *   - add/update/remove profiles
 *   - setDefault + default-invariant when the default is removed
 *   - localStorage persistence (write + read-back)
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  ENV_KEY_PATTERN,
  MAX_STARTUP_ENV_ENTRIES,
  SESSION_PROFILES_STORAGE_KEY,
  SHELL_PATHS,
  isValidEnvKey,
  kindForShellPath,
  readStored,
  sanitizeStartupEnv,
  useSessionProfiles,
} from '../model.js';

/** jsdom in this project has no localStorage by default — shim one. */
function installStorage(): void {
  const data = new Map<string, string>();
  const api: Storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(k) {
      return data.has(k) ? data.get(k)! : null;
    },
    key(i) {
      return Array.from(data.keys())[i] ?? null;
    },
    removeItem(k) {
      data.delete(k);
    },
    setItem(k, v) {
      data.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: api,
  });
}

beforeEach(() => {
  installStorage();
  useSessionProfiles.getState().reset();
});

describe('useSessionProfiles', () => {
  it('seeds a built-in default profile on first read', () => {
    const s = useSessionProfiles.getState();
    expect(s.order.length).toBe(1);
    const def = s.entities[s.defaultId];
    expect(def).toBeDefined();
    expect(def!.name).toBe('Default');
    expect(def!.shell).toBe(''); // empty = host default
  });

  it('addProfile appends and persists', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Fish @ work',
      shell: SHELL_PATHS.fish,
      cwd: '/Users/me/work',
    });
    const s = useSessionProfiles.getState();
    expect(s.order).toContain(id);
    expect(s.entities[id]?.name).toBe('Fish @ work');
    expect(s.entities[id]?.cwd).toBe('/Users/me/work');
    expect(s.entities[id]?.shell).toBe(SHELL_PATHS.fish);
    // Persistence round-trip.
    const raw = localStorage.getItem(SESSION_PROFILES_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const restored = readStored();
    expect(restored.entities[id]?.shell).toBe(SHELL_PATHS.fish);
  });

  it('updateProfile patches fields and leaves others untouched', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Zsh',
      shell: SHELL_PATHS.zsh,
      env: { FOO: 'bar' },
    });
    useSessionProfiles.getState().updateProfile(id, { name: 'Renamed' });
    const profile = useSessionProfiles.getState().entities[id];
    expect(profile?.name).toBe('Renamed');
    expect(profile?.shell).toBe(SHELL_PATHS.zsh);
    expect(profile?.env?.FOO).toBe('bar');
  });

  it('updateProfile with empty cwd/env clears them', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'X',
      shell: SHELL_PATHS.bash,
      cwd: '/tmp',
      env: { A: '1' },
    });
    useSessionProfiles.getState().updateProfile(id, { cwd: '', env: {} });
    const profile = useSessionProfiles.getState().entities[id];
    expect(profile?.cwd).toBeUndefined();
    expect(profile?.env).toBeUndefined();
  });

  it('removeProfile drops the entry and preserves a valid default', () => {
    const a = useSessionProfiles.getState().addProfile({ name: 'A', shell: '' });
    const b = useSessionProfiles.getState().addProfile({ name: 'B', shell: '' });
    useSessionProfiles.getState().setDefault(a);
    useSessionProfiles.getState().removeProfile(a);
    const s = useSessionProfiles.getState();
    expect(s.order).not.toContain(a);
    expect(s.order).toContain(b);
    // Default falls back to the first remaining profile (the built-in seeded
    // default is first, then b).
    expect(s.entities[s.defaultId]).toBeDefined();
  });

  it('removeProfile on the last profile re-seeds the built-in default', () => {
    const s = useSessionProfiles.getState();
    // First remove every profile.
    for (const id of [...s.order]) {
      useSessionProfiles.getState().removeProfile(id);
    }
    const after = useSessionProfiles.getState();
    expect(after.order.length).toBe(1);
    expect(after.entities[after.defaultId]?.name).toBe('Default');
  });

  it('setDefault only accepts known ids', () => {
    const id = useSessionProfiles.getState().addProfile({ name: 'Alt', shell: '' });
    useSessionProfiles.getState().setDefault(id);
    expect(useSessionProfiles.getState().defaultId).toBe(id);
    useSessionProfiles.getState().setDefault('does-not-exist');
    // Unchanged — unknown ids are ignored.
    expect(useSessionProfiles.getState().defaultId).toBe(id);
  });

  it('kindForShellPath classifies known paths and falls back to custom', () => {
    expect(kindForShellPath(SHELL_PATHS.zsh)).toBe('zsh');
    expect(kindForShellPath(SHELL_PATHS.bash)).toBe('bash');
    expect(kindForShellPath(SHELL_PATHS.fish)).toBe('fish');
    expect(kindForShellPath('/usr/local/bin/nu')).toBe('custom');
    expect(kindForShellPath('')).toBe('custom');
  });
});

describe('readStored', () => {
  it('returns fresh initial when localStorage is empty', () => {
    const s = readStored();
    expect(s.order.length).toBe(1);
    expect(Object.keys(s.entities).length).toBe(1);
  });

  it('returns fresh initial on malformed JSON', () => {
    localStorage.setItem(SESSION_PROFILES_STORAGE_KEY, 'not-json');
    const s = readStored();
    expect(s.order.length).toBe(1);
  });

  it('round-trips a user-created profile', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Bash root',
      shell: SHELL_PATHS.bash,
      cwd: '/',
      env: { PROMPT: 'x' },
    });
    const s = readStored();
    expect(s.entities[id]?.cwd).toBe('/');
    expect(s.entities[id]?.env?.PROMPT).toBe('x');
  });

  it('hydrates an old serialized profile (no startupCommands) with defaults', () => {
    // Simulate a localStorage blob written by a pre-startup-commands build:
    // the `env` key exists but `startupCommands` is absent entirely.
    const legacy = {
      order: ['legacy'],
      entities: {
        legacy: {
          id: 'legacy',
          name: 'Old',
          shell: SHELL_PATHS.zsh,
          cwd: '/tmp',
          env: { FOO: 'bar' },
          // no startupCommands key
        },
      },
      defaultId: 'legacy',
    };
    localStorage.setItem(SESSION_PROFILES_STORAGE_KEY, JSON.stringify(legacy));
    const s = readStored();
    const p = s.entities['legacy'];
    expect(p).toBeDefined();
    expect(p?.cwd).toBe('/tmp');
    expect(p?.env?.FOO).toBe('bar');
    // Missing field hydrates to undefined (== "no startup commands").
    expect(p?.startupCommands).toBeUndefined();
  });

  it('round-trips startupCommands on a user-created profile', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Dev',
      shell: SHELL_PATHS.zsh,
      startupCommands: ['cd ~/projects/foo', 'pnpm dev'],
    });
    const s = readStored();
    expect(s.entities[id]?.startupCommands).toEqual(['cd ~/projects/foo', 'pnpm dev']);
  });
});

describe('sanitizeStartupCommands (Bug 3 — null bytes and control chars)', () => {
  it('filters out commands that contain a null byte', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'NullTest',
      shell: SHELL_PATHS.zsh,
      startupCommands: ['valid command', 'bad\x00command', 'another valid'],
    });
    const cmds = useSessionProfiles.getState().entities[id]?.startupCommands;
    expect(cmds).toEqual(['valid command', 'another valid']);
  });

  it('strips ESC sequences but preserves printable text', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'EscTest',
      shell: SHELL_PATHS.zsh,
      startupCommands: ['\x1b[31mcolored text\x1b[0m'],
    });
    const cmds = useSessionProfiles.getState().entities[id]?.startupCommands;
    // Control chars stripped; printable text preserved
    expect(cmds).toEqual(['[31mcolored text[0m']);
  });

  it('preserves embedded newlines in multi-line commands', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'MultilineTest',
      shell: SHELL_PATHS.zsh,
      startupCommands: ['line1\nline2\nline3'],
    });
    const cmds = useSessionProfiles.getState().entities[id]?.startupCommands;
    expect(cmds).toEqual(['line1\nline2\nline3']);
  });

  it('round-trips sanitized commands through readStored', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'RoundTrip',
      shell: SHELL_PATHS.bash,
      startupCommands: ['clean cmd', 'has\x00null', '\x1b[1mbold\x1b[m'],
    });
    const s = readStored();
    const cmds = s.entities[id]?.startupCommands;
    // null-byte command dropped; ESC stripped but text kept
    expect(cmds).toContain('clean cmd');
    expect(cmds).not.toContain(expect.stringContaining('\x00'));
    expect(cmds?.some((c) => c.includes('\x1b'))).toBe(false);
  });
});

describe('env validation', () => {
  it('isValidEnvKey accepts POSIX-style names', () => {
    expect(isValidEnvKey('PATH')).toBe(true);
    expect(isValidEnvKey('_PRIVATE')).toBe(true);
    expect(isValidEnvKey('NODE_ENV')).toBe(true);
    expect(isValidEnvKey('DEBUG1')).toBe(true);
    expect(isValidEnvKey('A')).toBe(true);
  });

  it('isValidEnvKey rejects invalid names', () => {
    expect(isValidEnvKey('')).toBe(false);
    expect(isValidEnvKey('1FOO')).toBe(false); // leading digit
    expect(isValidEnvKey('foo')).toBe(false); // lowercase
    expect(isValidEnvKey('FO-O')).toBe(false); // hyphen
    expect(isValidEnvKey('FOO BAR')).toBe(false); // space
    expect(isValidEnvKey('FOO.BAR')).toBe(false); // dot
  });

  it('ENV_KEY_PATTERN matches the expected alphabet', () => {
    expect(ENV_KEY_PATTERN.test('ABC_123')).toBe(true);
    expect(ENV_KEY_PATTERN.test('abc')).toBe(false);
  });

  it('sanitizeStartupEnv drops invalid keys and non-string values', () => {
    const out = sanitizeStartupEnv({
      GOOD: 'x',
      '1bad': 'y',
      lower: 'z',
      EMPTY: '',
      BAD_VALUE: 42 as unknown as string,
    });
    expect(out).toEqual({ GOOD: 'x', EMPTY: '' });
  });

  it(`sanitizeStartupEnv caps at ${MAX_STARTUP_ENV_ENTRIES} entries`, () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < MAX_STARTUP_ENV_ENTRIES + 5; i += 1) {
      input[`VAR_${i}`] = String(i);
    }
    const out = sanitizeStartupEnv(input);
    expect(Object.keys(out).length).toBe(MAX_STARTUP_ENV_ENTRIES);
  });

  it('addProfile drops invalid env keys at seed time', () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Noisy',
      shell: SHELL_PATHS.zsh,
      env: { OK: '1', '9bad': '2', lower: '3' } as Record<string, string>,
    });
    const p = useSessionProfiles.getState().entities[id];
    expect(p?.env).toEqual({ OK: '1' });
  });
});

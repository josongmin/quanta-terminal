import { describe, expect, it } from 'vitest';
import { DEFAULT_KNOWN_COMMANDS, classifyCommand } from '../classify.js';

describe('classifyCommand', () => {
  it('empty string is unknown', () => {
    expect(classifyCommand('')).toBe('unknown');
  });

  it('allowlist match is known', () => {
    expect(classifyCommand('git')).toBe('known');
    expect(classifyCommand('ls')).toBe('known');
    expect(classifyCommand('pnpm')).toBe('known');
    expect(classifyCommand('kubectl')).toBe('known');
  });

  it('unknown command is unknown', () => {
    expect(classifyCommand('totally-made-up-tool')).toBe('unknown');
  });

  it('history fallback promotes to known', () => {
    const history = new Set(['my-custom-tool']);
    expect(
      classifyCommand('my-custom-tool', { historyCommands: history }),
    ).toBe('known');
  });

  it('commands are case-sensitive (Unix)', () => {
    expect(classifyCommand('LS')).toBe('unknown');
    expect(classifyCommand('Git')).toBe('unknown');
    expect(classifyCommand('ls')).toBe('known');
  });

  it('path-style invocation is known', () => {
    expect(classifyCommand('./my-script')).toBe('known');
    expect(classifyCommand('/usr/bin/foo')).toBe('known');
    expect(classifyCommand('../bin/tool')).toBe('known');
    expect(classifyCommand('~/bin/z')).toBe('known');
  });

  it('default allowlist includes ~50 common commands', () => {
    // Sanity: the allowlist isn't trivially tiny.
    expect(DEFAULT_KNOWN_COMMANDS.size).toBeGreaterThanOrEqual(50);
  });

  it('custom allowlist overrides default', () => {
    const custom = new Set(['only-this']);
    expect(classifyCommand('git', { knownCommands: custom })).toBe('unknown');
    expect(classifyCommand('only-this', { knownCommands: custom })).toBe('known');
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatShortcutHint } from '../keymap.js';

/**
 * Stubs `navigator.platform` so we can exercise both mac and non-mac
 * formatting. jsdom's default platform string varies by the host OS —
 * explicit override keeps the test deterministic.
 */
function stubPlatform(value: string): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(navigator, 'platform');
  Object.defineProperty(navigator, 'platform', {
    configurable: true,
    value,
  });
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(navigator, 'platform', originalDescriptor);
    } else {
      // `delete` is safer than reassigning to ''.
      // @ts-expect-error — intentional cleanup on a patched global.
      delete navigator.platform;
    }
  };
}

describe('formatShortcutHint', () => {
  let restore: (() => void) | null = null;
  beforeEach(() => {
    restore = null;
  });
  afterEach(() => {
    restore?.();
  });

  it('formats mod+k as ⌘K on macOS', () => {
    restore = stubPlatform('MacIntel');
    expect(formatShortcutHint('mod+k')).toBe('⌘K');
  });

  it('formats mod+k as Ctrl+K on Linux', () => {
    restore = stubPlatform('Linux x86_64');
    expect(formatShortcutHint('mod+k')).toBe('Ctrl+K');
  });

  it('formats mod+k as Ctrl+K on Windows', () => {
    restore = stubPlatform('Win32');
    expect(formatShortcutHint('mod+k')).toBe('Ctrl+K');
  });

  it('formats mod+shift+k as ⌘⇧K on macOS', () => {
    restore = stubPlatform('MacIntel');
    expect(formatShortcutHint('mod+shift+k')).toBe('⌘⇧K');
  });

  it('formats mod+shift+k as Ctrl+Shift+K elsewhere', () => {
    restore = stubPlatform('Linux x86_64');
    expect(formatShortcutHint('mod+shift+k')).toBe('Ctrl+Shift+K');
  });

  it('pretty-prints named keys (escape, enter, arrows, comma)', () => {
    restore = stubPlatform('Linux x86_64');
    expect(formatShortcutHint('escape')).toBe('Esc');
    expect(formatShortcutHint('mod+,')).toBe('Ctrl+,');
    expect(formatShortcutHint('mod+up')).toBe('Ctrl+↑');
    expect(formatShortcutHint('mod+enter')).toBe('Ctrl+Enter');
  });

  it('renders enter as ↵ on macOS', () => {
    restore = stubPlatform('MacIntel');
    expect(formatShortcutHint('mod+enter')).toBe('⌘↵');
  });

  it('renders alt and meta modifiers', () => {
    restore = stubPlatform('MacIntel');
    expect(formatShortcutHint('alt+shift+k')).toBe('⌥⇧K');
    // `cmd+k` on mac is ⌘K; on other platforms it becomes `Win+K`.
    expect(formatShortcutHint('cmd+k')).toBe('⌘K');
  });

  it('handles complex compound shortcut mod+alt+shift+a', () => {
    restore = stubPlatform('Linux x86_64');
    expect(formatShortcutHint('mod+alt+shift+a')).toBe('Ctrl+Alt+Shift+A');
  });

  describe('explicit platform arg (no navigator probe)', () => {
    it('formats mod+k as ⌘K when platform="macos"', () => {
      expect(formatShortcutHint('mod+k', 'macos')).toBe('⌘K');
    });

    it('formats mod+k as Ctrl+K when platform="linux"', () => {
      expect(formatShortcutHint('mod+k', 'linux')).toBe('Ctrl+K');
    });

    it('formats mod+shift+p as ⌘⇧P on macos', () => {
      expect(formatShortcutHint('mod+shift+p', 'macos')).toBe('⌘⇧P');
    });

    it('formats mod+alt+c as Ctrl+Alt+C on windows', () => {
      expect(formatShortcutHint('mod+alt+c', 'windows')).toBe('Ctrl+Alt+C');
    });

    it('treats the legacy "mac" alias as "macos"', () => {
      expect(formatShortcutHint('mod+k', 'mac')).toBe('⌘K');
    });

    it('falls back to linux-style when navigator is indeterminate ("auto")', () => {
      // `auto` + unknown navigator (the stub leaves navigator.platform = '')
      // must not reach for a Mac layout; verify by asserting the non-mac
      // split. Empty string means `isMac()` returns false, so the format is
      // `Ctrl+K` with a literal plus.
      restore = stubPlatform('');
      expect(formatShortcutHint('mod+k')).toBe('Ctrl+K');
    });
  });
});

import { describe, expect, it, vi } from 'vitest';

import { canonicalizeKeyEvent, captureNextShortcut } from '../record.js';

function keyEvent(partial: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...partial });
}

describe('canonicalizeKeyEvent', () => {
  it('returns the canonical form for mod+shift+P', () => {
    // On a Mac the browser sets metaKey; on non-mac, ctrlKey. Both resolve to
    // `mod` in our canonical form.
    const onMac = canonicalizeKeyEvent(keyEvent({ key: 'P', metaKey: true, shiftKey: true }));
    const onLinux = canonicalizeKeyEvent(keyEvent({ key: 'P', ctrlKey: true, shiftKey: true }));
    expect(onMac).toBe('mod+shift+p');
    expect(onLinux).toBe('mod+shift+p');
  });

  it('rejects a bare printable letter (no modifier)', () => {
    expect(canonicalizeKeyEvent(keyEvent({ key: 'a' }))).toBeNull();
  });

  it('accepts function keys standalone', () => {
    expect(canonicalizeKeyEvent(keyEvent({ key: 'F5' }))).toBe('f5');
    expect(canonicalizeKeyEvent(keyEvent({ key: 'F12', shiftKey: true }))).toBe('shift+f12');
  });

  it('returns null for Escape', () => {
    expect(canonicalizeKeyEvent(keyEvent({ key: 'Escape' }))).toBeNull();
  });

  it('returns null for lone modifier presses', () => {
    expect(canonicalizeKeyEvent(keyEvent({ key: 'Shift', shiftKey: true }))).toBeNull();
    expect(canonicalizeKeyEvent(keyEvent({ key: 'Meta', metaKey: true }))).toBeNull();
    expect(canonicalizeKeyEvent(keyEvent({ key: 'Control', ctrlKey: true }))).toBeNull();
  });

  it('allows shift+letter because the glyph is distinct', () => {
    expect(canonicalizeKeyEvent(keyEvent({ key: 'A', shiftKey: true }))).toBe('shift+a');
  });
});

describe('captureNextShortcut', () => {
  it('resolves with the canonical form after a valid keydown', async () => {
    const p = captureNextShortcut();
    window.dispatchEvent(keyEvent({ key: 'p', metaKey: true, shiftKey: true }));
    await expect(p).resolves.toBe('mod+shift+p');
  });

  it('resolves with null on Escape', async () => {
    const p = captureNextShortcut();
    window.dispatchEvent(keyEvent({ key: 'Escape' }));
    await expect(p).resolves.toBeNull();
  });

  it('ignores bare letters and resolves on the next valid combination', async () => {
    const p = captureNextShortcut();
    // A bare letter should not resolve the promise — it's swallowed.
    window.dispatchEvent(keyEvent({ key: 'x' }));
    // Now a valid combo fires and wins.
    window.dispatchEvent(keyEvent({ key: 'n', ctrlKey: true }));
    await expect(p).resolves.toBe('mod+n');
  });

  it('resolves null when the AbortSignal fires', async () => {
    const controller = new AbortController();
    const p = captureNextShortcut({ signal: controller.signal });
    controller.abort();
    await expect(p).resolves.toBeNull();
  });
});

describe('captureNextShortcut — Bug 4 auto-timeout', () => {
  it('resolves null after timeoutMs when no key is pressed', async () => {
    vi.useFakeTimers();
    const p = captureNextShortcut({ timeoutMs: 50 });
    vi.advanceTimersByTime(50);
    await expect(p).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('resolves null immediately on Escape even before timeout', async () => {
    vi.useFakeTimers();
    const p = captureNextShortcut({ timeoutMs: 50 });
    window.dispatchEvent(keyEvent({ key: 'Escape' }));
    await expect(p).resolves.toBeNull();
    vi.useRealTimers();
  });

  it('resolves valid shortcut before timeout fires', async () => {
    vi.useFakeTimers();
    const p = captureNextShortcut({ timeoutMs: 50 });
    window.dispatchEvent(keyEvent({ key: 'k', ctrlKey: true }));
    await expect(p).resolves.toBe('mod+k');
    vi.useRealTimers();
  });
});

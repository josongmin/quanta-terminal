/**
 * Composer edge cases: large paste, whitespace-only input, Korean/CJK submit.
 *
 * Real-world scenarios:
 *  - A user pastes a 100k-character log excerpt into the composer. The
 *    widget must not freeze; it must either accept or decline with a
 *    user-visible reason.
 *  - A user presses Enter on blank or whitespace-only content. No block is
 *    emitted — `bridge.write` must not be invoked.
 *  - A user types a Korean command and submits. The host bridge receives
 *    the raw UTF-8 bytes (through a string, but the bytes must survive
 *    the TextEncoder inside the bridge).
 */

import { act, render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import { Composer } from '../Composer.js';
import type { HostBridge } from '@quanta/host-common';

function installBridge(): { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn(() => Promise.resolve());
  const bridge = {
    capabilities: { editor: false, telemetry: false, settings: false, notifications: false },
    ready: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn(),
    write,
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
  } as unknown as HostBridge;
  setHostBridge(bridge);
  return { write };
}

beforeEach(() => {
  useSessionStore.getState().reset();
  useSessionStore.getState().setSession({ id: 'sess-1' });
});

describe('<Composer /> edge paste + unicode', () => {
  it('does NOT submit when value is only whitespace (" \\t ")', () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '   \t   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(write).not.toHaveBeenCalled();
    // Text is preserved in the field so the user can see why nothing happened.
    expect(input.value).toBe('   \t   ');
  });

  it('pasting 100k characters completes synchronously without freezing', () => {
    installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    const huge = 'x'.repeat(100_000);
    const t0 = performance.now();
    fireEvent.change(input, { target: { value: huge } });
    const elapsed = performance.now() - t0;
    // Budget: 1s is a generous ceiling; real runs are <100ms in jsdom.
    expect(elapsed).toBeLessThan(1000);
    expect(input.value.length).toBe(100_000);
  });

  it('pasting 100k chars then pressing Enter submits the full string verbatim', async () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    const huge = 'a'.repeat(100_000);
    fireEvent.change(input, { target: { value: huge } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalledTimes(1);
    const callArg = write.mock.calls[0]![1] as string;
    // submit appends a \n if the text doesn't end in one.
    expect(callArg).toBe(huge + '\n');
  });

  it('submits Korean content with the bytes preserved (UTF-8 round-trip)', async () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    // Use fireEvent.change directly — `userEvent.type` can be slow for CJK
    // because it simulates every keydown.
    fireEvent.change(input, { target: { value: '안녕하세요' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalledTimes(1);
    // submitCommand joins with "\n" — assert the full UTF-8 string was passed.
    const actual = write.mock.calls[0]![1] as string;
    expect(actual).toBe('안녕하세요\n');
    // And the underlying UTF-8 bytes match the expected 15-byte sequence.
    const expectedBytes = new Uint8Array([
      0xec, 0x95, 0x88, 0xeb, 0x85, 0x95, 0xed, 0x95, 0x98, 0xec, 0x84, 0xb8, 0xec, 0x9a, 0x94,
      0x0a,
    ]);
    const actualBytes = new TextEncoder().encode(actual);
    expect(Array.from(actualBytes)).toEqual(Array.from(expectedBytes));
  });

  it('submits emoji "👋" (4-byte UTF-8) without loss', async () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: 'echo 👋' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalledTimes(1);
    const actual = write.mock.calls[0]![1] as string;
    expect(actual).toBe('echo 👋\n');
    // 👋 = F0 9F 91 8B
    const bytes = new TextEncoder().encode(actual);
    expect(Array.from(bytes).slice(5, 9)).toEqual([0xf0, 0x9f, 0x91, 0x8b]);
  });

  it('IME composition Enter → end → fresh Enter: regression for suppression', async () => {
    const { write } = installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByLabelText('Command input') as HTMLTextAreaElement;
    await userEvent.type(input, 'こん');
    // compositionstart → keydown Enter (suppressed) → compositionend → keydown Enter (submits).
    const start = new CompositionEvent('compositionstart', { bubbles: true, data: '' });
    input.dispatchEvent(start);
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(write).not.toHaveBeenCalled();
    const end = new CompositionEvent('compositionend', { bubbles: true, data: 'こん' });
    input.dispatchEvent(end);
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect((write.mock.calls[0]![1] as string).startsWith('こん')).toBe(true);
  });
});

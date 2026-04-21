/**
 * Tests for the "Copy as Markdown" feature.
 *
 * Two surfaces exercised here:
 *   - `exportAsMarkdownSelection` — pure formatter; full-block vs selection,
 *     ANSI stripping, CR rewrite parity with the rendered body.
 *   - `copyBlockAsMarkdown` — end-to-end: reads block from the store, writes
 *     through the clipboard stub, surfaces failure reasons for callers to
 *     translate into toasts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import {
  exportAsMarkdownSelection,
  renderBlockPlainText,
} from '../export.js';
import { copyBlockAsMarkdown } from '../copy-as-markdown.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

function seededBlock(
  command: string,
  outputBytes: number[],
): { id: string } {
  const id = useBlockStore.getState().createBlock(command, '/');
  if (outputBytes.length > 0) {
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array(outputBytes));
  }
  return { id };
}

describe('exportAsMarkdownSelection — full block', () => {
  it('emits an H3 heading and a ```shell fence when selection is null', () => {
    const { id } = seededBlock('echo hi', [104, 105, 10]); // "hi\n"
    const block = useBlockStore.getState().entities[id]!;
    const s = exportAsMarkdownSelection(block, null);
    expect(s).toContain('### `echo hi`');
    expect(s).toContain('```shell\nhi\n```');
    // No metadata footer — this is the short form for chat/PR quoting.
    expect(s).not.toMatch(/_exit /u);
  });

  it('strips ANSI escapes inside the fence', () => {
    // "\u001b[31mred\u001b[0m\n"
    const { id } = seededBlock('ls', [
      0x1b, 0x5b, 0x33, 0x31, 0x6d, 114, 101, 100, 0x1b, 0x5b, 0x30, 0x6d, 10,
    ]);
    const block = useBlockStore.getState().entities[id]!;
    const s = exportAsMarkdownSelection(block, null);
    expect(s).toContain('```shell\nred\n```');
    expect(s).not.toMatch(/\x1b\[/u);
  });

  it('applies carriage-return overwrite semantics (parity with the body)', () => {
    // "l\rls\n" — a progress-bar-style rewrite; the "l" should be overwritten
    // by "ls" rather than preserved as a literal "l\rls".
    const { id } = seededBlock('zle', [0x6c, 0x0d, 0x6c, 0x73, 0x0a]);
    const block = useBlockStore.getState().entities[id]!;
    const s = exportAsMarkdownSelection(block, null);
    expect(s).toContain('```shell\nls\n```');
    // No raw CR byte should leak into the exported text, and the preserved
    // "l" prefix must not appear before "ls".
    expect(s).not.toMatch(/\r/u);
    expect(s).not.toMatch(/shell\nl\nls/u);
    expect(s).not.toMatch(/shell\nlls/u);
  });
});

describe('exportAsMarkdownSelection — slice', () => {
  it('emits just the fence (no heading) for a selection range', () => {
    const { id } = seededBlock('echo', [104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 10]);
    const block = useBlockStore.getState().entities[id]!;
    // "hello world\n" — pick the "world" substring.
    const rendered = renderBlockPlainText(block);
    const start = rendered.indexOf('world');
    const s = exportAsMarkdownSelection(block, { start, end: start + 5 });
    expect(s.split('\n')[0]).toBe('```shell');
    expect(s).toContain('\nworld\n```');
    expect(s).not.toMatch(/^#/u);
    expect(s).not.toMatch(/^### /u);
  });

  it('clamps reversed or out-of-bounds ranges defensively', () => {
    const { id } = seededBlock('x', [65, 66, 67, 10]); // "ABC\n"
    const block = useBlockStore.getState().entities[id]!;
    // end < start: should still produce the slice [1, 3) = "BC"
    const s = exportAsMarkdownSelection(block, { start: 3, end: 1 });
    expect(s).toContain('\nBC\n```');
  });

  it('handles an empty slice without throwing', () => {
    const { id } = seededBlock('x', [65, 10]); // "A\n"
    const block = useBlockStore.getState().entities[id]!;
    const s = exportAsMarkdownSelection(block, { start: 0, end: 0 });
    expect(s).toContain('```shell');
    expect(s).toContain('```');
  });
});

describe('copyBlockAsMarkdown', () => {
  it('writes the full-block form when no selection is provided', async () => {
    const { id } = seededBlock('echo hi', [104, 105, 10]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const res = await copyBlockAsMarkdown({ blockId: id, writeText });
    expect(res.ok).toBe(true);
    expect(writeText).toHaveBeenCalledTimes(1);
    const written = writeText.mock.calls[0]?.[0] as string;
    expect(written).toContain('### `echo hi`');
    expect(written).toContain('```shell\nhi\n```');
  });

  it('writes the slice form when a selection is provided', async () => {
    const { id } = seededBlock('echo', [
      104, 101, 108, 108, 111, 32, 119, 111, 114, 108, 100, 10,
    ]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const res = await copyBlockAsMarkdown({
      blockId: id,
      selection: { start: 6, end: 11 }, // "world"
      writeText,
    });
    expect(res.ok).toBe(true);
    const written = writeText.mock.calls[0]?.[0] as string;
    expect(written).not.toContain('###');
    expect(written).toContain('```shell\nworld\n```');
  });

  it('returns { ok: false, reason: "not-found" } when the id is missing', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const res = await copyBlockAsMarkdown({ blockId: 'nope', writeText });
    expect(res).toEqual({ ok: false, reason: 'not-found' });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('returns { ok: false, reason: "write-failed" } when the writer throws', async () => {
    const { id } = seededBlock('x', [65, 10]);
    const writeText = vi.fn().mockRejectedValue(new Error('blocked'));
    const res = await copyBlockAsMarkdown({ blockId: id, writeText });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('write-failed');
      expect(res.error?.message).toBe('blocked');
    }
  });

  it('returns { ok: false, reason: "no-clipboard" } when no writer is available', async () => {
    const { id } = seededBlock('x', [65, 10]);
    // Remove navigator.clipboard so `defaultWriter()` returns null.
    const original = (navigator as unknown as { clipboard?: unknown }).clipboard;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    try {
      const res = await copyBlockAsMarkdown({ blockId: id });
      expect(res).toEqual({ ok: false, reason: 'no-clipboard' });
    } finally {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: original,
      });
    }
  });
});

/**
 * Block export tests — 3 formats × 3 block states (running, completed, errored)
 * plus helper coverage for ANSI stripping and language detection.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { useBlockStore } from '../../../entities/block/index.js';
import {
  exportBlockAs,
  exportAsMarkdown,
  exportAsJson,
  exportAsText,
  inferCodeFenceLang,
  stripAnsi,
} from '../export.js';

beforeEach(() => {
  useBlockStore.getState().resetAll();
});

/** Small helper — "hello\n" as UTF-8. */
const HELLO_NL = new Uint8Array([104, 101, 108, 108, 111, 10]);

describe('stripAnsi', () => {
  it('removes SGR sequences', () => {
    expect(stripAnsi('\u001b[31merror\u001b[0m')).toBe('error');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi('\u001b]0;title\u0007rest')).toBe('rest');
  });

  it('preserves newlines and tabs', () => {
    expect(stripAnsi('a\n\tb')).toBe('a\n\tb');
  });
});

describe('inferCodeFenceLang', () => {
  it('infers python from python3', () => {
    expect(inferCodeFenceLang('python3 -c "print(1)"')).toBe('python');
  });
  it('infers bash from zsh path', () => {
    expect(inferCodeFenceLang('/bin/zsh')).toBe('bash');
  });
  it('returns empty string for unknown commands', () => {
    expect(inferCodeFenceLang('ls -la')).toBe('');
  });
  it('skips env-var prefixes', () => {
    expect(inferCodeFenceLang('FOO=bar node x.js')).toBe('javascript');
  });
});

describe('exportBlockAs — markdown', () => {
  it('renders a running block with a fenced code block and n/a exit', () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/tmp');
    useBlockStore.getState().appendBlockOutput(id, HELLO_NL);
    const out = exportBlockAs(id, 'markdown');
    expect(out).not.toBeNull();
    const s = out ?? '';
    expect(s).toContain('## `echo hi`');
    expect(s).toContain('```\nhello\n```');
    expect(s).toContain('_exit n/a ');
    expect(s).toContain('running');
  });

  it('renders a completed block with exit 0 and duration', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([97, 10])); // "a\n"
    useBlockStore.getState().completeBlock(id, 0);
    const s = exportAsMarkdown(useBlockStore.getState().entities[id]!);
    expect(s).toContain('```\na\n```');
    expect(s).toContain('_exit 0 · ');
    expect(s).toContain('completed');
  });

  it('renders an errored block with its message and non-zero exit info', () => {
    const id = useBlockStore.getState().createBlock('bad', '/');
    useBlockStore.getState().appendBlockOutput(id, new Uint8Array([]));
    useBlockStore.getState().errorBlock(id, 'spawn EACCES');
    const s = exportAsMarkdown(useBlockStore.getState().entities[id]!);
    expect(s).toContain('error');
    expect(s).toContain('> error: spawn EACCES');
  });

  it('uses a language hint when the command resolves to a known binary', () => {
    const id = useBlockStore.getState().createBlock('python3 hello.py', '/');
    const s = exportAsMarkdown(useBlockStore.getState().entities[id]!);
    expect(s).toContain('```python');
  });
});

describe('exportBlockAs — json', () => {
  it('serializes a running block with base64 output bytes', () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/tmp');
    useBlockStore.getState().appendBlockOutput(id, HELLO_NL);
    const out = exportBlockAs(id, 'json');
    expect(out).not.toBeNull();
    const obj = JSON.parse(out ?? '');
    expect(obj.id).toBe(id);
    expect(obj.command).toBe('echo hi');
    expect(obj.status).toBe('running');
    expect(obj.exitCode).toBeNull();
    // "hello\n" in base64 is aGVsbG8K
    expect(obj.outputBytesB64).toBe('aGVsbG8K');
    expect(obj.outputChunkCount).toBe(1);
  });

  it('preserves exit code and completedAt for completed blocks', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    useBlockStore.getState().completeBlock(id, 0);
    const obj = JSON.parse(exportAsJson(useBlockStore.getState().entities[id]!));
    expect(obj.exitCode).toBe(0);
    expect(obj.status).toBe('completed');
    expect(typeof obj.completedAt).toBe('number');
  });

  it('includes errorMessage when the block errored', () => {
    const id = useBlockStore.getState().createBlock('bad', '/');
    useBlockStore.getState().errorBlock(id, 'spawn EACCES');
    const obj = JSON.parse(exportAsJson(useBlockStore.getState().entities[id]!));
    expect(obj.status).toBe('error');
    expect(obj.errorMessage).toBe('spawn EACCES');
  });
});

describe('exportBlockAs — text', () => {
  it('writes command + decoded output for a running block', () => {
    const id = useBlockStore.getState().createBlock('echo hi', '/');
    useBlockStore.getState().appendBlockOutput(id, HELLO_NL);
    const s = exportBlockAs(id, 'text');
    expect(s).toBe('echo hi\nhello\n');
  });

  it('strips ANSI sequences for completed blocks', () => {
    const id = useBlockStore.getState().createBlock('ls', '/');
    // "\u001b[31mred\u001b[0m\n"
    useBlockStore
      .getState()
      .appendBlockOutput(id, new Uint8Array([0x1b, 0x5b, 0x33, 0x31, 0x6d, 114, 101, 100, 0x1b, 0x5b, 0x30, 0x6d, 10]));
    useBlockStore.getState().completeBlock(id, 0);
    const s = exportAsText(useBlockStore.getState().entities[id]!);
    expect(s).toBe('ls\nred\n');
  });

  it('emits a single trailing newline for errored blocks with empty output', () => {
    const id = useBlockStore.getState().createBlock('bad', '/');
    useBlockStore.getState().errorBlock(id, 'spawn EACCES');
    const s = exportAsText(useBlockStore.getState().entities[id]!);
    // command plus newline plus empty output (no trailing extra newline)
    expect(s).toBe('bad\n\n');
  });
});

describe('exportBlockAs — lookup', () => {
  it('returns null when the block does not exist', () => {
    expect(exportBlockAs('does-not-exist', 'markdown')).toBeNull();
    expect(exportBlockAs('does-not-exist', 'json')).toBeNull();
    expect(exportBlockAs('does-not-exist', 'text')).toBeNull();
  });
});

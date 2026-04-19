/**
 * Structured IPC error parsing (FIX 2). Pins the Rust→TS error translation:
 *   - structured `{ code, user_message, context }` → `HostBridgeErrorThrown`
 *   - legacy bare string → `{ code: 'unknown', userMessage }` + console.warn
 *   - unknown code strings → collapse to `'unknown'` with a warning
 *   - invoke wrapper propagates the parsed error as a throw
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';
import {
  HostBridgeErrorThrown,
  invokeStructured,
  parseHostBridgeError,
} from '../structured-error.js';

// Typed reference to the mock fn so `.mockImplementationOnce` keeps types.
const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

describe('parseHostBridgeError', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('parses the canonical Rust shape into a typed HostBridgeError', () => {
    const raw = {
      code: 'session-not-found',
      user_message: 'That session is no longer available.',
      context: { session_id: 'abcd' },
    };
    const parsed = parseHostBridgeError(raw);
    expect(parsed.code).toBe('session-not-found');
    expect(parsed.userMessage).toBe('That session is no longer available.');
    expect(parsed.context).toEqual({ session_id: 'abcd' });
  });

  it('wraps a bare string as {unknown, userMessage} and warns', () => {
    const parsed = parseHostBridgeError('oh no something broke');
    expect(parsed.code).toBe('unknown');
    expect(parsed.userMessage).toBe('oh no something broke');
    expect(warn).toHaveBeenCalled();
  });

  it('maps an unrecognised code to "unknown" and preserves userMessage', () => {
    const parsed = parseHostBridgeError({
      code: 'not-a-real-code',
      user_message: 'ui safe text',
    });
    expect(parsed.code).toBe('unknown');
    expect(parsed.userMessage).toBe('ui safe text');
    expect(warn).toHaveBeenCalled();
  });

  it('collapses `Error` instances to {unknown, message}', () => {
    const parsed = parseHostBridgeError(new Error('explicit error'));
    expect(parsed.code).toBe('unknown');
    expect(parsed.userMessage).toBe('explicit error');
  });
});

describe('HostBridgeErrorThrown', () => {
  it('exposes .code and .userMessage and extends Error', () => {
    const err = new HostBridgeErrorThrown({
      code: 'editor-invalid-path',
      userMessage: 'The file path was rejected.',
      context: { reason: 'empty' },
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('editor-invalid-path');
    expect(err.userMessage).toBe('The file path was rejected.');
    expect(err.message).toBe('The file path was rejected.');
    expect(err.name).toBe('HostBridgeErrorThrown');
    expect(err.context).toEqual({ reason: 'empty' });
  });
});

describe('invokeStructured', () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  it('forwards the resolved value on success', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: 1 });
    const r = await invokeStructured<{ ok: number }>('some_cmd', { a: 1 });
    expect(r).toEqual({ ok: 1 });
    expect(mockInvoke).toHaveBeenCalledWith('some_cmd', { a: 1 });
  });

  it('throws HostBridgeErrorThrown with code from the Rust-side shape', async () => {
    mockInvoke.mockRejectedValueOnce({
      code: 'shell-integration-outside-home',
      user_message: 'Refusing to modify a file outside your home directory.',
    });
    await expect(invokeStructured('x')).rejects.toMatchObject({
      name: 'HostBridgeErrorThrown',
      code: 'shell-integration-outside-home',
      userMessage: 'Refusing to modify a file outside your home directory.',
    });
  });

  it('maps a legacy bare-string rejection to `{unknown, <string>}`', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockInvoke.mockRejectedValueOnce('a legacy rust string error');
    try {
      await invokeStructured('x');
      expect.fail('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(HostBridgeErrorThrown);
      const e = err as HostBridgeErrorThrown;
      expect(e.code).toBe('unknown');
      expect(e.userMessage).toBe('a legacy rust string error');
    }
    warn.mockRestore();
  });
});

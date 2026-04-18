import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@quanta/host-common';
import { useSessionStore } from '../../../entities/session/index.js';
import { submitCommand } from '../submit.js';

function makeBridge(): { bridge: HostBridge; write: ReturnType<typeof vi.fn> } {
  const write = vi.fn().mockResolvedValue(undefined);
  const bridge = {
    ready: vi.fn().mockResolvedValue(undefined),
    spawn: vi.fn(),
    write,
    resize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
  } as unknown as HostBridge;
  return { bridge, write };
}

beforeEach(() => {
  useSessionStore.getState().reset();
});

describe('submitCommand', () => {
  it('rejects empty input with reason=empty', async () => {
    const { bridge } = makeBridge();
    const result = await submitCommand({ text: '   ', bridge });
    expect(result).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects when no session is active', async () => {
    const { bridge } = makeBridge();
    const result = await submitCommand({ text: 'ls', bridge });
    expect(result).toEqual({ ok: false, reason: 'no-session' });
  });

  it('writes the text plus newline to the bridge', async () => {
    const { bridge, write } = makeBridge();
    useSessionStore.getState().setSession({ id: 'sess-1' });
    const result = await submitCommand({ text: 'ls -la', bridge });
    expect(result.ok).toBe(true);
    expect(write).toHaveBeenCalledWith('sess-1', 'ls -la\n');
  });

  it('does not double the newline when input already ends with one', async () => {
    const { bridge, write } = makeBridge();
    useSessionStore.getState().setSession({ id: 'sess-2' });
    await submitCommand({ text: 'pwd\n', bridge });
    expect(write).toHaveBeenCalledWith('sess-2', 'pwd\n');
  });

  it('returns ok=false with error on bridge failure', async () => {
    const write = vi.fn().mockRejectedValue(new Error('pipe closed'));
    const bridge = {
      ready: vi.fn(),
      spawn: vi.fn(),
      write,
      resize: vi.fn(),
      close: vi.fn(),
      subscribe: vi.fn(),
    } as unknown as HostBridge;
    useSessionStore.getState().setSession({ id: 'sess-3' });
    const result = await submitCommand({ text: 'ls', bridge });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBe('pipe closed');
  });
});

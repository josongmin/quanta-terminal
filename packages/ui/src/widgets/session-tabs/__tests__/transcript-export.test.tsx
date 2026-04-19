/**
 * SessionTabs — kebab menu + "Export transcript" item.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionsStore } from '../../../entities/session/index.js';
import { useBlockStore } from '../../../entities/block/index.js';
import { useToastStore } from '../../../shared/ui/toast/index.js';
import { SessionTabs } from '../SessionTabs.js';
import type { SessionId } from '../../../shared/types/generated/index.js';

function installClipboard(impl: (text: string) => Promise<void>) {
  const writeText = vi.fn().mockImplementation(impl);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

beforeEach(() => {
  useSessionsStore.getState().reset();
  useBlockStore.getState().resetAll();
  useToastStore.getState().clearAll();
});

afterEach(() => {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: undefined,
  });
});

describe('<SessionTabs /> transcript export', () => {
  it('renders a kebab menu trigger per session tab', () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    render(<SessionTabs />);
    expect(screen.getByTestId('session-tab-menu-sess-1')).toBeInTheDocument();
  });

  it('opens the menu and shows "Export transcript" on kebab click', async () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    render(<SessionTabs />);
    await userEvent.click(screen.getByTestId('session-tab-menu-sess-1'));
    expect(screen.getByTestId('session-tab-menu-popup-sess-1')).toBeInTheDocument();
    expect(screen.getByTestId('session-tab-export-sess-1')).toBeInTheDocument();
  });

  it('writes the transcript to the clipboard on "Export transcript" click', async () => {
    const id = 'sess-1' as SessionId;
    useSessionsStore.getState().addSession({
      id,
      shell: '/bin/zsh',
      cwd: '/tmp',
      health: 'ready',
    });
    const blk = useBlockStore.getState().createBlock('ls', '/tmp', { sessionId: id });
    useBlockStore.getState().completeBlock(blk, 0);
    const writeText = installClipboard(async () => {});
    render(<SessionTabs />);
    await userEvent.click(screen.getByTestId(`session-tab-menu-${id}`));
    await userEvent.click(screen.getByTestId(`session-tab-export-${id}`));
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]?.[0] as string;
    expect(text).toContain('# Session transcript');
    expect(text).toContain('## `ls`');
    // Toast fired.
    const items = useToastStore.getState().items;
    expect(items.some((t) => /transcript copied/iu.test(t.message))).toBe(true);
  });

  it('surfaces a warning toast when the clipboard is unavailable', async () => {
    const id = 'sess-1' as SessionId;
    useSessionsStore.getState().addSession({ id, shell: '/bin/zsh', health: 'ready' });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: undefined,
    });
    render(<SessionTabs />);
    await userEvent.click(screen.getByTestId(`session-tab-menu-${id}`));
    await userEvent.click(screen.getByTestId(`session-tab-export-${id}`));
    const items = useToastStore.getState().items;
    expect(items.some((t) => /failed/iu.test(t.message))).toBe(true);
  });

  it('closes the menu on Escape', async () => {
    useSessionsStore.getState().addSession({
      id: 'sess-1' as SessionId,
      shell: '/bin/zsh',
      health: 'ready',
    });
    render(<SessionTabs />);
    await userEvent.click(screen.getByTestId('session-tab-menu-sess-1'));
    expect(screen.getByTestId('session-tab-menu-popup-sess-1')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('session-tab-menu-popup-sess-1')).toBeNull();
  });
});

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { SessionTabs } from '../SessionTabs.js';

beforeEach(() => {
  useSessionStore.getState().reset();
});

describe('<SessionTabs />', () => {
  it('renders a tablist with an active (disabled) tab when no session exists', () => {
    render(<SessionTabs />);
    const tab = screen.getByRole('tab');
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(tab).toBeDisabled();
  });

  it('enables the tab and displays the shell basename when a session is active', () => {
    useSessionStore.getState().setSession({ id: 'sess-1', shell: '/bin/zsh', health: 'ready' });
    render(<SessionTabs />);
    const tab = screen.getByRole('tab');
    expect(tab).toBeEnabled();
    expect(tab).toHaveTextContent('zsh');
  });
});

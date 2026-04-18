import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { StatusBar } from '../StatusBar.js';

describe('<StatusBar />', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
  });

  it('defaults to an `est` badge when shell integration is missing', () => {
    useSessionStore.getState().setSession({
      id: 'sess-1',
      shell: '/bin/zsh',
      cwd: '/Users/x/projects/demo',
      cwdSource: 'launch',
      shellIntegration: 'missing',
      health: 'ready',
    });
    render(<StatusBar />);
    expect(screen.getByRole('status', { name: /cwd is estimated/iu })).toHaveTextContent('est');
    expect(screen.getByText('/bin/zsh')).toBeInTheDocument();
  });

  it('shows an `SI` badge when shell integration is installed', () => {
    useSessionStore.getState().setSession({
      id: 'sess-2',
      shell: '/bin/fish',
      cwd: '/Users/x',
      shellIntegration: 'installed',
      health: 'ready',
    });
    render(<StatusBar />);
    expect(screen.getByRole('status', { name: /shell integration active/iu })).toHaveTextContent(
      'SI',
    );
  });

  it('reports exit code when the session has exited', () => {
    useSessionStore.getState().setSession({
      id: 'sess-3',
      shell: '/bin/zsh',
      cwd: '/tmp',
      shellIntegration: 'missing',
      health: 'ready',
    });
    useSessionStore.getState().markExited(2);
    render(<StatusBar />);
    expect(screen.getByLabelText('Session status')).toHaveTextContent(/exited 2/u);
  });

  it('renders the ⌘K palette hint on the right', () => {
    render(<StatusBar />);
    expect(screen.getByLabelText('Open command palette shortcut')).toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { TitleBar } from '../TitleBar.js';

beforeEach(() => {
  useSessionStore.getState().reset();
});

describe('<TitleBar />', () => {
  it('renders the brand and the cwd', () => {
    useSessionStore.getState().setSession({
      id: 'sess-1',
      shell: '/bin/zsh',
      cwd: '/Users/example/code/proj',
    });
    render(<TitleBar />);
    expect(screen.getByText('Quanta')).toBeInTheDocument();
    expect(screen.getByText('~/code/proj')).toBeInTheDocument();
  });

  it('shows "booting" before a session exists', () => {
    render(<TitleBar />);
    expect(screen.getByText('booting')).toBeInTheDocument();
  });

  it('invokes onOpenPalette when the palette hint is clicked', () => {
    const spy = vi.fn();
    render(<TitleBar onOpenPalette={spy} />);
    const btn = screen.getByRole('button', { name: 'Open command palette' });
    btn.click();
    expect(spy).toHaveBeenCalledOnce();
  });
});

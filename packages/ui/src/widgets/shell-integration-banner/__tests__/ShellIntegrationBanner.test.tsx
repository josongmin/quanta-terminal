import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { useBannerStore } from '../../../entities/banner/index.js';
import { ShellIntegrationBanner } from '../ShellIntegrationBanner.js';

beforeEach(() => {
  useSessionStore.getState().reset();
  useBannerStore.getState().resetAll();
});

// Shared override: a stub wizard preview/install surface so tests don't need
// a real bridge.
const wizardOverrides = {
  preview: vi.fn(async () => ({
    kind: 'preview' as const,
    reply: {
      targetPath: '/home/user/.zshrc',
      snippet: '\n# >>> quanta shell integration >>>\necho hi\n# <<< quanta shell integration <<<\n',
      alreadyInstalled: false,
      mutated: false,
      lineCount: 5,
    },
  })),
  install: vi.fn(async () => ({
    kind: 'installed' as const,
    reply: {
      targetPath: '/home/user/.zshrc',
      snippet: '',
      alreadyInstalled: false,
      mutated: true,
      lineCount: 10,
    },
  })),
};

describe('<ShellIntegrationBanner />', () => {
  beforeEach(() => {
    wizardOverrides.preview.mockClear();
    wizardOverrides.install.mockClear();
  });

  it('renders nothing when shellIntegration is installed', () => {
    useSessionStore.getState().setSession({ shellIntegration: 'installed', shell: '/bin/zsh' });
    render(<ShellIntegrationBanner wizardOverrides={wizardOverrides} />);
    expect(screen.queryByTestId('shell-integration-banner')).toBeNull();
  });

  it('renders the banner with Install button when shellIntegration is missing', () => {
    useSessionStore.getState().setSession({ shellIntegration: 'missing', shell: '/bin/zsh' });
    render(<ShellIntegrationBanner wizardOverrides={wizardOverrides} />);
    expect(screen.getByTestId('shell-integration-banner')).toBeInTheDocument();
    expect(screen.getByTestId('shell-integration-banner-install')).toBeInTheDocument();
  });

  it('renders when shellIntegration is partial', () => {
    useSessionStore.getState().setSession({ shellIntegration: 'partial', shell: '/bin/bash' });
    render(<ShellIntegrationBanner wizardOverrides={wizardOverrides} />);
    expect(screen.getByTestId('shell-integration-banner')).toBeInTheDocument();
  });

  it('clicking Install opens the wizard without triggering an install', () => {
    useSessionStore.getState().setSession({ shellIntegration: 'missing', shell: '/bin/zsh' });
    render(<ShellIntegrationBanner wizardOverrides={wizardOverrides} />);
    act(() => {
      screen.getByTestId('shell-integration-banner-install').click();
    });
    // The wizard has rendered at step detect.
    expect(screen.getByTestId('step-detect')).toBeInTheDocument();
    // Crucially, neither preview nor install has been called yet — opening
    // the wizard is not consent.
    expect(wizardOverrides.preview).not.toHaveBeenCalled();
    expect(wizardOverrides.install).not.toHaveBeenCalled();
  });

  it('clicking Not now dismisses the banner via the banner store', () => {
    useSessionStore.getState().setSession({ shellIntegration: 'missing', shell: '/bin/zsh' });
    const { rerender } = render(<ShellIntegrationBanner wizardOverrides={wizardOverrides} />);
    act(() => {
      screen.getByRole('button', { name: /not now/iu }).click();
    });
    rerender(<ShellIntegrationBanner wizardOverrides={wizardOverrides} />);
    expect(screen.queryByTestId('shell-integration-banner')).toBeNull();
    expect(useBannerStore.getState().dismissed.has('shell_integration')).toBe(true);
  });

  it('mentions the detected shell in the banner copy', () => {
    useSessionStore.getState().setSession({ shellIntegration: 'missing', shell: '/usr/bin/fish' });
    render(<ShellIntegrationBanner wizardOverrides={wizardOverrides} />);
    const host = screen.getByTestId('shell-integration-banner');
    expect(host.textContent).toMatch(/fish/);
  });
});

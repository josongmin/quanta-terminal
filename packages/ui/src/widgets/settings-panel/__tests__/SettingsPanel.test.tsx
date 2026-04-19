import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPanel } from '../SettingsPanel.js';
import { setTheme, useThemeStore } from '../../../features/theme/index.js';
import { useSessionStore } from '../../../entities/session/index.js';

/** jsdom ships without localStorage in this project's setup — shim one. */
function installStorage(): void {
  const data = new Map<string, string>();
  const api: Storage = {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(k: string) {
      return data.has(k) ? data.get(k)! : null;
    },
    key(i: number) {
      return Array.from(data.keys())[i] ?? null;
    },
    removeItem(k: string) {
      data.delete(k);
    },
    setItem(k: string, v: string) {
      data.set(k, String(v));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: api,
  });
}

beforeEach(() => {
  installStorage();
  useThemeStore.getState()._rehydrate();
  useSessionStore.getState().reset();
  document.documentElement.removeAttribute('data-theme');
});

describe('<SettingsPanel />', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<SettingsPanel open={false} onClose={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the dialog with the four sections', () => {
    render(<SettingsPanel open onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: /settings/i })).toBeInTheDocument();
    expect(screen.getByText(/appearance/i)).toBeInTheDocument();
    expect(screen.getByText(/keyboard/i)).toBeInTheDocument();
    expect(screen.getByText(/shell integration/i)).toBeInTheDocument();
    expect(screen.getByText(/privacy/i)).toBeInTheDocument();
  });

  it('highlights the current theme option', () => {
    setTheme('dark');
    render(<SettingsPanel open onClose={() => {}} />);
    expect(screen.getByTestId('settings-theme-dark').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('settings-theme-light').getAttribute('aria-checked')).toBe('false');
  });

  it('clicking a theme option updates the store', async () => {
    setTheme('system');
    render(<SettingsPanel open onClose={() => {}} />);
    await userEvent.click(screen.getByTestId('settings-theme-light'));
    expect(useThemeStore.getState().theme).toBe('light');
  });

  it('invokes onClose on Escape keydown inside the dialog', () => {
    const onClose = vi.fn();
    render(<SettingsPanel open onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: /settings/i });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('invokes onClose when the backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<SettingsPanel open onClose={onClose} />);
    fireEvent.mouseDown(screen.getByTestId('settings-panel-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });

  it('invokes onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    render(<SettingsPanel open onClose={onClose} />);
    await userEvent.click(screen.getByTestId('settings-panel-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an Install button when shell integration is missing', () => {
    useSessionStore.getState().setSession({ shellIntegration: 'missing' });
    const onInstall = vi.fn();
    render(
      <SettingsPanel open onClose={() => {}} onInstallShellIntegration={onInstall} />,
    );
    expect(screen.getByTestId('settings-install-si')).toBeInTheDocument();
  });

  it('hides the Install button when shell integration is installed', () => {
    useSessionStore.getState().setSession({ shellIntegration: 'installed' });
    render(
      <SettingsPanel open onClose={() => {}} onInstallShellIntegration={() => {}} />,
    );
    expect(screen.queryByTestId('settings-install-si')).toBeNull();
  });

  it('renders the keyboard shortcut hints with formatted chips', () => {
    render(<SettingsPanel open onClose={() => {}} />);
    // Exact formatting is platform-dependent; just assert the hint cells render.
    expect(screen.getByTestId('settings-shortcut-mod+k')).toBeInTheDocument();
    expect(screen.getByTestId('settings-shortcut-mod+,')).toBeInTheDocument();
  });
});

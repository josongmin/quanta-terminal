import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsPanel } from '../SettingsPanel.js';
import { setTheme, useThemeStore } from '../../../features/theme/index.js';
import { useSessionStore } from '../../../entities/session/index.js';
import {
  SHELL_PATHS,
  useSessionProfiles,
} from '../../../entities/session-profile/index.js';

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
  useSessionProfiles.getState().reset();
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

describe('<SettingsPanel /> session profiles section', () => {
  it('renders the built-in default profile with a default badge', () => {
    const s = useSessionProfiles.getState();
    const defaultId = s.defaultId;
    render(<SettingsPanel open onClose={() => {}} />);
    expect(screen.getByTestId(`settings-profile-row-${defaultId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`settings-profile-default-${defaultId}`)).toBeInTheDocument();
  });

  it('clicking Add profile + Save creates a new profile in the store', async () => {
    render(<SettingsPanel open onClose={() => {}} />);
    await userEvent.click(screen.getByTestId('settings-profile-add'));
    const nameInput = screen.getByTestId('settings-profile-name-new');
    await userEvent.type(nameInput, 'Work');
    // The default shellKind in the draft is zsh — Save should pick up
    // SHELL_PATHS.zsh automatically.
    await userEvent.click(screen.getByTestId('settings-profile-save-new'));
    const s = useSessionProfiles.getState();
    const added = Object.values(s.entities).find((p) => p.name === 'Work');
    expect(added).toBeDefined();
    expect(added?.shell).toBe(SHELL_PATHS.zsh);
  });

  it('Remove button deletes the profile from the store', async () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Deletable',
      shell: SHELL_PATHS.bash,
    });
    render(<SettingsPanel open onClose={() => {}} />);
    expect(screen.getByTestId(`settings-profile-row-${id}`)).toBeInTheDocument();
    await userEvent.click(screen.getByTestId(`settings-profile-remove-${id}`));
    expect(useSessionProfiles.getState().entities[id]).toBeUndefined();
  });

  it('Set default button flips the defaultId', async () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Alt',
      shell: SHELL_PATHS.fish,
    });
    render(<SettingsPanel open onClose={() => {}} />);
    await userEvent.click(screen.getByTestId(`settings-profile-set-default-${id}`));
    expect(useSessionProfiles.getState().defaultId).toBe(id);
  });

  it('Edit + Save updates an existing profile', async () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Old',
      shell: SHELL_PATHS.bash,
    });
    render(<SettingsPanel open onClose={() => {}} />);
    await userEvent.click(screen.getByTestId(`settings-profile-edit-${id}`));
    const nameInput = screen.getByTestId(`settings-profile-name-${id}`);
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'New');
    await userEvent.click(screen.getByTestId(`settings-profile-save-${id}`));
    expect(useSessionProfiles.getState().entities[id]?.name).toBe('New');
  });

  it('env-row editor adds an env var and persists it on Save', async () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Work',
      shell: SHELL_PATHS.zsh,
    });
    render(<SettingsPanel open onClose={() => {}} />);
    await userEvent.click(screen.getByTestId(`settings-profile-edit-${id}`));
    // Start with zero rows; click Add variable to create one.
    await userEvent.click(screen.getByTestId(`settings-profile-env-add-${id}`));
    const keyInput = screen.getByTestId(`settings-profile-env-key-${id}-0`);
    const valInput = screen.getByTestId(`settings-profile-env-value-${id}-0`);
    await userEvent.type(keyInput, 'NODE_ENV');
    await userEvent.type(valInput, 'development');
    await userEvent.click(screen.getByTestId(`settings-profile-save-${id}`));
    const p = useSessionProfiles.getState().entities[id];
    expect(p?.env).toEqual({ NODE_ENV: 'development' });
  });

  it('startup commands textarea round-trips through the store', async () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Dev',
      shell: SHELL_PATHS.zsh,
    });
    render(<SettingsPanel open onClose={() => {}} />);
    await userEvent.click(screen.getByTestId(`settings-profile-edit-${id}`));
    const area = screen.getByTestId(`settings-profile-startup-commands-${id}`);
    await userEvent.type(area, 'cd ~/work\npnpm dev');
    await userEvent.click(screen.getByTestId(`settings-profile-save-${id}`));
    expect(useSessionProfiles.getState().entities[id]?.startupCommands).toEqual([
      'cd ~/work',
      'pnpm dev',
    ]);
  });

  it('shows an inline error for an invalid env key on blur', async () => {
    const id = useSessionProfiles.getState().addProfile({
      name: 'Lint',
      shell: SHELL_PATHS.zsh,
    });
    render(<SettingsPanel open onClose={() => {}} />);
    await userEvent.click(screen.getByTestId(`settings-profile-edit-${id}`));
    await userEvent.click(screen.getByTestId(`settings-profile-env-add-${id}`));
    const keyInput = screen.getByTestId(`settings-profile-env-key-${id}-0`);
    await userEvent.type(keyInput, 'lowercase');
    // Tab away to trigger the blur-based validation.
    await userEvent.tab();
    expect(
      screen.getByTestId(`settings-profile-env-error-${id}-0`),
    ).toBeInTheDocument();
  });
});

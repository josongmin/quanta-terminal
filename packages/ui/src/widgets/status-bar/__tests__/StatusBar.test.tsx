import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionStore } from '../../../entities/session/index.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import { __resetGitStatusCacheForTests } from '../../../features/git-branch/index.js';
import type { GitStatus, HostBridge } from '@quanta/host-common';
import { StatusBar } from '../StatusBar.js';

/**
 * Build a minimal bridge that only implements `readTextFile` — the rest of
 * the bridge surface isn't exercised by StatusBar rendering. We cast via
 * `unknown` because TypeScript would otherwise ask us to stub every method.
 */
function installBridgeWithFiles(files: Readonly<Record<string, string | null>>): void {
  const bridge = {
    readTextFile: vi.fn(async ({ path }: { path: string }) => files[path] ?? null),
  } as unknown as HostBridge;
  setHostBridge(bridge);
}

/** Variant that also supplies `gitStatus` so the dirty / ahead-behind
 *  decorations render. */
function installBridgeWithStatus(
  files: Readonly<Record<string, string | null>>,
  statuses: Readonly<Record<string, GitStatus | null>>,
): void {
  const bridge = {
    readTextFile: vi.fn(async ({ path }: { path: string }) => files[path] ?? null),
    gitStatus: vi.fn(async ({ repoRoot }: { repoRoot: string }) => statuses[repoRoot] ?? null),
  } as unknown as HostBridge;
  setHostBridge(bridge);
}

function installNoBridge(): void {
  // Clear any previously-injected bridge so tests that don't need git-branch
  // resolution don't accidentally read each other's state.
  if (typeof window !== 'undefined') {
    delete (window as unknown as { __QUANTA_HOST__?: HostBridge }).__QUANTA_HOST__;
  }
  setHostBridge({
    readTextFile: vi.fn(async () => null),
  } as unknown as HostBridge);
}

describe('<StatusBar />', () => {
  beforeEach(() => {
    useSessionStore.getState().reset();
    installNoBridge();
    __resetGitStatusCacheForTests();
  });
  afterEach(() => {
    if (typeof window !== 'undefined') {
      delete (window as unknown as { __QUANTA_HOST__?: HostBridge }).__QUANTA_HOST__;
    }
    __resetGitStatusCacheForTests();
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

  it('does NOT render the WSL badge when the session is not WSL', () => {
    useSessionStore.getState().setSession({
      id: 'sess-nowsl',
      shell: '/bin/zsh',
      cwd: '/Users/x',
      shellIntegration: 'missing',
      health: 'ready',
    });
    render(<StatusBar />);
    expect(screen.queryByText('WSL')).not.toBeInTheDocument();
  });

  it('renders the WSL badge when the active session is flagged isWsl', () => {
    useSessionStore.getState().setSession({
      id: 'sess-wsl',
      shell: '/bin/bash',
      cwd: '/home/me',
      shellIntegration: 'missing',
      health: 'ready',
      isWsl: true,
    });
    render(<StatusBar />);
    expect(screen.getByText('WSL')).toBeInTheDocument();
    expect(
      screen.getByRole('status', { name: /session running under wsl/iu }),
    ).toBeInTheDocument();
  });

  it('shows the git branch chip when the cwd is inside a repo', async () => {
    installBridgeWithFiles({
      '/Users/x/projects/demo/.git/HEAD': 'ref: refs/heads/main\n',
    });
    useSessionStore.getState().setSession({
      id: 'sess-git',
      shell: '/bin/zsh',
      cwd: '/Users/x/projects/demo/src/nested',
      shellIntegration: 'installed',
      health: 'ready',
    });
    render(<StatusBar />);
    await waitFor(() => {
      expect(screen.getByTestId('git-branch-chip')).toHaveTextContent('main');
    });
    expect(screen.getByRole('status', { name: /git branch: main/iu })).toBeInTheDocument();
  });

  it('does NOT render the git branch chip when the cwd is not inside a repo', async () => {
    installBridgeWithFiles({});
    useSessionStore.getState().setSession({
      id: 'sess-no-git',
      shell: '/bin/zsh',
      cwd: '/tmp/not-a-repo',
      shellIntegration: 'installed',
      health: 'ready',
    });
    render(<StatusBar />);
    // Wait long enough for the debounced read to complete and for React to
    // commit the final state. If the branch chip were going to appear it
    // would have by this point.
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByTestId('git-branch-chip')).not.toBeInTheDocument();
  });

  it('renders the dirty (*) marker when the working tree is dirty', async () => {
    installBridgeWithStatus(
      { '/Users/x/repo/.git/HEAD': 'ref: refs/heads/main\n' },
      {
        '/Users/x/repo': {
          branch: 'main',
          dirty: true,
          ahead: 0,
          behind: 0,
          detached: false,
        },
      },
    );
    useSessionStore.getState().setSession({
      id: 'sess-dirty',
      shell: '/bin/zsh',
      cwd: '/Users/x/repo/src',
      shellIntegration: 'installed',
      health: 'ready',
    });
    render(<StatusBar />);
    await waitFor(() => {
      expect(screen.getByTestId('git-branch-dirty')).toHaveTextContent('*');
    });
  });

  it('renders ↑N↓M when the branch has diverged from upstream', async () => {
    installBridgeWithStatus(
      { '/Users/x/repo/.git/HEAD': 'ref: refs/heads/feature\n' },
      {
        '/Users/x/repo': {
          branch: 'feature',
          dirty: false,
          ahead: 3,
          behind: 1,
          detached: false,
        },
      },
    );
    useSessionStore.getState().setSession({
      id: 'sess-diverged',
      shell: '/bin/zsh',
      cwd: '/Users/x/repo',
      shellIntegration: 'installed',
      health: 'ready',
    });
    render(<StatusBar />);
    await waitFor(() => {
      const div = screen.getByTestId('git-branch-divergence');
      expect(div).toHaveTextContent('↑3↓1');
    });
    // No dirty marker since the tree is clean.
    expect(screen.queryByTestId('git-branch-dirty')).not.toBeInTheDocument();
  });

  it('omits divergence glyphs when ahead/behind are both zero', async () => {
    installBridgeWithStatus(
      { '/Users/x/repo/.git/HEAD': 'ref: refs/heads/main\n' },
      {
        '/Users/x/repo': {
          branch: 'main',
          dirty: false,
          ahead: 0,
          behind: 0,
          detached: false,
        },
      },
    );
    useSessionStore.getState().setSession({
      id: 'sess-clean',
      shell: '/bin/zsh',
      cwd: '/Users/x/repo',
      shellIntegration: 'installed',
      health: 'ready',
    });
    render(<StatusBar />);
    await waitFor(() => {
      expect(screen.getByTestId('git-branch-chip')).toHaveTextContent('main');
    });
    expect(screen.queryByTestId('git-branch-dirty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-branch-divergence')).not.toBeInTheDocument();
  });

  it('does NOT render dirty/divergence when the host lacks gitStatus capability', async () => {
    // Bridge without `gitStatus` — branch-only fallback path.
    installBridgeWithFiles({
      '/Users/x/repo/.git/HEAD': 'ref: refs/heads/main\n',
    });
    useSessionStore.getState().setSession({
      id: 'sess-no-status',
      shell: '/bin/zsh',
      cwd: '/Users/x/repo',
      shellIntegration: 'installed',
      health: 'ready',
    });
    render(<StatusBar />);
    await waitFor(() => {
      expect(screen.getByTestId('git-branch-chip')).toHaveTextContent('main');
    });
    expect(screen.queryByTestId('git-branch-dirty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-branch-divergence')).not.toBeInTheDocument();
  });
});

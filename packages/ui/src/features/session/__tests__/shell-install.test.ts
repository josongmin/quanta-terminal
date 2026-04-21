/**
 * Unit tests for `maybeAutoInstallShellIntegration` and the back-off helpers
 * (Plan 0005 P1-B). Covers every outcome variant, the feature-flag gate,
 * the 3-strike / 24 h cool-down, and the toast + wizard surfaces.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  HostBridge,
  ShellInstallOutcome,
} from '@quanta/host-common';
import {
  BACKOFF_STORAGE_PREFIX,
  BACKOFF_WINDOW_MS,
  MAX_CONSECUTIVE_FAILURES,
  clearBackoff,
  isInBackoff,
  maybeAutoInstallShellIntegration,
  readBackoff,
  shellFamily,
  writeBackoff,
  type KeyValueStorage,
} from '../shell-install.js';
import {
  resetFeatureFlags,
  setFeatureFlag,
} from '../../../shared/config/feature-flags.js';

class InMemoryStorage implements KeyValueStorage {
  public readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

function makeBridge(
  outcome: ShellInstallOutcome | (() => Promise<ShellInstallOutcome> | ShellInstallOutcome),
): { bridge: Pick<HostBridge, 'shellInstallAuto'>; calls: string[] } {
  const calls: string[] = [];
  const bridge: Pick<HostBridge, 'shellInstallAuto'> = {
    shellInstallAuto: async (shell: string) => {
      calls.push(shell);
      return typeof outcome === 'function' ? await outcome() : outcome;
    },
  };
  return { bridge, calls };
}

describe('shellFamily', () => {
  it('strips absolute-path directory components', () => {
    expect(shellFamily('/bin/zsh')).toBe('zsh');
    expect(shellFamily('/usr/local/bin/bash')).toBe('bash');
  });
  it('lowercases for stable storage keys', () => {
    expect(shellFamily('ZSH')).toBe('zsh');
  });
  it('passes through bare leaf names', () => {
    expect(shellFamily('fish')).toBe('fish');
  });
});

describe('back-off primitives', () => {
  it('readBackoff returns null for a missing key', () => {
    const s = new InMemoryStorage();
    expect(readBackoff(s, 'zsh')).toBeNull();
  });
  it('readBackoff round-trips writeBackoff', () => {
    const s = new InMemoryStorage();
    writeBackoff(s, 'zsh', { lastAttemptAt: 123, failCount: 2 });
    expect(readBackoff(s, 'zsh')).toEqual({
      lastAttemptAt: 123,
      failCount: 2,
    });
  });
  it('readBackoff tolerates malformed JSON', () => {
    const s = new InMemoryStorage();
    s.map.set(BACKOFF_STORAGE_PREFIX + 'zsh', '{not json');
    expect(readBackoff(s, 'zsh')).toBeNull();
  });
  it('clearBackoff removes the key', () => {
    const s = new InMemoryStorage();
    writeBackoff(s, 'zsh', { lastAttemptAt: 1, failCount: 1 });
    clearBackoff(s, 'zsh');
    expect(readBackoff(s, 'zsh')).toBeNull();
  });
  it('isInBackoff is false for null record or fewer failures', () => {
    expect(isInBackoff(null, 0)).toBe(false);
    expect(
      isInBackoff({ lastAttemptAt: 0, failCount: MAX_CONSECUTIVE_FAILURES - 1 }, 0),
    ).toBe(false);
  });
  it('isInBackoff is true within the 24h window at the failure threshold', () => {
    const now = 1_000_000_000;
    expect(
      isInBackoff(
        { lastAttemptAt: now - 1000, failCount: MAX_CONSECUTIVE_FAILURES },
        now,
      ),
    ).toBe(true);
  });
  it('isInBackoff is false once the window has elapsed', () => {
    const now = 1_000_000_000;
    expect(
      isInBackoff(
        {
          lastAttemptAt: now - BACKOFF_WINDOW_MS - 1,
          failCount: MAX_CONSECUTIVE_FAILURES,
        },
        now,
      ),
    ).toBe(false);
  });
});

describe('maybeAutoInstallShellIntegration', () => {
  beforeEach(() => {
    resetFeatureFlags();
  });
  afterEach(() => {
    resetFeatureFlags();
  });

  it('skips when the feature flag is off', async () => {
    setFeatureFlag('shellIntegrationAutoInstall', false);
    const { bridge, calls } = makeBridge({ kind: 'already_installed' });
    const toast = vi.fn();
    const result = await maybeAutoInstallShellIntegration('/bin/zsh', {
      bridge,
      storage: new InMemoryStorage(),
      now: () => 0,
      toast,
    });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('skips when the bridge does not implement shellInstallAuto', async () => {
    const toast = vi.fn();
    const result = await maybeAutoInstallShellIntegration('/bin/zsh', {
      bridge: {},
      storage: new InMemoryStorage(),
      now: () => 0,
      toast,
    });
    expect(result).toBeNull();
    expect(toast).not.toHaveBeenCalled();
  });

  it('shows a toast on installed and clears any prior back-off', async () => {
    const storage = new InMemoryStorage();
    writeBackoff(storage, 'zsh', { lastAttemptAt: 1, failCount: 1 });
    const { bridge, calls } = makeBridge({
      kind: 'installed',
      rcPath: '/home/me/.zshrc',
      backupPath: '/home/me/.config/quanta/shell-integration-backup/zshrc.1.bak',
    });
    const toast = vi.fn();
    const out = await maybeAutoInstallShellIntegration('/bin/zsh', {
      bridge,
      storage,
      now: () => 0,
      toast,
    });
    expect(out?.kind).toBe('installed');
    expect(calls).toEqual(['/bin/zsh']);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'info',
        message: expect.stringContaining('Reload your shell'),
      }),
    );
    expect(readBackoff(storage, 'zsh')).toBeNull();
  });

  it('is silent on already_installed', async () => {
    const { bridge } = makeBridge({ kind: 'already_installed' });
    const toast = vi.fn();
    const out = await maybeAutoInstallShellIntegration('zsh', {
      bridge,
      storage: new InMemoryStorage(),
      now: () => 0,
      toast,
    });
    expect(out?.kind).toBe('already_installed');
    expect(toast).not.toHaveBeenCalled();
  });

  it('is silent on skipped_unsupported_shell and does not consume back-off', async () => {
    const storage = new InMemoryStorage();
    const { bridge } = makeBridge({ kind: 'skipped_unsupported_shell' });
    const toast = vi.fn();
    const out = await maybeAutoInstallShellIntegration('/bin/dash', {
      bridge,
      storage,
      now: () => 0,
      toast,
    });
    expect(out?.kind).toBe('skipped_unsupported_shell');
    expect(toast).not.toHaveBeenCalled();
    // Unsupported shells don't populate a back-off counter — retrying the
    // same shell later could never succeed, so the counter would be pointless.
    expect(readBackoff(storage, 'dash')).toBeNull();
  });

  it('records a failure and warns the user on failed', async () => {
    const storage = new InMemoryStorage();
    const { bridge } = makeBridge({ kind: 'failed', reason: 'disk full' });
    const toast = vi.fn();
    const openWizard = vi.fn();
    const now = 12345;
    const out = await maybeAutoInstallShellIntegration('/bin/zsh', {
      bridge,
      storage,
      now: () => now,
      toast,
      openWizard,
    });
    expect(out?.kind).toBe('failed');
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'warning' }),
    );
    expect(openWizard).toHaveBeenCalledWith('/bin/zsh');
    expect(readBackoff(storage, 'zsh')).toEqual({
      lastAttemptAt: now,
      failCount: 1,
    });
  });

  it('increments failCount monotonically across failures', async () => {
    const storage = new InMemoryStorage();
    const { bridge } = makeBridge({ kind: 'failed', reason: 'x' });
    for (let i = 1; i <= 3; i += 1) {
      await maybeAutoInstallShellIntegration('/bin/zsh', {
        bridge,
        storage,
        now: () => i * 1000,
        toast: () => 0,
      });
    }
    expect(readBackoff(storage, 'zsh')).toEqual({
      lastAttemptAt: 3000,
      failCount: 3,
    });
  });

  it('skips the bridge call once 3 failures land within the 24h window', async () => {
    const storage = new InMemoryStorage();
    // Simulate 3 prior failures.
    writeBackoff(storage, 'zsh', {
      lastAttemptAt: 1000,
      failCount: MAX_CONSECUTIVE_FAILURES,
    });
    const { bridge, calls } = makeBridge({ kind: 'installed', rcPath: '', backupPath: '' });
    const toast = vi.fn();
    const out = await maybeAutoInstallShellIntegration('zsh', {
      bridge,
      storage,
      now: () => 1000 + BACKOFF_WINDOW_MS - 1,
      toast,
    });
    expect(out).toBeNull();
    expect(calls).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('retries once the 24h window has elapsed', async () => {
    const storage = new InMemoryStorage();
    writeBackoff(storage, 'zsh', {
      lastAttemptAt: 1000,
      failCount: MAX_CONSECUTIVE_FAILURES,
    });
    const { bridge, calls } = makeBridge({
      kind: 'installed',
      rcPath: '/home/me/.zshrc',
      backupPath: '/bak',
    });
    const toast = vi.fn();
    const out = await maybeAutoInstallShellIntegration('zsh', {
      bridge,
      storage,
      now: () => 1000 + BACKOFF_WINDOW_MS + 1,
      toast,
    });
    expect(out?.kind).toBe('installed');
    expect(calls).toEqual(['zsh']);
    // Success clears the counter so future attempts get a clean slate.
    expect(readBackoff(storage, 'zsh')).toBeNull();
  });

  it('normalises a bridge throw into a failed outcome', async () => {
    const storage = new InMemoryStorage();
    const bridge: Pick<HostBridge, 'shellInstallAuto'> = {
      shellInstallAuto: async () => {
        throw new Error('IPC died');
      },
    };
    const toast = vi.fn();
    const out = await maybeAutoInstallShellIntegration('zsh', {
      bridge,
      storage,
      now: () => 0,
      toast,
    });
    expect(out?.kind).toBe('failed');
    if (out?.kind === 'failed') {
      expect(out.reason).toContain('IPC died');
    }
    expect(readBackoff(storage, 'zsh')?.failCount).toBe(1);
  });

  // --- force: true bypasses back-off (audit P1-B) ---
  it('force=true bypasses active back-off and calls the bridge', async () => {
    const storage = new InMemoryStorage();
    // Prime storage with a fully-consumed back-off that WOULD normally skip.
    writeBackoff(storage, 'zsh', {
      lastAttemptAt: 1000,
      failCount: MAX_CONSECUTIVE_FAILURES,
    });
    const { bridge, calls } = makeBridge({
      kind: 'installed',
      rcPath: '/home/me/.zshrc',
      backupPath: '/bak',
    });
    const toast = vi.fn();
    const out = await maybeAutoInstallShellIntegration('zsh', {
      bridge,
      storage,
      // still well within the 24h window — default path would skip here.
      now: () => 1000 + BACKOFF_WINDOW_MS - 1,
      toast,
      force: true,
    });
    expect(out?.kind).toBe('installed');
    expect(calls).toEqual(['zsh']);
    // Success path still clears the counter.
    expect(readBackoff(storage, 'zsh')).toBeNull();
  });

  it('force=false (default) still honors an active back-off', async () => {
    // Control for the force test above — same setup, no force, must skip.
    const storage = new InMemoryStorage();
    writeBackoff(storage, 'zsh', {
      lastAttemptAt: 1000,
      failCount: MAX_CONSECUTIVE_FAILURES,
    });
    const { bridge, calls } = makeBridge({ kind: 'installed', rcPath: '', backupPath: '' });
    const out = await maybeAutoInstallShellIntegration('zsh', {
      bridge,
      storage,
      now: () => 1000 + BACKOFF_WINDOW_MS - 1,
      toast: () => 0,
      // force omitted — default is false.
    });
    expect(out).toBeNull();
    expect(calls).toEqual([]);
  });

  it('force=true records failures in back-off so repeated forcing eventually cools off', async () => {
    // The force flag only bypasses the PRE-CALL gate. Post-call bookkeeping
    // still increments failCount, so a user who clicks "install now" three
    // times in a row in the face of a hard failure does end up in back-off
    // once they stop forcing.
    const storage = new InMemoryStorage();
    const { bridge } = makeBridge({ kind: 'failed', reason: 'disk full' });
    for (let i = 1; i <= 3; i += 1) {
      await maybeAutoInstallShellIntegration('zsh', {
        bridge,
        storage,
        now: () => i * 1000,
        toast: () => 0,
        force: true,
      });
    }
    expect(readBackoff(storage, 'zsh')).toEqual({
      lastAttemptAt: 3000,
      failCount: 3,
    });
  });
});

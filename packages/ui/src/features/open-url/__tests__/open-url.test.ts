/**
 * features/open-url — confirm-then-open flow for auto-linkified URLs.
 *
 * Coverage:
 *   - `canonicaliseForOpen` rewrites bare domains to `https://` and
 *     git@host:path to `ssh://host/path`.
 *   - `openExternalUrl` declines without a user confirmation.
 *   - On confirm, delegates to `bridge.openExternalUrl` when present.
 *   - Missing bridge / missing method each surface a warning toast.
 *   - Rejection from the bridge surfaces a warning toast.
 *   - Disallowed schemes (e.g. `javascript:`) are rejected up front.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from '@quanta/host-common';
import { DEFAULT_CAPABILITIES } from '@quanta/host-common';
import {
  canonicaliseForOpen,
  openExternalUrl,
  setOpenUrlConfirm,
} from '../open-url.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import { useToastStore } from '../../../shared/ui/toast/index.js';

function stubBridge(overrides: Partial<HostBridge> = {}): HostBridge {
  return {
    capabilities: DEFAULT_CAPABILITIES,
    async ready() {},
    async spawn() {
      return { sessionId: 'sess', shell: '/bin/sh', cwd: '/' };
    },
    async write() {},
    async resize() {},
    async close() {},
    async cancelBlock() {},
    async openInEditor() {},
    async installShellIntegration() {
      return {
        targetPath: '',
        snippet: '',
        alreadyInstalled: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async aiSuggest() {
      return {
        id: 'x',
        command: 'ls',
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe() {
      return { unsubscribe: () => {} };
    },
    ...overrides,
  } as HostBridge;
}

beforeEach(() => {
  useToastStore.getState().clearAll();
  setOpenUrlConfirm(undefined);
});

afterEach(() => {
  useToastStore.getState().clearAll();
  setOpenUrlConfirm(undefined);
  if (typeof window !== 'undefined') {
    delete (window as unknown as { __QUANTA_HOST__?: HostBridge }).__QUANTA_HOST__;
  }
  vi.restoreAllMocks();
});

describe('canonicaliseForOpen', () => {
  it('prefixes a bare domain with https://', () => {
    expect(canonicaliseForOpen({ url: 'example.com/foo', kind: 'domain' })).toBe(
      'https://example.com/foo',
    );
  });

  it('leaves http URLs alone', () => {
    expect(canonicaliseForOpen({ url: 'http://example.com', kind: 'http' })).toBe(
      'http://example.com',
    );
  });

  it('rewrites scp-style git@host:path to ssh://host/path', () => {
    expect(
      canonicaliseForOpen({ url: 'git@github.com:user/repo.git', kind: 'ssh' }),
    ).toBe('ssh://git@github.com/user/repo.git');
  });

  it('leaves ssh:// URLs alone', () => {
    expect(
      canonicaliseForOpen({ url: 'ssh://git@example.com/repo.git', kind: 'ssh' }),
    ).toBe('ssh://git@example.com/repo.git');
  });

  it('leaves mailto:addresses alone', () => {
    expect(canonicaliseForOpen({ url: 'mailto:a@b.com', kind: 'mailto' })).toBe(
      'mailto:a@b.com',
    );
  });
});

// NOTE on test ordering: `setHostBridge` mutates a module-level variable in
// `shared/api/host-bridge.ts` that cannot be reset from outside the module.
// We therefore run the no-bridge case FIRST so it sees an empty bridge slot;
// subsequent tests explicitly install a bridge.

describe('openExternalUrl — no bridge first', () => {
  it('surfaces a warning toast when no bridge is installed', async () => {
    setOpenUrlConfirm(() => true);
    const outcome = await openExternalUrl({ url: 'https://example.com', kind: 'http' });
    expect(outcome).toMatchObject({ ok: false, reason: 'no-bridge' });
    const items = useToastStore.getState().items;
    expect(items.at(-1)?.kind).toBe('warning');
    expect(items.at(-1)?.message).toMatch(/example\.com/);
  });

  it('rejects non-allowlisted schemes before prompting', async () => {
    setOpenUrlConfirm(() => {
      throw new Error('confirm should not have been invoked');
    });
    const outcome = await openExternalUrl({
      // Force a kind of `http` but with a hostile scheme slipping through —
      // the allowlist check in openExternalUrl rejects it up front.
      url: 'javascript:alert(1)',
      kind: 'http',
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-scheme' });
  });

  it('returns cancelled when the user declines', async () => {
    setOpenUrlConfirm(() => false);
    const outcome = await openExternalUrl({ url: 'https://example.com', kind: 'http' });
    expect(outcome).toEqual({ ok: false, reason: 'cancelled' });
  });
});

describe('openExternalUrl — with bridge installed', () => {
  it('surfaces a warning toast when bridge lacks openExternalUrl', async () => {
    setOpenUrlConfirm(() => true);
    setHostBridge(stubBridge());
    const outcome = await openExternalUrl({ url: 'https://example.com', kind: 'http' });
    expect(outcome).toMatchObject({ ok: false, reason: 'bridge-unsupported' });
    expect(useToastStore.getState().items.at(-1)?.message).toMatch(/does not support/);
  });

  it('delegates to bridge.openExternalUrl when confirmed', async () => {
    setOpenUrlConfirm(() => true);
    const open = vi.fn().mockResolvedValue(undefined);
    setHostBridge(stubBridge({ openExternalUrl: open }));
    const outcome = await openExternalUrl({
      url: 'https://example.com',
      kind: 'http',
    });
    expect(open).toHaveBeenCalledWith({ url: 'https://example.com' });
    expect(outcome.ok).toBe(true);
  });

  it('canonicalises a bare domain before handing off', async () => {
    setOpenUrlConfirm(() => true);
    const open = vi.fn().mockResolvedValue(undefined);
    setHostBridge(stubBridge({ openExternalUrl: open }));
    await openExternalUrl({ url: 'example.com/foo', kind: 'domain' });
    expect(open).toHaveBeenCalledWith({ url: 'https://example.com/foo' });
  });

  it('surfaces a warning toast when the bridge rejects', async () => {
    setOpenUrlConfirm(() => true);
    setHostBridge(
      stubBridge({
        openExternalUrl: vi.fn().mockRejectedValue(new Error('denied')),
      }),
    );
    const outcome = await openExternalUrl({ url: 'https://example.com', kind: 'http' });
    expect(outcome).toMatchObject({ ok: false, reason: 'bridge-failed' });
    expect(useToastStore.getState().items.at(-1)?.message).toMatch(/denied/);
  });
});

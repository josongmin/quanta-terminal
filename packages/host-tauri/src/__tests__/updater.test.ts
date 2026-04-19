/**
 * Tauri updater wrapper tests (FIX 2, P0).
 *
 * The wrapper swallows throws by design, so most tests assert on the
 * discriminated-union outcome rather than rejection shape. A dedicated test
 * confirms that a plugin throw becomes `{ status: 'error' }` without
 * re-raising.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __setUpdaterPluginLoader,
  checkForUpdates,
  installUpdate,
  setUpdaterBannerDispatcher,
  type AvailableUpdate,
} from '../updater.js';

afterEach(() => {
  __setUpdaterPluginLoader(null);
  setUpdaterBannerDispatcher(null);
});

// The loader type uses `unknown` internally — cast via `as never` here keeps
// the test free of the wrapper's private `PluginModule` symbol.
type FakeLoader = () => Promise<unknown>;

describe('checkForUpdates', () => {
  it('returns up-to-date when the plugin reports no update', async () => {
    __setUpdaterPluginLoader((() =>
      Promise.resolve({
        check: async () => null,
      })) as FakeLoader as never);
    const result = await checkForUpdates();
    expect(result.status).toBe('up-to-date');
  });

  it('returns available with projected fields when an update exists', async () => {
    __setUpdaterPluginLoader((() =>
      Promise.resolve({
        check: async () => ({
          available: true,
          version: '0.2.0',
          currentVersion: '0.1.0',
          body: 'fixes and polish',
          downloadAndInstall: async () => {},
        }),
      })) as FakeLoader as never);
    const result = await checkForUpdates();
    expect(result.status).toBe('available');
    if (result.status === 'available') {
      expect(result.update.version).toBe('0.2.0');
      expect(result.update.currentVersion).toBe('0.1.0');
      expect(result.update.body).toBe('fixes and polish');
      expect(result.update.__raw).toBeTruthy();
    }
  });

  it('does not throw when the plugin itself rejects', async () => {
    __setUpdaterPluginLoader((() =>
      Promise.resolve({
        check: async () => {
          throw new Error('dns lookup failed');
        },
      })) as FakeLoader as never);
    const result = await checkForUpdates();
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatch(/dns lookup failed/);
    }
  });

  it('dispatches the outcome to the registered banner dispatcher', async () => {
    const dispatcher = vi.fn();
    setUpdaterBannerDispatcher(dispatcher);
    __setUpdaterPluginLoader((() =>
      Promise.resolve({
        check: async () => null,
      })) as FakeLoader as never);
    const result = await checkForUpdates();
    expect(dispatcher).toHaveBeenCalledTimes(1);
    expect(dispatcher).toHaveBeenCalledWith(result);
  });

  it('tolerates a throwing banner dispatcher without propagating', async () => {
    setUpdaterBannerDispatcher(() => {
      throw new Error('banner broken');
    });
    __setUpdaterPluginLoader((() =>
      Promise.resolve({
        check: async () => null,
      })) as FakeLoader as never);
    const result = await checkForUpdates();
    expect(result.status).toBe('up-to-date');
  });
});

describe('installUpdate', () => {
  it('calls downloadAndInstall on the raw handle and returns installed', async () => {
    const spy = vi.fn(async () => {});
    const update: AvailableUpdate = {
      version: '0.2.0',
      currentVersion: '0.1.0',
      body: null,
      __raw: { downloadAndInstall: spy },
    };
    const result = await installUpdate(update);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('installed');
  });

  it('rejects a tampered update handle as error without crashing', async () => {
    const update: AvailableUpdate = {
      version: '0.2.0',
      currentVersion: '0.1.0',
      body: null,
      __raw: { nope: true },
    };
    const result = await installUpdate(update);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatch(/downloadAndInstall/);
    }
  });

  it('maps a thrown error during install into the error variant', async () => {
    const update: AvailableUpdate = {
      version: '0.2.0',
      currentVersion: '0.1.0',
      body: null,
      __raw: {
        downloadAndInstall: async () => {
          throw new Error('download failed');
        },
      },
    };
    const result = await installUpdate(update);
    expect(result.status).toBe('error');
    if (result.status === 'error') {
      expect(result.error).toMatch(/download failed/);
    }
  });
});

describe('setUpdaterBannerDispatcher', () => {
  beforeEach(() => {
    __setUpdaterPluginLoader((() =>
      Promise.resolve({
        check: async () => null,
      })) as FakeLoader as never);
  });

  it('clears the dispatcher when passed null', async () => {
    const dispatcher = vi.fn();
    setUpdaterBannerDispatcher(dispatcher);
    setUpdaterBannerDispatcher(null);
    await checkForUpdates();
    expect(dispatcher).not.toHaveBeenCalled();
  });
});

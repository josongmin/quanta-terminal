/**
 * Unit tests for the shared `getPlatform()` helper.
 *
 * The helper memoizes its answer across the whole process. Each test stubs
 * `navigator.platform` / `navigator.userAgent`, calls the reset hook to drop
 * the cache, exercises `getPlatform()`, and restores the originals.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetPlatformCacheForTests, getPlatform } from '../platform.js';

interface Stash {
  readonly platform: PropertyDescriptor | undefined;
  readonly userAgent: PropertyDescriptor | undefined;
}

function stubNavigator(platform: string, userAgent = ''): Stash {
  const stash: Stash = {
    platform: Object.getOwnPropertyDescriptor(navigator, 'platform'),
    userAgent: Object.getOwnPropertyDescriptor(navigator, 'userAgent'),
  };
  Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
  return stash;
}

function restoreNavigator(stash: Stash): void {
  if (stash.platform) Object.defineProperty(navigator, 'platform', stash.platform);
  if (stash.userAgent) Object.defineProperty(navigator, 'userAgent', stash.userAgent);
}

describe('getPlatform', () => {
  let stash: Stash | null = null;

  beforeEach(() => {
    __resetPlatformCacheForTests();
  });

  afterEach(() => {
    if (stash) restoreNavigator(stash);
    stash = null;
    __resetPlatformCacheForTests();
  });

  it('returns macos on MacIntel', () => {
    stash = stubNavigator('MacIntel');
    expect(getPlatform()).toBe('macos');
  });

  it('returns macos on iPad user agents', () => {
    // iPadOS 13+ reports `MacIntel` in navigator.platform but an iPad
    // user-agent string. Either side matching mac-like tokens suffices.
    stash = stubNavigator('', 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X)');
    expect(getPlatform()).toBe('macos');
  });

  it('returns windows on Win32', () => {
    stash = stubNavigator('Win32');
    expect(getPlatform()).toBe('windows');
  });

  it('returns linux on vanilla Linux', () => {
    stash = stubNavigator('Linux x86_64');
    expect(getPlatform()).toBe('linux');
  });

  it('falls back to linux when navigator strings are empty', () => {
    stash = stubNavigator('', '');
    expect(getPlatform()).toBe('linux');
  });

  it('memoizes the answer across repeated calls', () => {
    stash = stubNavigator('MacIntel');
    expect(getPlatform()).toBe('macos');
    // Swap to a non-mac platform; the cached answer must stay because
    // tests are the only callers allowed to reset the cache.
    restoreNavigator(stash);
    stash = stubNavigator('Win32');
    expect(getPlatform()).toBe('macos');
  });

  it('re-detects after __resetPlatformCacheForTests', () => {
    stash = stubNavigator('MacIntel');
    expect(getPlatform()).toBe('macos');
    restoreNavigator(stash);
    stash = stubNavigator('Win32');
    __resetPlatformCacheForTests();
    expect(getPlatform()).toBe('windows');
  });
});

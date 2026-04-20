/**
 * notify.ts tests — permission handling, bridge precedence, graceful no-op
 * when the Notification API is absent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureNotificationPermission,
  notify,
  type NotifyResult,
} from '../notify.js';
import { setHostBridge } from '../../../shared/api/host-bridge.js';
import type { HostBridge } from '@quanta/host-common';

/**
 * The injected-bridge slot is module-scoped so we must reset it between
 * tests. We install a bridge with NO `notify` method to ensure notify()
 * falls through to the Web Notification API path.
 */
function installNoNotifyBridge(): void {
  const bridge = {
    capabilities: {
      nativeWindowChrome: false,
      systemNotifications: false,
      editorIntegration: false,
      windowsShellParity: false,
      embeddedDevShell: false,
    },
    async ready() {},
    async spawn() {
      return { sessionId: 'stub', shell: '/bin/sh', cwd: '/' };
    },
    async write() {},
    async resize() {},
    async close() {},
    async cancelBlock() {},
    async openInEditor() {},
    async installShellIntegration() {
      return {
        targetPath: '/tmp',
        snippet: '',
        alreadyInstalled: false,
        mutated: false,
        lineCount: 0,
      };
    },
    async aiSuggest() {
      return {
        id: 'stub',
        command: 'ls',
        tier: 'safe' as const,
        modifiers: [],
        rulesetVersion: 1,
      };
    },
    subscribe: () => ({ unsubscribe: () => {} }),
    // No `notify` method — feature's notify wrapper must fall through.
  } as unknown as HostBridge;
  setHostBridge(bridge);
  if (typeof window !== 'undefined') {
    delete (window as unknown as { __QUANTA_HOST__?: HostBridge }).__QUANTA_HOST__;
  }
}

type NotificationCtor = typeof Notification;

function makeNotificationCtor(
  initialPermission: NotificationPermission,
  ctorSideEffect?: (title: string, options?: unknown) => void,
): {
  ctor: NotificationCtor;
  setPermission: (next: NotificationPermission) => void;
  requestMock: ReturnType<typeof vi.fn>;
} {
  let permission = initialPermission;
  const requestMock = vi.fn(async () => initialPermission);

  class MockNotification {
    static get permission(): NotificationPermission {
      return permission;
    }
    static requestPermission(): Promise<NotificationPermission> {
      return requestMock();
    }
    constructor(title: string, options?: unknown) {
      ctorSideEffect?.(title, options);
    }
  }
  return {
    ctor: MockNotification as unknown as NotificationCtor,
    setPermission: (next) => {
      permission = next;
    },
    requestMock,
  };
}

beforeEach(() => {
  installNoNotifyBridge();
});

afterEach(() => {
  delete (globalThis as unknown as { Notification?: NotificationCtor }).Notification;
  installNoNotifyBridge();
});

describe('ensureNotificationPermission', () => {
  it('returns false when Notification is undefined', async () => {
    delete (globalThis as unknown as { Notification?: NotificationCtor }).Notification;
    await expect(ensureNotificationPermission()).resolves.toBe(false);
  });

  it('returns true when permission already granted', async () => {
    const { ctor } = makeNotificationCtor('granted');
    (globalThis as unknown as { Notification: NotificationCtor }).Notification = ctor;
    await expect(ensureNotificationPermission()).resolves.toBe(true);
  });

  it('returns false when permission already denied', async () => {
    const { ctor } = makeNotificationCtor('denied');
    (globalThis as unknown as { Notification: NotificationCtor }).Notification = ctor;
    await expect(ensureNotificationPermission()).resolves.toBe(false);
  });

  it('does NOT prompt when permission is default and allowPrompt is unset (avoids user-gesture error)', async () => {
    const { ctor, requestMock } = makeNotificationCtor('default');
    requestMock.mockResolvedValue('granted');
    (globalThis as unknown as { Notification: NotificationCtor }).Notification = ctor;
    await expect(ensureNotificationPermission()).resolves.toBe(false);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('does NOT prompt when allowPrompt is explicitly false', async () => {
    const { ctor, requestMock } = makeNotificationCtor('default');
    requestMock.mockResolvedValue('granted');
    (globalThis as unknown as { Notification: NotificationCtor }).Notification = ctor;
    await expect(
      ensureNotificationPermission({ allowPrompt: false }),
    ).resolves.toBe(false);
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('requests permission when default AND allowPrompt is true, resolving based on user choice', async () => {
    const { ctor, requestMock } = makeNotificationCtor('default');
    requestMock.mockResolvedValue('granted');
    (globalThis as unknown as { Notification: NotificationCtor }).Notification = ctor;
    await expect(
      ensureNotificationPermission({ allowPrompt: true }),
    ).resolves.toBe(true);
    expect(requestMock).toHaveBeenCalled();
  });

  it('short-circuits to true when permission already granted without prompting, even with allowPrompt true', async () => {
    const { ctor, requestMock } = makeNotificationCtor('granted');
    (globalThis as unknown as { Notification: NotificationCtor }).Notification = ctor;
    await expect(
      ensureNotificationPermission({ allowPrompt: true }),
    ).resolves.toBe(true);
    expect(requestMock).not.toHaveBeenCalled();
  });
});

describe('notify', () => {
  it('prefers a bridge-provided notify method when available', async () => {
    const notifySpy = vi.fn(async () => {});
    const bridge = {
      capabilities: {
        nativeWindowChrome: false,
        systemNotifications: true,
        editorIntegration: false,
        windowsShellParity: false,
        embeddedDevShell: false,
      },
      async ready() {},
      async spawn() {
        return { sessionId: 'stub', shell: '/bin/sh', cwd: '/' };
      },
      async write() {},
      async resize() {},
      async close() {},
      async cancelBlock() {},
      async openInEditor() {},
      async installShellIntegration() {
        return {
          targetPath: '/tmp',
          snippet: '',
          alreadyInstalled: false,
          mutated: false,
          lineCount: 0,
        };
      },
      async aiSuggest() {
        return {
          id: 'stub',
          command: 'ls',
          tier: 'safe' as const,
          modifiers: [],
          rulesetVersion: 1,
        };
      },
      notify: notifySpy,
      subscribe: () => ({ unsubscribe: () => {} }),
    } as unknown as HostBridge;
    setHostBridge(bridge);
    const result: NotifyResult = await notify({ title: 'T', body: 'B' });
    expect(result).toBe('ok');
    expect(notifySpy).toHaveBeenCalledWith({ title: 'T', body: 'B' });
  });

  it('returns no-api when Notification is undefined and no bridge', async () => {
    delete (globalThis as unknown as { Notification?: NotificationCtor }).Notification;
    const result = await notify({ title: 'T', body: 'B' });
    expect(result).toBe('no-api');
  });

  it('returns no-permission when the API is present but permission is denied', async () => {
    const { ctor } = makeNotificationCtor('denied');
    (globalThis as unknown as { Notification: NotificationCtor }).Notification = ctor;
    const result = await notify({ title: 'T', body: 'B' });
    expect(result).toBe('no-permission');
  });

  it('constructs a Notification when permission granted and no bridge', async () => {
    const made: Array<{ title: string }> = [];
    const { ctor } = makeNotificationCtor('granted', (title) => {
      made.push({ title });
    });
    (globalThis as unknown as { Notification: NotificationCtor }).Notification = ctor;
    const result = await notify({ title: 'Hello', body: 'World' });
    expect(result).toBe('ok');
    expect(made).toEqual([{ title: 'Hello' }]);
  });
});

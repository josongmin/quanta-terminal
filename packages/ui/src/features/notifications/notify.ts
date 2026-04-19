/**
 * Notification wrapper — prefers the host bridge's notify() method (the
 * Tauri-backed one routes to a native OS notification via the notification
 * plugin), falls back to the Web Notification API, and is a graceful no-op
 * when neither is available / permission was denied.
 *
 * Permission flow:
 *   - `ensurePermission()` resolves once on boot; the caller may call it
 *     again later (e.g. when the user toggles the setting on). It never
 *     throws: a denied permission resolves `false` and subsequent
 *     `notify()` calls short-circuit.
 *   - When the Notification API is absent entirely (non-browser host), the
 *     wrapper never asks for permission and treats every notify as a
 *     success when the bridge is available, or a silent no-op otherwise.
 */

import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { createLogger } from '../../shared/lib/logger.js';

const log = createLogger('features/notifications');

export interface NotifyOptions {
  readonly title: string;
  readonly body: string;
}

export type NotifyResult = 'ok' | 'no-permission' | 'no-api' | 'failed';

/**
 * Request Notification permission from the browser. Returns `true` when
 * permission has been granted (either just now or previously). Calls with a
 * non-browser host resolve `false` without prompting.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  const current = Notification.permission;
  if (current === 'granted') return true;
  if (current === 'denied') return false;
  try {
    const granted = await Notification.requestPermission();
    return granted === 'granted';
  } catch (err) {
    log.debug('Notification.requestPermission threw', err);
    return false;
  }
}

/**
 * Post an OS notification. Prefers the host bridge's `notify` method when
 * available (Tauri routes to the native plugin for a system-level post);
 * falls back to the Web Notification API; resolves `'no-api'` when neither
 * path is available.
 *
 * Silent: the return value is the observable outcome; callers can log it
 * but this wrapper never throws.
 */
export async function notify(options: NotifyOptions): Promise<NotifyResult> {
  const bridge = tryGetHostBridge();
  // Host-bridged notify (if implemented) goes through the Rust side and
  // respects the `notification:default` capability on the Tauri host. When
  // the bridge omits the method (mock / reference), fall through to the Web
  // API. `notify` is narrowed with an in-operator check to keep the call
  // type-safe without forcing the bridge contract on every adapter.
  if (bridge && typeof (bridge as unknown as { notify?: unknown }).notify === 'function') {
    try {
      const typed = bridge as unknown as {
        notify: (o: NotifyOptions) => Promise<void>;
      };
      await typed.notify(options);
      return 'ok';
    } catch (err) {
      log.debug('bridge.notify rejected, falling through to Web API', err);
      // fall through to Web API below
    }
  }
  if (typeof Notification === 'undefined') return 'no-api';
  if (Notification.permission !== 'granted') return 'no-permission';
  try {
    // eslint-disable-next-line no-new
    new Notification(options.title, { body: options.body });
    return 'ok';
  } catch (err) {
    log.debug('new Notification threw', err);
    return 'failed';
  }
}

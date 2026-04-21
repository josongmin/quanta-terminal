/**
 * `features/open-url` — confirm-then-open flow for auto-linkified URLs.
 *
 * The plain-text URL autolinkifier (`shared/lib/url-detect`) produces
 * clickable anchors in block output. Clicking one does NOT immediately hand
 * the URL off to the host — the user may have pasted a malicious URL into
 * their terminal, and we do not want a silent browser redirect to be one
 * hover-and-click away. Instead we:
 *
 *   1. Dispatch a {@link showToast} with a "confirm" action that carries the
 *      URL verbatim. The user inspects the URL text and decides whether to
 *      proceed.
 *   2. On confirm → call `bridge.openExternalUrl({ url })` if the bridge has
 *      one; otherwise surface a "couldn't open: no bridge" toast.
 *   3. Log both the click and the eventual resolution (accepted / rejected /
 *      bridge error) so support / dev telemetry can correlate issues.
 *
 * The toast surface is the existing shared toast (`shared/ui/toast`) with a
 * `danger` kind so the confirmation UI is visually distinct from the
 * informational toasts the rest of the app uses. Toast has no inline
 * "action button" affordance today — we schedule a parallel confirm by
 * passing a predicate through a test-override seam.
 */

import { showToast } from '../../shared/ui/toast/index.js';
import { tryGetHostBridge } from '../../shared/api/host-bridge.js';
import { createLogger } from '../../shared/lib/logger.js';
import type { UrlKind } from '../../shared/lib/url-detect/index.js';

const log = createLogger('features/open-url');

export type OpenUrlOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason:
        | 'cancelled'
        | 'no-bridge'
        | 'bridge-unsupported'
        | 'bridge-failed'
        | 'invalid-scheme';
      readonly error?: Error;
    };

export interface OpenUrlInput {
  readonly url: string;
  readonly kind: UrlKind;
}

/**
 * User-confirmation seam. Production UIs install a `window.confirm`-style
 * implementation; tests inject a scripted one. Defaults to `window.confirm`
 * so the feature works out of the box without a DI wiring step.
 */
export type ConfirmFn = (message: string) => boolean | Promise<boolean>;

let overrideConfirm: ConfirmFn | undefined;

export function setOpenUrlConfirm(fn: ConfirmFn | undefined): void {
  overrideConfirm = fn;
}

function getConfirm(): ConfirmFn {
  if (overrideConfirm) return overrideConfirm;
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
    return (msg) => window.confirm(msg);
  }
  // No confirm surface available (non-browser tests). Default-deny so the
  // URL is never silently opened.
  return () => false;
}

const ALLOWED_SCHEMES = new Set(['http', 'https', 'ftp', 'ssh', 'mailto', 'file']);

/**
 * Normalise a detected URL (bare domain, scp-style, etc.) into a form the
 * host's platform open-url syscall accepts. We do NOT second-guess schemed
 * URLs — they are passed through verbatim after a scheme-allowlist check.
 */
export function canonicaliseForOpen(input: OpenUrlInput): string {
  const { url, kind } = input;
  if (kind === 'domain') {
    return /^(http|https):/i.test(url) ? url : `https://${url}`;
  }
  if (kind === 'ssh' && !/^ssh:/i.test(url)) {
    // git@github.com:org/repo.git → ssh://git@github.com/org/repo.git so the
    // platform URL handler does the right thing. We translate the FIRST ':'
    // that follows the host to a '/'.
    const at = url.indexOf('@');
    if (at > 0) {
      const hostStart = at + 1;
      const colon = url.indexOf(':', hostStart);
      if (colon > hostStart) {
        return `ssh://${url.slice(0, colon)}/${url.slice(colon + 1)}`;
      }
    }
  }
  return url;
}

/**
 * Ask the user to confirm, then open the URL via the host bridge. Returns a
 * promise that resolves with the outcome — callers typically ignore the
 * return value and rely on the toast-side effects, but tests want a stable
 * resolution point.
 */
export async function openExternalUrl(input: OpenUrlInput): Promise<OpenUrlOutcome> {
  const target = canonicaliseForOpen(input);
  const schemeMatch = /^([a-z]+):/i.exec(target);
  const scheme = schemeMatch ? schemeMatch[1]!.toLowerCase() : '';
  if (!ALLOWED_SCHEMES.has(scheme)) {
    showToast({
      kind: 'warning',
      message: `Blocked: unsupported URL scheme "${scheme || 'none'}"`,
    });
    return { ok: false, reason: 'invalid-scheme' };
  }

  const confirmFn = getConfirm();
  const confirmed = await Promise.resolve(
    confirmFn(`Open ${target} in browser?`),
  );
  if (!confirmed) {
    log.info('openExternalUrl: user cancelled', target);
    return { ok: false, reason: 'cancelled' };
  }

  const bridge = tryGetHostBridge();
  if (!bridge) {
    showToast({
      kind: 'warning',
      message: `Couldn't open ${target}: no host bridge`,
    });
    return { ok: false, reason: 'no-bridge' };
  }
  const fn = bridge.openExternalUrl;
  if (typeof fn !== 'function') {
    showToast({
      kind: 'warning',
      message: `Couldn't open ${target}: host does not support opening URLs`,
    });
    return { ok: false, reason: 'bridge-unsupported' };
  }
  try {
    await fn.call(bridge, { url: target });
    log.info('openExternalUrl: opened', target);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    log.warn('openExternalUrl: bridge rejected', error.message);
    showToast({
      kind: 'warning',
      message: `Couldn't open ${target}: ${error.message}`,
    });
    return { ok: false, reason: 'bridge-failed', error };
  }
}

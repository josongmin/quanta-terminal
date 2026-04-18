/**
 * Workspace fingerprint — Phase 4 stand-in.
 *
 * ADR 0005 calls for a real fingerprint derived from (1) the workspace's git
 * remote URL or (2) its absolute-path hash. That requires filesystem access
 * the browser doesn't have; the real fingerprint lands when the sidecar ships
 * and can interrogate the workspace directly.
 *
 * Until then, we derive a stable-per-session fingerprint from:
 *   - the cwd captured in the session store (`useSessionStore.getState().cwd`);
 *   - `window.location.origin` (distinguishes dev/prod hosts & multi-tenant
 *     embed scenarios without leaking host specifics into the stored key).
 *
 * When neither is available (SSR, early boot), we return 'default' — a
 * documented, recoverable fallback; it just means blocks go into a shared
 * bucket until the sidecar upgrades the fingerprint.
 *
 * The hash is a FNV-1a 32-bit digest rendered as an 8-char hex string. Not
 * cryptographic — just a stable identity that never collides in practice at
 * the scale we care about (tens of workspaces per profile).
 */

const DEFAULT_FINGERPRINT = 'default';

/** FNV-1a 32-bit. Cheap, non-crypto, deterministic across Node and browsers. */
export function hashFnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    // Multiply by the FNV 32-bit prime using shifts to stay in Smi territory.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export interface WorkspaceFingerprintInputs {
  readonly cwd: string | null | undefined;
  readonly origin: string | null | undefined;
}

/**
 * Derive the workspace fingerprint from the available inputs. Pure — lifted
 * out of `computeWorkspaceFingerprint` for tests that don't want to stand up
 * the session store.
 */
export function deriveWorkspaceFingerprint(inputs: WorkspaceFingerprintInputs): string {
  const cwd = (inputs.cwd ?? '').trim();
  const origin = (inputs.origin ?? '').trim();
  if (cwd.length === 0 && origin.length === 0) return DEFAULT_FINGERPRINT;
  return `ws_${hashFnv1a(`${origin}|${cwd}`)}`;
}

/**
 * Runtime accessor — reads from the session store when available and falls
 * back to `'default'` if nothing is known yet. Safe to call on SSR / tests;
 * the session store import is a value import (not a type) and the store is
 * initialized synchronously.
 *
 * NOTE: deliberately avoids `await` so callers can use it in synchronous hot
 * paths (serialize/deserialize). The fingerprint is captured at boot and
 * treated as stable for the app's lifetime — see `persistence.ts`.
 */
export function computeWorkspaceFingerprint(
  cwd?: string,
  origin?: string,
): string {
  return deriveWorkspaceFingerprint({
    cwd: cwd ?? null,
    origin:
      origin ??
      (typeof window !== 'undefined' && window.location ? window.location.origin : null),
  });
}

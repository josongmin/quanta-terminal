/**
 * Banner detectors — map session state transitions into banner conditions.
 *
 * This feature owns the "when does a banner become active" logic. Widgets
 * do not observe the session store directly to decide what banner to show;
 * they subscribe to the banner store via `entities/banner`, and this module
 * keeps the two in sync.
 *
 * Phase 1 signals wired:
 *   - shell_integration: session.shellIntegration === 'missing'
 *   - crash:             session.health === 'error'
 *                        OR session.exitCode is a crash code (>128 by POSIX
 *                        convention, or non-zero + 'exited' with no clean reason)
 *
 * Phase-later signals (quota, secret_rescan) wire here when the session store
 * starts reporting them. The rest of the banner pipeline (precedence, render,
 * dismiss) already exists and does not need changes when new conditions land.
 *
 * Exports a single `installBannerDetectors(options)` that starts the
 * subscriptions and returns an unsubscribe handle. Test helpers
 * (`raiseSyntheticBanner` / `clearSyntheticBanner`) let the banner-host test
 * drive the store without touching session state.
 */

import type { StoreApi } from 'zustand';
import { useSessionStore } from '../../entities/session/index.js';
import { useBannerStore } from '../../entities/banner/index.js';
import type { SessionState } from '../../entities/session/index.js';
import type { BannerCondition } from '../../shared/lib/banner-precedence.js';

export interface DetectorHandle {
  readonly unsubscribe: () => void;
}

/**
 * Start the detectors. Returns an unsubscribe that should be called on
 * unmount (AppProviders). Safe to install more than once — each installation
 * gets its own subscription.
 */
export function installBannerDetectors(): DetectorHandle {
  const bannerStore = useBannerStore.getState();

  // Seed once against the current session state so a reload into a degraded
  // session surfaces the banner immediately.
  evaluate(useSessionStore.getState(), bannerStore);

  const unsub = subscribeToStore(useSessionStore, (s) => evaluate(s, useBannerStore.getState()));

  return { unsubscribe: unsub };
}

/** Compute all current conditions and sync with the banner store. */
function evaluate(session: SessionState, banner: ReturnType<typeof useBannerStore.getState>): void {
  syncCondition(banner, 'shell_integration', session.shellIntegration === 'missing');
  // Crash heuristic: the session store only has `health` and `exitCode`. A
  // POSIX crash is normally exit code >128 (signal + 128). We also treat any
  // 'error' health as a crash so a failed spawn surfaces the same banner.
  const crashed =
    session.health === 'error' || (session.exitCode !== null && session.exitCode > 128);
  syncCondition(banner, 'crash', crashed);
}

function syncCondition(
  banner: ReturnType<typeof useBannerStore.getState>,
  condition: BannerCondition,
  active: boolean,
): void {
  const isActive = banner.active.has(condition);
  if (active && !isActive) banner.raise(condition);
  else if (!active && isActive) banner.clear(condition);
}

/**
 * Minimal subscribe-with-selector wrapper. zustand's default `subscribe`
 * already covers our needs; we re-wrap to keep the call site readable.
 */
function subscribeToStore<S>(store: StoreApi<S>, cb: (s: S) => void): () => void {
  return store.subscribe((s) => cb(s));
}

// -------- test helpers --------

/**
 * Raise a condition directly on the banner store. Exported so that
 * banner-host tests can verify the precedence-driven render without needing
 * the detectors or a session.
 */
export function raiseSyntheticBanner(condition: BannerCondition): void {
  useBannerStore.getState().raise(condition);
}

export function clearSyntheticBanner(condition: BannerCondition): void {
  useBannerStore.getState().clear(condition);
}

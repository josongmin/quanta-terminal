/**
 * Notification detector — subscribes to the block store and posts an OS
 * notification whenever a block transitions from `running` into a terminal
 * state AND its duration exceeds the user-configured threshold AND the
 * window is currently hidden (the user has switched away).
 *
 * Why these three gates:
 *   - "Transitioned from running": we need to fire exactly once per block,
 *     so we watch the status field of each entity and fire on the edge.
 *   - "Duration > threshold": short commands are noise; the whole point of
 *     this feature is to ping the user when they've walked away from the
 *     terminal and something important finished.
 *   - "Window hidden": the user can see the UI if the window is focused;
 *     posting a notification would be spammy. `document.visibilityState`
 *     is the standard signal — "hidden" covers tab-behind and minimized,
 *     while "visible" covers focused and unfocused-but-visible.
 *
 * Idempotency: a `Set<blockId>` tracks ids we've already notified about so
 * replayed events or repeated subscription callbacks don't double-fire.
 */

import { useBlockStore, type Block, type BlockStatus } from '../../entities/block/index.js';
import { t } from '../../shared/i18n/index.js';
import { notify } from './notify.js';
import { useNotifySettings } from './settings.js';

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

function isTerminal(status: BlockStatus): boolean {
  return status === 'completed' || status === 'canceled' || status === 'error';
}

/**
 * Exported for tests: compute the toast/notification body from a block.
 */
export function buildCompletionMessage(block: Block): string {
  const duration = formatDuration((block.completedAt ?? Date.now()) - block.startedAt);
  const exit = block.exitCode === null ? 'n/a' : String(block.exitCode);
  return t('notifications.commandDone', { exit, duration });
}

/**
 * Read the visibility state from the current document. Returns `'hidden'`
 * when no document exists (non-browser host) because that's the gate the
 * detector uses to fire — in a non-browser host we don't want to short-
 * circuit on "window visible".
 */
function isWindowHidden(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'hidden';
}

export interface DetectorHandle {
  readonly unsubscribe: () => void;
}

export interface InstallOptions {
  /** Override the visibility-state probe; default uses `document`. */
  readonly isHidden?: () => boolean;
  /** Override the notify sink (for tests). */
  readonly postNotification?: (message: string) => Promise<unknown> | unknown;
}

/**
 * Subscribe to the block store and fire notifications for qualifying
 * completions. Returns a handle with `unsubscribe()` so a page unmount (or
 * test teardown) cleans up cleanly.
 */
export function installNotificationDetector(options: InstallOptions = {}): DetectorHandle {
  const isHidden = options.isHidden ?? isWindowHidden;
  const postNotification =
    options.postNotification ??
    ((message: string) => notify({ title: 'Quanta', body: message }));

  // Snapshot the prior status map so we can fire exactly on the
  // running → terminal transition edge.
  const prevStatus = new Map<string, BlockStatus>();
  const alreadyNotified = new Set<string>();

  // Seed with the store's current entities so a late install doesn't
  // retroactively fire for already-terminal blocks.
  const initial = useBlockStore.getState();
  for (const [id, b] of Object.entries(initial.entities)) {
    prevStatus.set(id, b.status);
    if (isTerminal(b.status)) alreadyNotified.add(id);
  }

  const unsub = useBlockStore.subscribe((state) => {
    const settings = useNotifySettings.getState();
    if (!settings.enabled) {
      // Even when disabled, we keep updating prevStatus so toggling the
      // setting back on doesn't retroactively fire for blocks that
      // already finished.
      for (const [id, block] of Object.entries(state.entities)) {
        prevStatus.set(id, block.status);
        if (isTerminal(block.status)) alreadyNotified.add(id);
      }
      return;
    }
    for (const [id, block] of Object.entries(state.entities)) {
      const prior = prevStatus.get(id);
      prevStatus.set(id, block.status);
      if (alreadyNotified.has(id)) continue;
      if (prior === block.status) continue;
      if (prior !== 'running') continue;
      if (!isTerminal(block.status)) continue;
      const duration = (block.completedAt ?? Date.now()) - block.startedAt;
      if (duration < settings.longRunThresholdMs) continue;
      if (!isHidden()) continue;
      alreadyNotified.add(id);
      void Promise.resolve(postNotification(buildCompletionMessage(block))).catch(() => {
        // swallow — notification post failures are best-effort.
      });
    }
  });

  return {
    unsubscribe: () => {
      unsub();
      prevStatus.clear();
      alreadyNotified.clear();
    },
  };
}

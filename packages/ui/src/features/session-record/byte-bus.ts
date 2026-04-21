/**
 * Session-record byte bus — the thin pub-sub the session-connect layer
 * publishes into and the recorder controller subscribes from.
 *
 * Why a dedicated bus and not a direct import from connect.ts?
 *   - `features/session/connect.ts` must not reach across into another
 *     feature at runtime (FSD layer rule). Connect emits into this bus; the
 *     session-record controller owns its subscription.
 *   - A pub-sub also means the recorder is completely optional — if no one
 *     subscribes, the session path does zero extra work per chunk beyond a
 *     `listeners.length === 0` check.
 *
 * Only output chunks flow through here (pty_data → UTF-8 text). Input events
 * are out of scope for this pass.
 */

import type { SessionId } from '../../shared/types/generated/index.js';

export type ByteBusListener = (
  sessionId: SessionId,
  bytes: Uint8Array | string,
  tMs: number,
) => void;

const listeners: Set<ByteBusListener> = new Set();

/**
 * Connect-layer publisher. Called once per pty_data arrival, AFTER the chunk
 * has been dispatched to the block router so the happy path is never delayed
 * by a slow listener.
 */
export function publishSessionChunk(
  sessionId: SessionId,
  bytes: Uint8Array | string,
  tMs: number = Date.now(),
): void {
  if (listeners.size === 0) return;
  for (const l of Array.from(listeners)) {
    try {
      l(sessionId, bytes, tMs);
    } catch {
      // A misbehaving listener must not take down the PTY pipeline.
    }
  }
}

export function subscribeSessionBytes(listener: ByteBusListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Sibling-module helper — the controller re-exports this so tests can peek at
 * the subscriber count. Not needed in production.
 */
export function getObservedSessionId(): number {
  return listeners.size;
}

/** Test-only reset. */
export function __resetByteBusForTests(): void {
  listeners.clear();
}

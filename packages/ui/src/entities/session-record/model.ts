/**
 * Session-record store — the UI-observable state for the asciicast recorder.
 *
 * Minimal surface: `recording` bit, the owning `sessionId`, the wall-clock
 * start time, and two tick fields (`elapsedSec`, `byteCount`) that the
 * indicator reads once a second to repaint itself.
 *
 * The recorder singleton itself — the event buffer + serializer — lives in
 * `features/session-record/recorder.ts`. This store only mirrors the public
 * counters so widgets don't have to reach into the feature module.
 */

import { create } from 'zustand';
import type { SessionId } from '../../shared/types/generated/index.js';

export interface SessionRecordState {
  readonly recording: boolean;
  readonly sessionId: SessionId | null;
  readonly startedAtMs: number;
  readonly elapsedSec: number;
  readonly byteCount: number;
}

export interface SessionRecordActions {
  /** Transition to recording for `sessionId`. Snaps `startedAtMs` to Date.now(). */
  begin(sessionId: SessionId): void;
  /** Transition to idle. Zeroes the session pointer and counters. */
  end(): void;
  /** Repaint signal from the timer effect — keeps the indicator fresh. */
  tick(elapsedSec: number, byteCount: number): void;
  /** Test-only: full reset. */
  reset(): void;
}

const INITIAL: SessionRecordState = {
  recording: false,
  sessionId: null,
  startedAtMs: 0,
  elapsedSec: 0,
  byteCount: 0,
};

export const useSessionRecordStore = create<SessionRecordState & SessionRecordActions>()(
  (set) => ({
    ...INITIAL,
    begin: (sessionId) =>
      set(() => ({
        recording: true,
        sessionId,
        startedAtMs: Date.now(),
        elapsedSec: 0,
        byteCount: 0,
      })),
    end: () => set(() => ({ ...INITIAL })),
    tick: (elapsedSec, byteCount) =>
      set((prev) => {
        if (!prev.recording) return prev;
        // Cheap identity guard — avoids re-render thrash when the timer fires
        // but neither counter has advanced (e.g. idle session).
        if (prev.elapsedSec === elapsedSec && prev.byteCount === byteCount) return prev;
        return { ...prev, elapsedSec, byteCount };
      }),
    reset: () => set(() => ({ ...INITIAL })),
  }),
);

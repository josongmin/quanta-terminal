/**
 * IME state-machine type contracts — ADR 0018 / EPIC-E §5.
 *
 * The state machine itself is pure: `transition(current, event, opts) →
 * { next, effects }`. The orchestrator (`input-host.ts`) applies the
 * side-effects (mount/unmount overlay, start timers, emit bytes).
 */
import type { PasteEvent, Platform } from '../types';

export type ImeStateKind = 'Idle' | 'Composing';

export interface ImeStateIdle {
  readonly kind: 'Idle';
}

export interface ImeStateComposing {
  readonly kind: 'Composing';
  readonly text: string;
  /** `Composing{persisted=true}` on Linux/Windows while 1s timer running. */
  readonly persisted: boolean;
  /** High-resolution t0 (ms) for duration telemetry. */
  readonly startedAt: number;
}

export type ImeState = ImeStateIdle | ImeStateComposing;

export type ImeEvent =
  | { kind: 'compositionstart'; data: string }
  | { kind: 'compositionupdate'; data: string }
  | { kind: 'compositionend'; data: string }
  | { kind: 'keydown-escape' }
  | { kind: 'keydown-other' }
  | { kind: 'blur' }
  | { kind: 'focus' }
  | { kind: 'persist-timer-expired' }
  | { kind: 'sidecar-disconnect' }
  | { kind: 'resize' };

export interface PreeditOverlayProps {
  text: string;
  anchor: { row: number; col: number; x?: number; y?: number };
  dimmed?: boolean;
  onMeasure?: (rect: DOMRect) => void;
}

export type ImeSideEffect =
  | { kind: 'mount-overlay'; text: string }
  | { kind: 'update-overlay'; text: string }
  | { kind: 'unmount-overlay' }
  | { kind: 'dim-overlay' }
  | { kind: 'undim-overlay' }
  | { kind: 'start-persist-timer' }
  | { kind: 'cancel-persist-timer' }
  | { kind: 'reanchor-overlay' }
  | { kind: 'emit-commit-bytes'; paste: PasteEvent }
  | { kind: 'show-banner'; message: string }
  | { kind: 'telemetry'; name: string; value?: number; labels?: Record<string, string> };

export interface TransitionOpts {
  platform: Platform;
  now: number;
}

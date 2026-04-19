/**
 * Pure IME state machine — EPIC-E §5, ADR 0018.
 *
 * Transition table T1..T18. The function is total and side-effect-free:
 * callers receive `{ next, effects }` and apply the effects externally.
 * Telemetry counters align with ADR 0018 §9.
 */
import type {
  ImeEvent,
  ImeSideEffect,
  ImeState,
  ImeStateComposing,
  TransitionOpts,
} from './ime-types';

export const IDLE: ImeState = { kind: 'Idle' };

/** Starting timestamp is captured at `Composing` entry. */
function composingState(text: string, startedAt: number, persisted = false): ImeStateComposing {
  return { kind: 'Composing', text, persisted, startedAt };
}

function telemetry(name: string, labels?: Record<string, string>): ImeSideEffect {
  return labels ? { kind: 'telemetry', name, labels } : { kind: 'telemetry', name };
}

function durationEffect(start: number, now: number): ImeSideEffect {
  return { kind: 'telemetry', name: 'ime.composition_duration_ms', value: now - start };
}

/**
 * Apply one event to the state machine. Returns the next state and the
 * ordered list of side-effects to apply.
 */
export function transition(
  current: ImeState,
  event: ImeEvent,
  opts: TransitionOpts,
): { next: ImeState; effects: ImeSideEffect[] } {
  switch (current.kind) {
    case 'Idle':
      return transitionFromIdle(event, opts);
    case 'Composing':
      return transitionFromComposing(current, event, opts);
  }
}

function transitionFromIdle(
  event: ImeEvent,
  opts: TransitionOpts,
): { next: ImeState; effects: ImeSideEffect[] } {
  switch (event.kind) {
    case 'compositionstart': {
      // T1 — Idle → Composing
      const effects: ImeSideEffect[] = [
        { kind: 'mount-overlay', text: event.data },
        telemetry('ime.lifecycle_start'),
      ];
      return { next: composingState(event.data, opts.now), effects };
    }
    case 'compositionend':
      // T14 — stray end while Idle.
      return {
        next: IDLE,
        effects: [telemetry('ime.stray_end')],
      };
    // T11 — various stray events while Idle are no-ops.
    case 'compositionupdate':
    case 'keydown-escape':
    case 'keydown-other':
    case 'blur':
    case 'focus':
    case 'resize':
    case 'persist-timer-expired':
    case 'sidecar-disconnect':
      return { next: IDLE, effects: [] };
  }
}

function transitionFromComposing(
  current: ImeStateComposing,
  event: ImeEvent,
  opts: TransitionOpts,
): { next: ImeState; effects: ImeSideEffect[] } {
  switch (event.kind) {
    case 'compositionupdate': {
      // T2 — update overlay, no PTY.
      return {
        next: composingState(event.data, current.startedAt, current.persisted),
        effects: [{ kind: 'update-overlay', text: event.data }],
      };
    }
    case 'compositionend': {
      if (event.data.length > 0) {
        // T3 — Committed → Idle, emit bytes via bracketed-paste-aware path.
        return {
          next: IDLE,
          effects: [
            {
              kind: 'emit-commit-bytes',
              paste: { text: event.data, length: event.data.length },
            },
            { kind: 'unmount-overlay' },
            telemetry('ime.lifecycle_commit'),
            durationEffect(current.startedAt, opts.now),
          ],
        };
      }
      // T4 — empty end → cancel.
      return {
        next: IDLE,
        effects: [
          { kind: 'unmount-overlay' },
          telemetry('ime.lifecycle_cancel', { reason: 'empty_end' }),
          durationEffect(current.startedAt, opts.now),
        ],
      };
    }
    case 'keydown-escape': {
      // T5 — Esc cancels and is NOT forwarded to PTY.
      return {
        next: IDLE,
        effects: [
          { kind: 'unmount-overlay' },
          telemetry('ime.lifecycle_cancel', { reason: 'esc' }),
          durationEffect(current.startedAt, opts.now),
        ],
      };
    }
    case 'keydown-other': {
      // T6 — suppressed, no state change.
      return { next: current, effects: [] };
    }
    case 'blur': {
      if (opts.platform === 'macos') {
        // T7 — macOS blur cancels immediately.
        return {
          next: IDLE,
          effects: [
            { kind: 'unmount-overlay' },
            telemetry('ime.lifecycle_cancel', { reason: 'blur' }),
            durationEffect(current.startedAt, opts.now),
          ],
        };
      }
      // T8 — Linux/Windows preserve for 1s, dim overlay.
      if (current.persisted) return { next: current, effects: [] };
      return {
        next: composingState(current.text, current.startedAt, true),
        effects: [{ kind: 'dim-overlay' }, { kind: 'start-persist-timer' }],
      };
    }
    case 'focus': {
      if (current.persisted) {
        // T9 — un-dim and re-anchor, cancel timer.
        return {
          next: composingState(current.text, current.startedAt, false),
          effects: [
            { kind: 'undim-overlay' },
            { kind: 'cancel-persist-timer' },
            { kind: 'reanchor-overlay' },
          ],
        };
      }
      return { next: current, effects: [] };
    }
    case 'persist-timer-expired': {
      if (current.persisted) {
        // T10 — cancel after timeout.
        return {
          next: IDLE,
          effects: [
            { kind: 'unmount-overlay' },
            telemetry('ime.lifecycle_cancel', { reason: 'blur_timeout' }),
            durationEffect(current.startedAt, opts.now),
          ],
        };
      }
      return { next: current, effects: [] };
    }
    case 'sidecar-disconnect': {
      // T12 / T13 — abnormal termination.
      return {
        next: IDLE,
        effects: [
          { kind: 'unmount-overlay' },
          { kind: 'show-banner', message: 'session restarted; re-enter text' },
          telemetry('ime.abnormal_termination'),
          durationEffect(current.startedAt, opts.now),
        ],
      };
    }
    case 'resize': {
      // T16 / T17 — re-anchor, composition untouched.
      return { next: current, effects: [{ kind: 'reanchor-overlay' }] };
    }
    case 'compositionstart': {
      // T15 — nested start; treat as update.
      return {
        next: composingState(event.data, current.startedAt, current.persisted),
        effects: [
          { kind: 'update-overlay', text: event.data },
          telemetry('ime.stray_nested_start'),
        ],
      };
    }
  }
}

/**
 * Helper for `input-host.ts`: classify a raw DOM keydown into the state
 * machine's vocabulary. `Escape` is the only DOM key that maps to
 * `keydown-escape`; everything else is `keydown-other`.
 */
export function classifyKeydown(key: string): 'keydown-escape' | 'keydown-other' {
  return key === 'Escape' ? 'keydown-escape' : 'keydown-other';
}

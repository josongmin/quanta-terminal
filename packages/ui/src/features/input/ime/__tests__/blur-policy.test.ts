import { describe, expect, it } from 'vitest';

import type { ImeState } from '../ime-types';
import { IDLE, transition } from '../ImeStateMachine';

function compose(): { state: ImeState } {
  const start = transition(IDLE, { kind: 'compositionstart', data: 'ㅎ' }, {
    platform: 'macos',
    now: 0,
  });
  return { state: start.next };
}

describe('Blur policy (per-platform)', () => {
  it('macOS: blur during composition → immediate cancel, zero bytes', () => {
    const { state } = compose();
    const { next, effects } = transition(state, { kind: 'blur' }, { platform: 'macos', now: 100 });
    expect(next.kind).toBe('Idle');
    expect(effects.some((e) => e.kind === 'unmount-overlay')).toBe(true);
    expect(effects.every((e) => e.kind !== 'emit-commit-bytes')).toBe(true);
  });

  it('Linux: blur during composition → dim + persist timer', () => {
    const { state } = compose();
    const { next, effects } = transition(state, { kind: 'blur' }, { platform: 'linux', now: 100 });
    expect(next.kind).toBe('Composing');
    expect((next as { persisted: boolean }).persisted).toBe(true);
    expect(effects.some((e) => e.kind === 'dim-overlay')).toBe(true);
    expect(effects.some((e) => e.kind === 'start-persist-timer')).toBe(true);
  });

  it('Linux: focus during persisted → un-dim + re-anchor', () => {
    const { state } = compose();
    const { next: dimmed } = transition(state, { kind: 'blur' }, { platform: 'linux', now: 100 });
    const { next, effects } = transition(dimmed, { kind: 'focus' }, { platform: 'linux', now: 500 });
    expect(next.kind).toBe('Composing');
    expect((next as { persisted: boolean }).persisted).toBe(false);
    expect(effects.some((e) => e.kind === 'undim-overlay')).toBe(true);
    expect(effects.some((e) => e.kind === 'cancel-persist-timer')).toBe(true);
    expect(effects.some((e) => e.kind === 'reanchor-overlay')).toBe(true);
  });

  it('Linux: persist-timer-expired without focus → cancel', () => {
    const { state } = compose();
    const { next: dimmed } = transition(state, { kind: 'blur' }, { platform: 'linux', now: 100 });
    const { next, effects } = transition(
      dimmed,
      { kind: 'persist-timer-expired' },
      { platform: 'linux', now: 1100 },
    );
    expect(next.kind).toBe('Idle');
    expect(effects.some((e) => e.kind === 'unmount-overlay')).toBe(true);
    expect(
      effects.some(
        (e) => e.kind === 'telemetry' && e.name === 'ime.lifecycle_cancel' && e.labels?.reason === 'blur_timeout',
      ),
    ).toBe(true);
  });

  it('Windows behaves like Linux for blur', () => {
    const { state } = compose();
    const { next, effects } = transition(state, { kind: 'blur' }, { platform: 'windows', now: 100 });
    expect(next.kind).toBe('Composing');
    expect((next as { persisted: boolean }).persisted).toBe(true);
    expect(effects.some((e) => e.kind === 'start-persist-timer')).toBe(true);
  });
});

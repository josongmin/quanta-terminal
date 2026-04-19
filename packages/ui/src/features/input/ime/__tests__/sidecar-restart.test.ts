import { describe, expect, it } from 'vitest';

import { IDLE, transition } from '../ImeStateMachine';

describe('Sidecar restart during composition', () => {
  it('abnormal termination increments counter + unmounts overlay', () => {
    const { next: composing } = transition(
      IDLE,
      { kind: 'compositionstart', data: 'ㅎ' },
      { platform: 'macos', now: 0 },
    );
    const { next, effects } = transition(
      composing,
      { kind: 'sidecar-disconnect' },
      { platform: 'macos', now: 100 },
    );
    expect(next.kind).toBe('Idle');
    expect(effects.some((e) => e.kind === 'unmount-overlay')).toBe(true);
    expect(effects.some((e) => e.kind === 'show-banner')).toBe(true);
    expect(
      effects.some((e) => e.kind === 'telemetry' && e.name === 'ime.abnormal_termination'),
    ).toBe(true);
  });

  it('also works when composing is persisted (Linux)', () => {
    const { next: composing } = transition(
      IDLE,
      { kind: 'compositionstart', data: 'ㅎ' },
      { platform: 'linux', now: 0 },
    );
    const { next: persisted } = transition(
      composing,
      { kind: 'blur' },
      { platform: 'linux', now: 100 },
    );
    const { next, effects } = transition(
      persisted,
      { kind: 'sidecar-disconnect' },
      { platform: 'linux', now: 200 },
    );
    expect(next.kind).toBe('Idle');
    expect(effects.some((e) => e.kind === 'show-banner')).toBe(true);
  });
});

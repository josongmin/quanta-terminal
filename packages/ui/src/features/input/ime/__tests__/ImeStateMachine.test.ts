import { describe, expect, it } from 'vitest';

import type { ImeSideEffect, ImeState } from '../ime-types';
import { IDLE, transition } from '../ImeStateMachine';

function effectKinds(effects: ImeSideEffect[]): string[] {
  return effects.map((e) => e.kind);
}

function effectByKind<K extends ImeSideEffect['kind']>(
  effects: ImeSideEffect[],
  kind: K,
): Extract<ImeSideEffect, { kind: K }> | undefined {
  return effects.find((e) => e.kind === kind) as Extract<ImeSideEffect, { kind: K }> | undefined;
}

function composing(text = 'a', persisted = false, startedAt = 0): ImeState {
  return { kind: 'Composing', text, persisted, startedAt };
}

const MAC = { platform: 'macos' as const, now: 100 };
const LIN = { platform: 'linux' as const, now: 100 };

describe('IME state machine — T1..T18', () => {
  it('T1: Idle + compositionstart → Composing + mount-overlay + telemetry', () => {
    const { next, effects } = transition(IDLE, { kind: 'compositionstart', data: 'ㅎ' }, MAC);
    expect(next.kind).toBe('Composing');
    expect(effectKinds(effects)).toEqual(['mount-overlay', 'telemetry']);
    const mount = effectByKind(effects, 'mount-overlay');
    expect(mount?.text).toBe('ㅎ');
  });

  it('T2: Composing + compositionupdate → Composing updated text, no bytes', () => {
    const { next, effects } = transition(
      composing('ㅎ'),
      { kind: 'compositionupdate', data: '하' },
      MAC,
    );
    expect(next.kind).toBe('Composing');
    expect(effectKinds(effects)).toEqual(['update-overlay']);
    expect(effects.every((e) => e.kind !== 'emit-commit-bytes')).toBe(true);
  });

  it('T3: Composing + compositionend(non-empty) → Idle + emit-commit-bytes + unmount', () => {
    const { next, effects } = transition(
      composing('한', false, 10),
      { kind: 'compositionend', data: '한' },
      MAC,
    );
    expect(next.kind).toBe('Idle');
    expect(effectKinds(effects)).toContain('emit-commit-bytes');
    expect(effectKinds(effects)).toContain('unmount-overlay');
    const commit = effectByKind(effects, 'emit-commit-bytes');
    expect(commit?.paste.text).toBe('한');
  });

  it('T4: Composing + compositionend(empty) → Idle, no bytes', () => {
    const { next, effects } = transition(composing('ㅎ'), { kind: 'compositionend', data: '' }, MAC);
    expect(next.kind).toBe('Idle');
    expect(effectKinds(effects)).toContain('unmount-overlay');
    expect(effectKinds(effects)).not.toContain('emit-commit-bytes');
  });

  it('T5: Composing + keydown-escape → Idle, no bytes', () => {
    const { next, effects } = transition(composing('ㅎ'), { kind: 'keydown-escape' }, MAC);
    expect(next.kind).toBe('Idle');
    expect(effectKinds(effects)).toContain('unmount-overlay');
    expect(effectKinds(effects)).not.toContain('emit-commit-bytes');
  });

  it('T6: Composing + keydown-other → unchanged, no bytes', () => {
    const s = composing('ㅎ');
    const { next, effects } = transition(s, { kind: 'keydown-other' }, MAC);
    expect(next).toBe(s);
    expect(effects.length).toBe(0);
  });

  it('T7: Composing + blur (macos) → Idle', () => {
    const { next, effects } = transition(composing('ㅎ'), { kind: 'blur' }, MAC);
    expect(next.kind).toBe('Idle');
    expect(effectKinds(effects)).toContain('unmount-overlay');
  });

  it('T8: Composing + blur (linux) → Composing{persisted} + dim + timer', () => {
    const { next, effects } = transition(composing('ㅎ'), { kind: 'blur' }, LIN);
    expect(next.kind).toBe('Composing');
    expect((next as { persisted: boolean }).persisted).toBe(true);
    expect(effectKinds(effects)).toContain('dim-overlay');
    expect(effectKinds(effects)).toContain('start-persist-timer');
  });

  it('T9: Composing{persisted} + focus → undim + cancel timer + reanchor', () => {
    const persisted = { ...composing('ㅎ', true), persisted: true } as ImeState;
    const { next, effects } = transition(persisted, { kind: 'focus' }, LIN);
    expect(next.kind).toBe('Composing');
    expect((next as { persisted: boolean }).persisted).toBe(false);
    expect(effectKinds(effects)).toEqual(['undim-overlay', 'cancel-persist-timer', 'reanchor-overlay']);
  });

  it('T10: Composing{persisted} + persist-timer-expired → Idle', () => {
    const persisted = { ...composing('ㅎ', true), persisted: true } as ImeState;
    const { next, effects } = transition(persisted, { kind: 'persist-timer-expired' }, LIN);
    expect(next.kind).toBe('Idle');
    expect(effectKinds(effects)).toContain('unmount-overlay');
  });

  it('T11: Idle + blur/focus/keydown-escape → Idle no-op', () => {
    for (const ev of [{ kind: 'blur' as const }, { kind: 'focus' as const }, { kind: 'keydown-escape' as const }]) {
      const { next, effects } = transition(IDLE, ev, MAC);
      expect(next.kind).toBe('Idle');
      expect(effects.length).toBe(0);
    }
  });

  it('T12: Composing + sidecar-disconnect → Idle + banner + telemetry', () => {
    const { next, effects } = transition(composing('ㅎ'), { kind: 'sidecar-disconnect' }, MAC);
    expect(next.kind).toBe('Idle');
    expect(effectKinds(effects)).toContain('unmount-overlay');
    expect(effectKinds(effects)).toContain('show-banner');
    expect(effects.some((e) => e.kind === 'telemetry' && e.name === 'ime.abnormal_termination')).toBe(
      true,
    );
  });

  it('T13: Composing{persisted} + sidecar-disconnect → Idle', () => {
    const persisted = { ...composing('ㅎ', true), persisted: true } as ImeState;
    const { next, effects } = transition(persisted, { kind: 'sidecar-disconnect' }, LIN);
    expect(next.kind).toBe('Idle');
    expect(effectKinds(effects)).toContain('show-banner');
  });

  it('T14: Idle + compositionend → Idle with stray_end telemetry', () => {
    const { next, effects } = transition(IDLE, { kind: 'compositionend', data: '' }, MAC);
    expect(next.kind).toBe('Idle');
    expect(effects.some((e) => e.kind === 'telemetry' && e.name === 'ime.stray_end')).toBe(true);
  });

  it('T15: Composing + compositionstart (nested) → stray telemetry + update', () => {
    const { next, effects } = transition(
      composing('ㅎ'),
      { kind: 'compositionstart', data: '하' },
      MAC,
    );
    expect(next.kind).toBe('Composing');
    expect(effectKinds(effects)).toContain('update-overlay');
    expect(effects.some((e) => e.kind === 'telemetry' && e.name === 'ime.stray_nested_start')).toBe(
      true,
    );
  });

  it('T16: Composing + resize → reanchor', () => {
    const s = composing('ㅎ');
    const { next, effects } = transition(s, { kind: 'resize' }, MAC);
    expect(next).toBe(s);
    expect(effectKinds(effects)).toEqual(['reanchor-overlay']);
  });

  it('T17: Composing{persisted} + resize → reanchor, persisted preserved', () => {
    const s = { ...composing('ㅎ', true), persisted: true } as ImeState;
    const { next, effects } = transition(s, { kind: 'resize' }, LIN);
    expect(next.kind).toBe('Composing');
    expect((next as { persisted: boolean }).persisted).toBe(true);
    expect(effectKinds(effects)).toEqual(['reanchor-overlay']);
  });

  it('T18: events during Idle do not panic on focus (mode-change is handled elsewhere)', () => {
    const { next, effects } = transition(IDLE, { kind: 'focus' }, MAC);
    expect(next.kind).toBe('Idle');
    expect(effects).toEqual([]);
  });

  // Additional: persisted blur is idempotent.
  it('Persisted blur is idempotent (second blur is no-op)', () => {
    const persisted = { ...composing('ㅎ', true), persisted: true } as ImeState;
    const { next, effects } = transition(persisted, { kind: 'blur' }, LIN);
    expect(next).toBe(persisted);
    expect(effects.length).toBe(0);
  });

  it('T9-guard: focus while not persisted is no-op', () => {
    const s = composing('ㅎ');
    const { next, effects } = transition(s, { kind: 'focus' }, LIN);
    expect(next).toBe(s);
    expect(effects.length).toBe(0);
  });
});

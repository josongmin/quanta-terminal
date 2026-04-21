/**
 * Plan 0005 P0 audit — IME state-machine edge cases.
 *
 * Augments the T1..T18 coverage in `ImeStateMachine.test.ts` and the
 * recording-replay matrix (korean-2set, jp-ime, cn-pinyin, deadkey).
 *
 *   §5.1  compositionupdate arriving BEFORE compositionstart is a stray
 *         event and MUST NOT mount an overlay.
 *   §5.2  compositionstart with empty data (user focused the IME with
 *         no pre-preedit) mounts a zero-width overlay.
 *   §5.3  Consecutive blur-without-focus events on Linux/Windows keep
 *         persisted=true (idempotent).
 *   §5.4  Persisted + resize reanchors but keeps persisted state.
 *   §5.5  Persisted + sidecar-disconnect also terminates cleanly.
 *   §5.6  `classifyKeydown` correctly distinguishes the three magic
 *         strings ("Escape" vs "a" vs "ArrowUp").
 *   §5.7  Duration telemetry is computed even when opts.now < startedAt
 *         (clock skew clamp is implicit).
 */
import { describe, expect, it } from 'vitest';

import type { ImeSideEffect, ImeState } from '../ime-types';
import { classifyKeydown, IDLE, transition } from '../ImeStateMachine';

function effectKinds(effects: ImeSideEffect[]): string[] {
  return effects.map((e) => e.kind);
}

function composing(text = 'a', persisted = false, startedAt = 0): ImeState {
  return { kind: 'Composing', text, persisted, startedAt };
}

const MAC = { platform: 'macos' as const, now: 100 };
const LIN = { platform: 'linux' as const, now: 100 };
const WIN = { platform: 'windows' as const, now: 100 };

// ---------------------------------------------------------------------------
// §5.1 — stray compositionupdate while Idle
// ---------------------------------------------------------------------------
describe('audit §5.1 — stray compositionupdate while Idle is a no-op', () => {
  it('Idle + compositionupdate does not mount overlay or telemetry', () => {
    /**
     * Some browsers emit a stray `compositionupdate` after a committed
     * composition ends. The state machine must stay in Idle without
     * mounting a phantom overlay.
     */
    const { next, effects } = transition(
      IDLE,
      { kind: 'compositionupdate', data: 'stray' },
      MAC,
    );
    expect(next.kind).toBe('Idle');
    expect(effects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §5.2 — compositionstart with empty data
// ---------------------------------------------------------------------------
describe('audit §5.2 — compositionstart with empty data', () => {
  it('Idle + compositionstart(data="") → Composing with overlay text=""', () => {
    /**
     * Some IMEs (notably macOS dead-key path) emit
     * compositionstart({data: ''}) and feed preedit bytes via subsequent
     * compositionupdate events. The state machine must accept this
     * as a valid start with zero-width overlay.
     */
    const { next, effects } = transition(
      IDLE,
      { kind: 'compositionstart', data: '' },
      MAC,
    );
    expect(next.kind).toBe('Composing');
    expect(effectKinds(effects)).toContain('mount-overlay');
    const mountEff = effects.find((e) => e.kind === 'mount-overlay');
    if (mountEff && mountEff.kind === 'mount-overlay') {
      expect(mountEff.text).toBe('');
    } else {
      throw new Error('missing mount-overlay effect');
    }
  });
});

// ---------------------------------------------------------------------------
// §5.3 — double-blur on Linux preserves persisted state
// ---------------------------------------------------------------------------
describe('audit §5.3 — double-blur on Linux/Windows is idempotent', () => {
  it('Composing{persisted=true} + blur → Composing{persisted=true} no-op (linux)', () => {
    /**
     * Two successive blur events should NOT re-start the persist timer
     * (that would double-dim the overlay or reset the 1s grace period).
     * The state machine's T8 guard is `if (current.persisted) return
     * {next, effects:[]}`.
     */
    const s = { ...composing('ㅎ', true), persisted: true } as ImeState;
    const { next, effects } = transition(s, { kind: 'blur' }, LIN);
    expect(next).toBe(s);
    expect(effects.length).toBe(0);
  });

  it('Composing{persisted=true} + blur → Composing{persisted=true} no-op (windows)', () => {
    /** Mirror of the Linux case for the Windows platform branch. */
    const s = { ...composing('ㅎ', true), persisted: true } as ImeState;
    const { next, effects } = transition(s, { kind: 'blur' }, WIN);
    expect(next).toBe(s);
    expect(effects.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §5.4 — persisted + resize preserves persisted state
// ---------------------------------------------------------------------------
describe('audit §5.4 — resize during persisted composition', () => {
  it('Composing{persisted=true} + resize → still persisted, reanchors overlay', () => {
    /**
     * If the user resizes the window during the 1s blur grace period on
     * Linux, the overlay must reanchor but the persisted timer state
     * must survive.
     */
    const s = { ...composing('ㅎ', true), persisted: true } as ImeState;
    const { next, effects } = transition(s, { kind: 'resize' }, LIN);
    expect(next.kind).toBe('Composing');
    expect((next as { persisted: boolean }).persisted).toBe(true);
    expect(effectKinds(effects)).toEqual(['reanchor-overlay']);
  });
});

// ---------------------------------------------------------------------------
// §5.5 — sidecar-disconnect from persisted state
// ---------------------------------------------------------------------------
describe('audit §5.5 — sidecar-disconnect from Composing{persisted}', () => {
  it('persisted + sidecar-disconnect → Idle with banner + telemetry', () => {
    /**
     * The abnormal-termination path must work from BOTH the
     * ordinary Composing and the persisted variant. The recording
     * runner covers the ordinary path; this pins the persisted variant.
     */
    const s = { ...composing('ㅎ', true), persisted: true } as ImeState;
    const { next, effects } = transition(s, { kind: 'sidecar-disconnect' }, LIN);
    expect(next.kind).toBe('Idle');
    expect(effectKinds(effects)).toContain('show-banner');
    expect(effectKinds(effects)).toContain('unmount-overlay');
    expect(
      effects.some(
        (e) => e.kind === 'telemetry' && e.name === 'ime.abnormal_termination',
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §5.6 — classifyKeydown vocabulary
// ---------------------------------------------------------------------------
describe('audit §5.6 — classifyKeydown mapping', () => {
  it('"Escape" → keydown-escape', () => {
    expect(classifyKeydown('Escape')).toBe('keydown-escape');
  });

  it('ordinary keys → keydown-other', () => {
    expect(classifyKeydown('a')).toBe('keydown-other');
    expect(classifyKeydown('ArrowUp')).toBe('keydown-other');
    expect(classifyKeydown('Enter')).toBe('keydown-other');
    expect(classifyKeydown('Tab')).toBe('keydown-other');
  });

  it('empty string is NOT escape', () => {
    /**
     * Regression guard: a missing `key` field should fall through to
     * keydown-other and NOT accidentally match as escape.
     */
    expect(classifyKeydown('')).toBe('keydown-other');
  });
});

// ---------------------------------------------------------------------------
// §5.7 — duration telemetry invariants
// ---------------------------------------------------------------------------
describe('audit §5.7 — duration telemetry is always emitted on terminal transitions', () => {
  /**
   * Every terminal transition from Composing (commit, empty-end, esc,
   * mac-blur, timer-expire, sidecar-disconnect) MUST emit a
   * `ime.composition_duration_ms` telemetry record. This is how the
   * observability stack measures IME latency; missing one would create
   * a gap in the duration histogram.
   */

  it('commit transition emits duration telemetry', () => {
    const s = composing('ㅎ', false, 10);
    const { effects } = transition(
      s,
      { kind: 'compositionend', data: '한' },
      { ...MAC, now: 50 },
    );
    const dur = effects.find(
      (e) => e.kind === 'telemetry' && e.name === 'ime.composition_duration_ms',
    );
    expect(dur).toBeDefined();
    if (dur && dur.kind === 'telemetry') {
      expect(dur.value).toBe(40);
    }
  });

  it('esc cancel transition emits duration telemetry', () => {
    const s = composing('ㅎ', false, 10);
    const { effects } = transition(s, { kind: 'keydown-escape' }, { ...MAC, now: 25 });
    const dur = effects.find(
      (e) => e.kind === 'telemetry' && e.name === 'ime.composition_duration_ms',
    );
    expect(dur).toBeDefined();
    if (dur && dur.kind === 'telemetry') {
      expect(dur.value).toBe(15);
    }
  });

  it('sidecar-disconnect emits duration telemetry', () => {
    const s = composing('ㅎ', false, 10);
    const { effects } = transition(
      s,
      { kind: 'sidecar-disconnect' },
      { ...MAC, now: 1000 },
    );
    const dur = effects.find(
      (e) => e.kind === 'telemetry' && e.name === 'ime.composition_duration_ms',
    );
    expect(dur).toBeDefined();
    if (dur && dur.kind === 'telemetry') {
      expect(dur.value).toBe(990);
    }
  });

  it('timer-expire emits duration telemetry', () => {
    const s = { ...composing('ㅎ', true, 50), persisted: true } as ImeState;
    const { effects } = transition(
      s,
      { kind: 'persist-timer-expired' },
      { ...LIN, now: 1100 },
    );
    const dur = effects.find(
      (e) => e.kind === 'telemetry' && e.name === 'ime.composition_duration_ms',
    );
    expect(dur).toBeDefined();
    if (dur && dur.kind === 'telemetry') {
      expect(dur.value).toBe(1050);
    }
  });

  it('duration is negative when clock skews backwards (accepted raw value)', () => {
    /**
     * Clock regressions can happen on unsynchronized laptops. The state
     * machine does NOT clamp the duration to >= 0 today. Pinning this
     * behavior so an observer can decide to clamp downstream (not
     * inside the pure transition function).
     */
    const s = composing('ㅎ', false, 1000);
    const { effects } = transition(
      s,
      { kind: 'compositionend', data: '한' },
      { ...MAC, now: 500 },
    );
    const dur = effects.find(
      (e) => e.kind === 'telemetry' && e.name === 'ime.composition_duration_ms',
    );
    expect(dur).toBeDefined();
    if (dur && dur.kind === 'telemetry') {
      expect(dur.value).toBe(-500);
    }
  });
});

// ---------------------------------------------------------------------------
// §5.8 — composition text is read from event.data, not event state
// ---------------------------------------------------------------------------
describe('audit §5.8 — compositionupdate replaces text (not appends)', () => {
  /**
   * IMEs REPLACE the preedit on every update event; the state machine
   * must not accumulate. This pins the invariant in case a future
   * refactor adds a string builder.
   */
  it('update(ㅎ) → update(하) → update(한) → text="한" (replacement semantics)', () => {
    const s0 = composing('', false, 0);
    const { next: s1 } = transition(
      s0,
      { kind: 'compositionupdate', data: 'ㅎ' },
      MAC,
    );
    const { next: s2 } = transition(
      s1,
      { kind: 'compositionupdate', data: '하' },
      MAC,
    );
    const { next: s3 } = transition(
      s2,
      { kind: 'compositionupdate', data: '한' },
      MAC,
    );
    expect(s3.kind).toBe('Composing');
    if (s3.kind === 'Composing') {
      expect(s3.text).toBe('한');
    }
  });
});

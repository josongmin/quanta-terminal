/**
 * Mode-event / grid-mirror envelope correctness audit (plan 0005 P0
 * adversarial pass).
 *
 * The base `VtEmulator.test.ts` checks envelope SHAPES; this file checks
 * INVARIANTS between successive envelopes — the contract GridMirror relies
 * on to interpret deltas without ambiguity:
 *   - `mode_changed` always precedes any delta sourced from the new buffer
 *   - Envelope `buffer_kind` tag matches active buffer at the time of emit
 *   - `sequence_no` strictly ascends across every envelope
 *   - `resize_generation` bumps on resize and stamps all envelopes until
 *     the next resize
 *   - Re-applying the same `mode_changed` twice is idempotent on the
 *     grid-mirror side (we capture the engine shape here; mirror is
 *     tested in its own suite)
 *
 * Every test carries an invariant docstring.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../VtEmulator.js';
import type {
  GridEventEnvelope,
  GridPayload,
  ModeChangedPayload,
} from '../../grid-mirror/types.js';

type Env = GridEventEnvelope<GridPayload>;

class Harness {
  readonly envs: Env[] = [];
  readonly emulator: VtEmulator;

  constructor(rows = 4, cols = 10) {
    this.emulator = new VtEmulator({
      sessionId: 'mode-edge',
      rows,
      cols,
      onEnvelope: (env) => this.envs.push(env),
    });
  }

  feed(s: string): void {
    this.emulator.feed(new TextEncoder().encode(s));
  }

  clearEnvs(): void {
    this.envs.length = 0;
  }
}

describe('mode-event-edge-cases — sequence_no monotonicity', () => {
  it('sequence_no strictly ascends across construction + feeds + resizes', () => {
    // Invariant: every envelope emitted by VtEmulator carries a
    // monotonically ascending `sequence_no`. GridMirror discards envelopes
    // whose seq is <= last-applied.
    const h = new Harness(4, 10);
    h.feed('abc');
    h.emulator.resize(6, 12);
    h.feed('def');
    h.feed('\x1b[?1049h');
    h.feed('ghi');
    let prev = 0;
    for (const env of h.envs) {
      expect(env.sequence_no).toBeGreaterThan(prev);
      prev = env.sequence_no;
    }
  });

  it('reset() keeps sequence_no monotonic across the reset boundary', () => {
    // Invariant: `reset()` (RIS) emits a fresh snapshot but preserves the
    // monotonic `sequence_no` counter. Mirrors are allowed to treat the
    // snapshot as re-seeding the grid; they rely on strict monotonicity
    // to reject out-of-order replays. Locking this prevents a regression
    // to the older, inconsistent (and stale-docstring'd) behaviour.
    const h = new Harness(3, 6);
    h.feed('abc');
    const lastBefore = h.envs[h.envs.length - 1]!.sequence_no;
    expect(lastBefore).toBeGreaterThan(1);
    h.emulator.reset();
    const lastAfter = h.envs[h.envs.length - 1]!;
    // Snapshot from reset() must still ascend past the last pre-reset env.
    expect(lastAfter.sequence_no).toBeGreaterThan(lastBefore);
    // Epoch is monotonic-per-process per the docstring on `private epoch`.
    expect(lastAfter.grid_epoch).toBe(1);
  });
});

describe('mode-event-edge-cases — resize_generation stamping', () => {
  it('resize_generation stamp advances per resize; all later envelopes carry the new stamp', () => {
    // Invariant: on resize() the engine bumps `resize_generation`. Every
    // envelope emitted AFTER the resize (until the next resize) must carry
    // the new value, including grid_delta / cursor_moved.
    const h = new Harness(4, 10);
    const initialRg = h.envs[0]!.resize_generation;
    h.emulator.resize(5, 12);
    const resizedRg = h.envs[h.envs.length - 1]!.resize_generation;
    expect(resizedRg).toBe(initialRg + 1);
    h.clearEnvs();
    h.feed('abc');
    // Subsequent feed envelopes must still be stamped with resizedRg.
    for (const env of h.envs) {
      expect(env.resize_generation).toBe(resizedRg);
    }
  });

  it('resize to same dims still emits a snapshot and bumps nothing', () => {
    // Invariant: a no-op resize (same dims) re-emits a snapshot per
    // contract, but `resize_generation` does NOT bump.
    const h = new Harness(4, 10);
    const rgBefore = h.envs[0]!.resize_generation;
    h.clearEnvs();
    h.emulator.resize(4, 10);
    const env = h.envs.find((e) => e.payload.kind === 'grid_snapshot');
    expect(env).toBeDefined();
    expect(env!.resize_generation).toBe(rgBefore);
  });
});

describe('mode-event-edge-cases — buffer_kind tagging', () => {
  it('mode_changed envelope carries the NEW buffer_kind, not the old one', () => {
    // Invariant: when the engine flips alt/main, the `buffer_kind` field
    // on the `mode_changed` envelope must reflect the post-flip state.
    // This is the key handoff cue for downstream routing.
    const h = new Harness(4, 10);
    h.feed('hello');
    h.clearEnvs();
    h.feed('\x1b[?1049h');
    const flip = h.envs.find((e) => e.payload.kind === 'mode_changed')!;
    expect(flip.buffer_kind).toBe('alt');
    const payload = flip.payload as ModeChangedPayload;
    expect(payload.state.alt_screen).toBe(true);
    // Confirm reverse flip also tags main.
    h.clearEnvs();
    h.feed('\x1b[?1049l');
    const flipBack = h.envs.find((e) => e.payload.kind === 'mode_changed')!;
    expect(flipBack.buffer_kind).toBe('main');
    const payloadBack = flipBack.payload as ModeChangedPayload;
    expect(payloadBack.state.alt_screen).toBe(false);
  });

  it('grid_delta following a mode flip is tagged with the NEW buffer_kind', () => {
    // Invariant: RFC 0001 — once `mode_changed { alt_screen: true }` is
    // emitted, subsequent `grid_delta` envelopes MUST be tagged `alt`.
    const h = new Harness(4, 10);
    h.clearEnvs();
    h.feed('\x1b[?1049h\x1b[1;1Hon-alt');
    let seenFlip = false;
    for (const env of h.envs) {
      if (env.payload.kind === 'mode_changed') {
        seenFlip = true;
        continue;
      }
      if (seenFlip && env.payload.kind === 'grid_delta') {
        expect(env.buffer_kind).toBe('alt');
      }
    }
    expect(seenFlip).toBe(true);
  });
});

describe('mode-event-edge-cases — idempotence', () => {
  it('back-to-back identical DECSET 1049h emits only one mode_changed', () => {
    // Invariant: `swapAlt` short-circuits when already on the target
    // buffer. Feeding the same DECSET twice must not emit two
    // mode_changed envelopes (otherwise mirrors would re-apply noise).
    const h = new Harness(4, 10);
    h.clearEnvs();
    h.feed('\x1b[?1049h');
    h.feed('\x1b[?1049h');
    const flips = h.envs.filter((e) => e.payload.kind === 'mode_changed');
    expect(flips.length).toBe(1);
  });

  it('back-to-back identical DECRESET 1049l (while on main) emits no mode_changed', () => {
    // Invariant: leaving alt when already on main is a no-op; the engine
    // must not emit a redundant mode_changed envelope.
    const h = new Harness(4, 10);
    h.clearEnvs();
    h.feed('\x1b[?1049l');
    const flips = h.envs.filter((e) => e.payload.kind === 'mode_changed');
    expect(flips.length).toBe(0);
  });
});

describe('mode-event-edge-cases — cursor_moved emission', () => {
  it('cursor-only CSI emits exactly one cursor_moved (no redundant grid_delta)', () => {
    // Invariant: when no cell changes but the cursor moved, the engine
    // emits a `cursor_moved` envelope and NOT a grid_delta with empty
    // row_deltas. This keeps wire traffic minimal.
    const h = new Harness(4, 10);
    h.clearEnvs();
    h.feed('\x1b[3;5H'); // cursor move only
    const kinds = h.envs.map((e) => e.payload.kind);
    expect(kinds).toContain('cursor_moved');
    expect(kinds).not.toContain('grid_delta');
  });

  it('CSI with no grid change and no cursor change emits nothing', () => {
    // Invariant: a CSI that causes no observable state change (e.g. CUP to
    // current position) should not emit any envelope — debug diagnostic
    // guard against useless wire chatter.
    const h = new Harness(4, 10);
    h.feed('\x1b[1;1H'); // cursor at (0,0)
    h.clearEnvs();
    h.feed('\x1b[1;1H'); // same position
    expect(h.envs.length).toBe(0);
  });
});

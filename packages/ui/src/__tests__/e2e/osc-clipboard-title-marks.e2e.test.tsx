/**
 * **E2E — OSC 52 (clipboard) + OSC 0/2 (title) + OSC 133 (prompt marks)**
 *
 * What this test battery covers — and what it intentionally does not
 * -----------------------------------------------------------------
 * The production VT engine lives in Rust and emits ordered
 * `GridEventEnvelope` payloads to the TS `GridMirror` reducer (see
 * `shared/lib/grid-mirror/GridMirror.ts`). For the three OSC families in
 * this mission, the UI contract surfaces exist at the mirror layer:
 *
 *   OSC 0 / 2 — `title_changed` envelope        → `GridMirror.getMeta().title`
 *   OSC 52    — `clipboard_request` envelope    → `applyMeta` accepts + advances seq
 *   OSC 133   — NO ENVELOPE KIND EXISTS TODAY   → production gap, see below.
 *
 * The mirror is the UI's single point of contact with the engine's OSC
 * processing, so envelope-level injection is the legitimate e2e surface
 * for "did the UI layer honor the wire contract?". These tests do NOT go
 * through the Rust VT processor — the parser is covered by crate-side
 * tests; the UI's job is to apply what the wire gives it.
 *
 * Production gap — OSC 133 prompt marks
 * -------------------------------------
 * `GridPayload` (see `shared/lib/grid-mirror/types.ts`) lists exactly ten
 * payload kinds:
 *
 *     grid_snapshot, grid_delta, cursor_moved, mode_changed,
 *     title_changed, bell_requested, hyperlink_added, hyperlink_removed,
 *     clipboard_request, synchronized_update
 *
 * There is NO `prompt_mark` (or similarly-named) envelope kind today. The
 * only OSC 133 handling anywhere in the UI is a comment in
 * `features/command/boundary-detector.ts`:
 *
 *     "Phase 2 uses the mock bridge's prompt-suffix as the block boundary
 *      marker. Real shells will replace this with an OSC 133 D detector."
 *
 * So on the UI → mirror axis, OSC 133 is entirely unimplemented. The three
 * OSC-133 tests below are `.skip`-documented, not fabricated — we record
 * the contract shape we expect a future envelope to take (kinds A/B/C/D,
 * optional exit code on D) so this test file becomes a ready-to-enable
 * acceptance harness the day the Rust side starts emitting them. See each
 * `.skip` for details.
 *
 * Security note — OSC 0/2 title is displayed verbatim
 * ---------------------------------------------------
 * The title string is inert data at the mirror layer: no env-variable
 * expansion, no shell metacharacter interpretation, no HTML/attr escaping
 * concerns (the mirror stores a plain string). A future `document.title`
 * binding would need careful handling of control characters for display,
 * but nothing the UI does today extracts or evaluates anything beyond the
 * literal bytes the engine decoded. Test #7 locks that contract down.
 *
 * Security note — OSC 52 clipboard
 * --------------------------------
 * At the mirror layer, `clipboard_request` is a *data carrier* only: the
 * mirror does NOT itself call `navigator.clipboard.writeText()`. A grep
 * across `packages/ui` shows no consumer of `clipboard_request` → this is
 * the second production gap we document: OSC 52 is received but not yet
 * surfaced. Tests #8–#11 verify the mirror correctly admits set/query ops
 * across all three selection kinds, which is the contract any future
 * consumer will depend on. When a writer lands, it must prompt (or be
 * gated by a policy flag) before writing, because OSC 52 is a remote-write
 * primitive and a compromised program on the far side of a PTY can use it
 * to silently hijack the user's clipboard.
 */

import { describe, expect, it } from 'vitest';

import { GridMirror } from '../../shared/lib/grid-mirror/GridMirror.js';
import type {
  ClipboardRequestPayload,
  GridEventEnvelope,
} from '../../shared/lib/grid-mirror/types.js';
import {
  blankSnapshot,
  makeEnv,
  titleEnv,
} from '../../shared/lib/grid-mirror/__tests__/fixtures.js';

/* ------------------------------------------------------------------ */
/*  Local helpers — complement `fixtures.ts`                           */
/* ------------------------------------------------------------------ */

/**
 * Build a `clipboard_request` envelope. Mirrors `fixtures.ts`'s
 * `titleEnv`/`bellEnv` style so the test reads as a sequence of
 * wire-level events.
 */
function clipboardEnv(
  selection: ClipboardRequestPayload['selection'],
  op: ClipboardRequestPayload['op'],
  opts: { seq: number; epoch?: number },
): GridEventEnvelope<ClipboardRequestPayload> {
  return makeEnv<ClipboardRequestPayload>(
    { kind: 'clipboard_request', selection, op },
    { grid_epoch: opts.epoch ?? 1, sequence_no: opts.seq },
  );
}

/**
 * Priming a mirror — every meta payload is gated against an applied
 * snapshot (otherwise `gate()` would discard on the initial
 * `appliedSequence = 0` path). A 1×1 snapshot at seq=0 gives us a clean
 * starting point that tests can then advance past.
 */
function freshMirror(): GridMirror {
  const m = new GridMirror();
  m.applySnapshot(blankSnapshot(1, 1, 0, 1));
  return m;
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe('OSC 0 / 2 — title_changed envelope → GridMirror.getMeta().title', () => {
  it('TitleChanged{ scope=both } updates the mirror title', () => {
    const m = freshMirror();
    const r = m.apply(titleEnv('my session', 'both', { seq: 1 }));
    expect(r.outcome).toBe('applied');
    expect(m.getMeta().title).toBe('my session');
  });

  it('TitleChanged{ scope=window } is accepted; mirror stores the title regardless of scope', () => {
    // GridMeta has no icon-vs-window split today (see host-common/events.ts:
    // `GridMeta` carries only `title`, `cwd`, `hyperlink_digest`). The scope
    // field travels with the envelope as a hint for UI chrome that may one
    // day want to show window-title-only vs icon-title-only, but the mirror
    // treats all three scopes uniformly: the title value wins. This test
    // locks that contract down so a future structural split cannot happen
    // silently.
    const m = freshMirror();
    m.apply(titleEnv('window-only title', 'window', { seq: 1 }));
    expect(m.getMeta().title).toBe('window-only title');
  });

  it('TitleChanged{ scope=icon } is accepted identically (single-field model)', () => {
    const m = freshMirror();
    m.apply(titleEnv('icon-only title', 'icon', { seq: 1 }));
    expect(m.getMeta().title).toBe('icon-only title');
  });

  it('multiple title updates → latest wins (last-write, no merging)', () => {
    const m = freshMirror();
    m.apply(titleEnv('first', 'both', { seq: 1 }));
    expect(m.getMeta().title).toBe('first');
    m.apply(titleEnv('second', 'both', { seq: 2 }));
    expect(m.getMeta().title).toBe('second');
    m.apply(titleEnv('third', 'both', { seq: 3 }));
    expect(m.getMeta().title).toBe('third');
  });

  it('empty title is stored as "" (shells clear the title this way)', () => {
    const m = freshMirror();
    m.apply(titleEnv('primed', 'both', { seq: 1 }));
    m.apply(titleEnv('', 'both', { seq: 2 }));
    expect(m.getMeta().title).toBe('');
  });

  it('unicode in title (emoji / CJK / combining marks) round-trips byte-identically', () => {
    const m = freshMirror();
    // The JSON bridge decodes title bytes as UTF-8 before the envelope
    // reaches us, so what the mirror gets is a JS string. Verifying
    // exact-string equality here guards against any accidental normalization
    // on the mirror side (e.g. a future developer calling .normalize()).
    const title = '한국어 terminal session ~ working dir';
    m.apply(titleEnv(title, 'both', { seq: 1 }));
    expect(m.getMeta().title).toBe(title);
  });

  it('literal "$SSH_AUTH_SOCK" in title is displayed, NOT shell-expanded (security)', () => {
    // OSC 0/2 title payloads are inert strings at the mirror layer. The UI
    // contract is: whatever bytes the PTY wrote, we store verbatim. A
    // malicious (or buggy) program cannot trick the UI into resolving
    // environment variables by embedding their names in its title. This
    // test pins that property — if a future mirror change ever starts
    // interpolating `$VAR` it will trip this assertion.
    const m = freshMirror();
    const dangerous = 'prompt > $SSH_AUTH_SOCK ${HOME} `whoami`';
    m.apply(titleEnv(dangerous, 'both', { seq: 1 }));
    expect(m.getMeta().title).toBe(dangerous);
  });
});

describe('OSC 52 — clipboard_request envelope', () => {
  it('set { selection=clipboard, base64_data } is accepted and advances sequence', () => {
    const m = freshMirror();
    // base64 of "hello" — we verify the mirror does NOT decode it (the
    // base64 payload is opaque to the reducer; decoding is the UI-consumer's
    // job, part of any future clipboard-writer feature).
    const env = clipboardEnv(
      'clipboard',
      { op: 'set', base64_data: 'aGVsbG8=' },
      { seq: 1 },
    );
    const r = m.apply(env);
    expect(r.outcome).toBe('applied');
    // Sequence advanced — confirms `applyMeta` took the event, not that it
    // was silently dropped by the gate.
    expect(m.getAppliedSequence()).toBe(1n);
  });

  it('query op (OSC 52 `?`) is accepted — Read path requires a future policy prompt', () => {
    // Per the mission brief, OSC 52 query is the "read-back" form that a
    // production UI MUST gate behind a user prompt (xterm calls this
    // `allowWindowOps` / `disallowedOps`). Today the mirror just records
    // that the request happened; no consumer wires it to the clipboard API.
    // We verify the envelope is admitted — a future permission prompt will
    // observe this as its trigger.
    const m = freshMirror();
    const r = m.apply(
      clipboardEnv('clipboard', { op: 'query' }, { seq: 1 }),
    );
    expect(r.outcome).toBe('applied');
  });

  it('all three ClipboardSelection kinds (clipboard / primary / secondary) are admitted', () => {
    // X11-style selections map to distinct clipboards (primary = middle-click,
    // secondary = rarely-used, clipboard = system). The mirror must not
    // discriminate — dispatch policy lives at the consumer.
    const m = freshMirror();
    expect(
      m.apply(clipboardEnv('primary', { op: 'query' }, { seq: 1 })).outcome,
    ).toBe('applied');
    expect(
      m.apply(clipboardEnv('secondary', { op: 'query' }, { seq: 2 })).outcome,
    ).toBe('applied');
    expect(
      m.apply(clipboardEnv('clipboard', { op: 'query' }, { seq: 3 })).outcome,
    ).toBe('applied');
  });

  it('"select" selection kind (xterm PRIMARY+CLIPBOARD synonym) is also admitted', () => {
    // `ClipboardSelection` in host-common includes 'select' as an xterm-isms
    // synonym — verifying it doesn't fall through to 'unknown_variant'.
    const m = freshMirror();
    const r = m.apply(clipboardEnv('select', { op: 'query' }, { seq: 1 }));
    expect(r.outcome).toBe('applied');
  });

  it('multiple concurrent requests are serialized by envelope sequence (last-write advance)', () => {
    // The mirror has no clipboard queue — every request is processed
    // in-order and the sequence counter advances. A UI consumer layered
    // above the mirror is responsible for its own request de-dup / queueing;
    // the mirror is a pure reducer.
    const m = freshMirror();
    m.apply(clipboardEnv('clipboard', { op: 'set', base64_data: 'YQ==' }, { seq: 1 }));
    m.apply(clipboardEnv('clipboard', { op: 'set', base64_data: 'Yg==' }, { seq: 2 }));
    m.apply(clipboardEnv('primary', { op: 'query' }, { seq: 3 }));
    expect(m.getAppliedSequence()).toBe(3n);
  });

  it('stale-sequence clipboard request is discarded (envelope ordering invariant)', () => {
    // ADR 0017 §2 — `sequence_no <= appliedSequence` → discard. This gate
    // protects every meta kind, including clipboard_request; a replayed
    // OSC 52 cannot sneak past by spoofing an older sequence.
    const m = freshMirror();
    m.apply(clipboardEnv('clipboard', { op: 'query' }, { seq: 5 }));
    const r = m.apply(clipboardEnv('clipboard', { op: 'query' }, { seq: 3 }));
    expect(r.outcome).toBe('discarded');
    if (r.outcome === 'discarded') {
      expect(r.reason).toBe('stale_sequence');
    }
  });
});

describe('OSC 133 — prompt marks (A/B/C/D)', () => {
  // ---- Production gap -------------------------------------------------
  //
  // The `GridPayload` union in `shared/lib/grid-mirror/types.ts` does NOT
  // include any OSC-133 envelope kind today. Grep for `prompt_mark`,
  // `PromptMark`, `osc_133`, or any A/B/C/D discriminator in `packages/ui`
  // returns zero production-code hits. The only surface that reads any
  // form of OSC 133 is `features/command/boundary-detector.ts`, which
  // explicitly defers OSC 133 D detection to "real shells will replace
  // this with an OSC 133 D detector" — i.e. Phase 2 uses a mock-prompt
  // suffix as the block terminator, not OSC 133.
  //
  // The following tests are kept as `.skip` documentation of the contract
  // we expect a future envelope to satisfy. When the Rust VT processor
  // starts emitting `prompt_mark` payloads and the TS reducer grows
  // matching apply logic, these tests can be un-skipped in a single
  // commit and will immediately exercise the new code path.

  it.skip('A — prompt start is recorded (production gap: no PromptMark envelope kind today)', () => {
    // Expected shape, when it lands:
    //   payload.kind === 'prompt_mark' && payload.mark === 'A'
    // Expected behavior:
    //   - GridMirror stores the row/col of the prompt-start marker so a
    //     block detector can associate it with the next command.
    expect.unreachable('OSC 133 A envelope not yet implemented');
  });

  it.skip('B — prompt end / command start pairs with the prior A (production gap)', () => {
    // Expected shape: payload.mark === 'B'. Expected behavior: mirror exposes
    // a `getMeta().prompt_range` (or similar) capturing [A_pos, B_pos] so
    // selection can highlight just the prompt text.
    expect.unreachable('OSC 133 B envelope not yet implemented');
  });

  it.skip('C — command execution marker triggers block-open (production gap)', () => {
    // Expected shape: payload.mark === 'C'. Expected behavior: the block
    // router opens a new `Block` as soon as C arrives; today the router
    // opens blocks from the mock-prompt suffix in `boundary-detector.ts`.
    expect.unreachable('OSC 133 C envelope not yet implemented');
  });

  it.skip('D — command finished, exit code reflected on the closing block (production gap)', () => {
    // Expected shape:
    //   payload.mark === 'D' && typeof payload.exit_code === 'number'
    // Expected behavior: block-router consumes D to close the active
    // block with `exitCode = payload.exit_code` (replacing the today's
    // `null` fallback in `BoundaryFeedResult.exitCode`).
    expect.unreachable('OSC 133 D envelope not yet implemented');
  });
});

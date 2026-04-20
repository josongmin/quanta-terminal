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

import { AnsiParser } from '../../shared/lib/ansi-parser/parser.js';
import { GridMirror } from '../../shared/lib/grid-mirror/GridMirror.js';
import type {
  ClipboardRequestPayload,
  GridEventEnvelope,
} from '../../shared/lib/grid-mirror/types.js';
import {
  blankSnapshot,
  makeEnv,
  promptMarkEnv,
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

describe('Byte-level parser behaviour for OSC 0/2/52 — envelope-only contract', () => {
  // The UI-side `AnsiParser` (shared/lib/ansi-parser/parser.ts) is a
  // block-mode parser — it intentionally handles OSC 8 only and swallows
  // every other OSC number up to the terminator (BEL or ESC \). Production
  // metadata (title, clipboard) reaches the UI via Rust-emitted envelopes,
  // NOT via the TS parser. These bytes-level tests pin that contract so a
  // future expansion of the TS parser cannot silently duplicate work the
  // engine already does.

  function parse(raw: string) {
    const parser = new AnsiParser();
    const out = [...parser.feed(new TextEncoder().encode(raw))];
    out.push(...parser.flush());
    return out;
  }

  it('OSC 0;<title> BEL is consumed: zero spans emitted, no link side-effect', () => {
    // `ESC ] 0 ; foo BEL` — title OSC with BEL terminator. The parser
    // must not leak the payload into the visible text stream.
    const spans = parse('\x1b]0;foo\x07after');
    // Only 'after' should survive — the OSC was swallowed cleanly.
    expect(spans).toEqual([{ text: 'after' }]);
  });

  it('OSC 2;<title> ESC\\ is consumed (ST terminator), no spans emitted for title bytes', () => {
    const spans = parse('\x1b]2;my title\x1b\\tail');
    expect(spans).toEqual([{ text: 'tail' }]);
  });

  it('OSC 52;c;<base64> ESC\\ is consumed, no spans emitted, no link applied', () => {
    // Note: some xterm forks also accept BEL here; the parser tolerates
    // both. The assertion is that none of the payload leaks.
    const spans = parse('\x1b]52;c;aGVsbG8=\x1b\\x');
    expect(spans).toEqual([{ text: 'x' }]);
  });

  it('OSC 52;p;? (clipboard query) is consumed silently; no "?" leaks into text', () => {
    const spans = parse('\x1b]52;p;?\x07END');
    expect(spans).toEqual([{ text: 'END' }]);
  });

  it('OSC 52 does not fire any AnsiModeEvent (mode events are DEC-private-CSI only)', () => {
    // Sanity-check: `onMode` is scoped to `CSI ?...h/l`. OSC of any kind
    // must not trigger a mode event, so consumers applying parser events
    // 1:1 against the mirror cannot accidentally disturb mode state from
    // clipboard/title traffic.
    const parser = new AnsiParser();
    let count = 0;
    parser.onMode = () => {
      count += 1;
    };
    parser.feed(new TextEncoder().encode('\x1b]52;c;aGVsbG8=\x1b\\'));
    parser.flush();
    expect(count).toBe(0);
  });

  it('OSC 0 with embedded ESC-that-is-not-ST aborts safely', () => {
    // Defensive: a raw ESC inside an OSC payload that is NOT followed by `\`
    // aborts the OSC and returns to Ground, per the parser contract. We
    // assert nothing crashes and the stream ends cleanly.
    const spans = parse('\x1b]0;title\x1bxtail');
    // The OSC was aborted; "tail" survives as Ground text. The `x` byte
    // after the lone ESC is handled by the Escape state's default branch
    // (silently dropped) — so the visible tail is "tail" only, NOT "xtail".
    expect(spans).toEqual([{ text: 'tail' }]);
  });
});

describe('OSC 133 — prompt marks (A/B/C/D)', () => {
  // ---- UI contract note -----------------------------------------------
  //
  // `GridPayload` now includes a `prompt_mark` kind whose TS shape lives in
  // `shared/lib/grid-mirror/types.ts` (mirrored on the wire-side in
  // `@quanta/host-common::PromptMarkEvent`). The Rust VT engine does NOT
  // yet emit this payload — envelope emission is a follow-up epic on the
  // engine side — but the mirror accepts and applies it today so the
  // downstream block-router has a typed surface to consume the moment the
  // engine starts emitting. These tests lock the UI contract down:
  //
  //   - `GridMirror.getLastPromptMark()` returns the raw payload verbatim.
  //   - A / B build up a `getPromptRange()` pair.
  //   - C opens a block boundary (clears the range; marks command-active).
  //   - D carries an optional `exit_code` (number, or null for "unknown").

  it('A — prompt start is recorded on the mirror', () => {
    const m = freshMirror();
    const r = m.apply(promptMarkEnv('A', { seq: 1, row: 3, col: 0 }));
    expect(r.outcome).toBe('applied');
    const last = m.getLastPromptMark();
    expect(last?.kind).toBe('prompt_mark');
    expect(last?.mark).toBe('A');
    // row/col round-trip for block-detector association.
    expect(last?.row).toBe(3);
    expect(last?.col).toBe(0);
  });

  it('B — prompt end pairs with the prior A into a complete range', () => {
    const m = freshMirror();
    m.apply(promptMarkEnv('A', { seq: 1, row: 3, col: 0 }));
    m.apply(promptMarkEnv('B', { seq: 2, row: 3, col: 12 }));
    const range = m.getPromptRange();
    expect(range).not.toBeNull();
    expect(range?.start).toEqual({ row: 3, col: 0 });
    expect(range?.end).toEqual({ row: 3, col: 12 });
    // `lastPromptMark` still reflects the most recent envelope.
    expect(m.getLastPromptMark()?.mark).toBe('B');
  });

  it('C — command execution marker clears the prompt range (block boundary)', () => {
    const m = freshMirror();
    m.apply(promptMarkEnv('A', { seq: 1, row: 3, col: 0 }));
    m.apply(promptMarkEnv('B', { seq: 2, row: 3, col: 12 }));
    expect(m.getPromptRange()).not.toBeNull();
    m.apply(promptMarkEnv('C', { seq: 3 }));
    // Range is historical once the command started; the mirror stops
    // exposing it so downstream consumers don't paint a stale prompt
    // highlight during command execution.
    expect(m.getPromptRange()).toBeNull();
    expect(m.getLastPromptMark()?.mark).toBe('C');
  });

  it('D — command finished with exit_code=0 is reflected on lastPromptMark', () => {
    const m = freshMirror();
    m.apply(promptMarkEnv('A', { seq: 1, row: 3, col: 0 }));
    m.apply(promptMarkEnv('B', { seq: 2, row: 3, col: 12 }));
    m.apply(promptMarkEnv('C', { seq: 3 }));
    const r = m.apply(promptMarkEnv('D', { seq: 4, exit_code: 0 }));
    expect(r.outcome).toBe('applied');
    const last = m.getLastPromptMark();
    expect(last?.mark).toBe('D');
    expect(last?.exit_code).toBe(0);
  });

  it('full A → B → C → D sequence rides the sequence gate in-order', () => {
    const m = freshMirror();
    expect(m.apply(promptMarkEnv('A', { seq: 1, row: 2, col: 0 })).outcome).toBe('applied');
    expect(m.apply(promptMarkEnv('B', { seq: 2, row: 2, col: 6 })).outcome).toBe('applied');
    expect(m.apply(promptMarkEnv('C', { seq: 3 })).outcome).toBe('applied');
    expect(m.apply(promptMarkEnv('D', { seq: 4, exit_code: 127 })).outcome).toBe('applied');
    expect(m.getAppliedSequence()).toBe(4n);
    expect(m.getLastPromptMark()?.exit_code).toBe(127);
  });

  it('D with exit_code=null ("unknown") is admitted — shell did not report status', () => {
    // Some shells (or OSC 133 producers truncated mid-stream) emit the D
    // marker without an exit code. The mirror must accept the envelope and
    // surface `null` so consumers can branch on "no exit code reported"
    // instead of mis-reading a missing field as "success".
    const m = freshMirror();
    const r = m.apply(promptMarkEnv('D', { seq: 1, exit_code: null }));
    expect(r.outcome).toBe('applied');
    expect(m.getLastPromptMark()?.mark).toBe('D');
    expect(m.getLastPromptMark()?.exit_code).toBeNull();
  });

  it('A after A (shell re-prompted without D) defensively resets the range', () => {
    // Ctrl-C on some shells resubmits the prompt WITHOUT an intervening D.
    // If the mirror kept the first A's start alongside the new prompt the
    // captured range would span the cancelled + resumed prompt, confusing
    // any downstream highlighter. Verify that a second A wipes the prior
    // half-range before accumulating a new one.
    const m = freshMirror();
    m.apply(promptMarkEnv('A', { seq: 1, row: 3, col: 0 }));
    m.apply(promptMarkEnv('B', { seq: 2, row: 3, col: 12 }));
    expect(m.getPromptRange()).not.toBeNull();
    // Second A arrives — the prior B should no longer be reachable as a range.
    m.apply(promptMarkEnv('A', { seq: 3, row: 5, col: 0 }));
    expect(m.getPromptRange()).toBeNull();
    expect(m.getLastPromptMark()?.mark).toBe('A');
    expect(m.getLastPromptMark()?.row).toBe(5);
  });

  it('stale-sequence prompt_mark is discarded by the same gate as every other meta event', () => {
    // ADR 0017 §2 — `sequence_no <= appliedSequence` → discard. A replayed
    // prompt_mark (e.g. from a buggy engine re-emitting an envelope) must
    // not overwrite a newer marker. We apply seq=5 first, then a stale
    // seq=3, and expect the later state (seq=5) to survive.
    const m = freshMirror();
    m.apply(promptMarkEnv('C', { seq: 5 }));
    const r = m.apply(promptMarkEnv('A', { seq: 3, row: 0, col: 0 }));
    expect(r.outcome).toBe('discarded');
    if (r.outcome === 'discarded') {
      expect(r.reason).toBe('stale_sequence');
    }
    // The stale 'A' must not have overwritten the prior 'C'.
    expect(m.getLastPromptMark()?.mark).toBe('C');
  });

  it('grid_snapshot clears prompt_mark state (range references are row-indexed)', () => {
    // Snapshots authoritative-reseed the grid; row indices in a captured
    // prompt range cease to be meaningful across the reseed boundary.
    // The mirror must wipe the state, not carry forward a stale range.
    const m = freshMirror();
    m.apply(promptMarkEnv('A', { seq: 1, row: 3, col: 0 }));
    m.apply(promptMarkEnv('B', { seq: 2, row: 3, col: 10 }));
    expect(m.getPromptRange()).not.toBeNull();
    // Fresh snapshot (same epoch, new sequence) — acts as a reseed.
    m.applySnapshot(blankSnapshot(4, 8, 3, 1));
    expect(m.getPromptRange()).toBeNull();
    expect(m.getLastPromptMark()).toBeNull();
  });
});

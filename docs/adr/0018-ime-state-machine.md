# ADR 0018 — IME State Machine

- **Status**: Proposed (skeleton — fleshed out during RFC 0001 Phase 3)
- **Date**: 2026-04-19
- **Related**: RFC 0001 §10 (IME state machine), RFC 0001 §13.6 (IME acceptance), prior session user feedback (Korean double-input bug)

## Context

IME (Input Method Editor) handling is a top-3 correctness risk for this project. The failure mode we already burned days on in prior sessions:

- User types Korean 한글 via macOS 2-set keyboard (두벌식).
- Composition happens: `ㅎ` → `하` → `한`.
- If intermediate bytes leak to the PTY, shell sees garbage (`ㅎㅏㄴ`).
- If we don't flush on commit, shell sees nothing.
- If focus-out mid-composition orphans the overlay, user types into thin air.

None of these degrade gracefully. The only way to ship this is **an explicit state machine with invariants and tests**.

## Decision

### 1. State machine

```
              compositionstart
    ┌────────────────────────────────────┐
    │                                    ▼
  Idle                               Composing
    ▲                                    │
    │                                    │ compositionend (commit)
    │                                    ▼
    │                               Committed ──────┐
    │                                               │
    │                                    OR         │
    │                                               │
    │                                    compositionend (empty)
    │                                    OR Esc / blur-cancel policy
    │                                               │
    │                                               ▼
    │                                          Cancelled
    │                                               │
    └───────────────────────────────────────────────┘
```

Three states: `Idle`, `Composing`, `Committed` (transient → Idle), `Cancelled` (transient → Idle).

### 2. Invariants

- **I-1**: PTY bytes emitted ONLY on `Composing → Committed` transition.
- **I-2**: `compositionupdate` updates ONLY the local preedit overlay. No PTY emission.
- **I-3**: Preedit text is **never** inserted into the semantic terminal grid. Preedit lives in a paint-layer overlay; grid is untouched.
- **I-4**: Commit inserts the finalized grapheme sequence through the normal input-encoder path. If DECSET 2004 (bracketed paste) is on, wrap with sentinels.
- **I-5**: Cancel (Esc while Composing) clears overlay without PTY emission.
- **I-6**: Blur during `Composing`: platform-dependent policy.
  - macOS: cancel composition (discard preedit, return to `Idle`).
  - Windows / Linux: preserve preedit for 1 second; if focus returns, resume; else cancel.
  - Partial bytes **NEVER** emitted.
- **I-7**: Intermediate `keydown` events during `Composing` are **fully suppressed** in the input handler. They do not reach `key_event`.

### 3. UI behavior

- Preedit overlay layer sits above the cursor, same z-index as selection highlight.
- Candidate-popup (IME's own floating window) is anchored to `cellToScreen(cursor)` + line-height offset.
- Resize during `Composing`: overlay repositioned. Composition state NOT flushed.
- Sidecar restart or reconnect during `Composing`: state machine forced to `Cancelled`, overlay cleared, banner "session restarted; re-enter text" shown. No partial bytes.

### 4. Test matrix

Per IME, all in CI (no manual testing):

- macOS Korean 2-set (두벌식)
- macOS Korean 3-set (세벌식-390)
- Japanese IME (hiragana + kanji conversion)
- Chinese pinyin IME

Scenarios per IME:

- [ ] Compose then commit in shell prompt.
- [ ] Compose then cancel (Esc) in shell prompt.
- [ ] Compose then blur (focus leaves window).
- [ ] Compose in `vim` insert mode.
- [ ] Compose in `tmux` pane.
- [ ] Compose during a long-running output (heavy PTY traffic during composition).
- [ ] Resize mid-composition.
- [ ] Sidecar restart mid-composition.

Dead-key composition (macOS Opt+e + e → é) tested independently — it is NOT CJK IME but uses the same browser composition API.

### 5. Telemetry

- Counter: composition starts.
- Counter: commits.
- Counter: cancels (via Esc).
- Counter: cancels (via blur).
- Counter: abnormal terminations (sidecar restart, orphan, etc.).
- Histogram: composition duration (ms from start to commit/cancel).

Abnormal-termination counter > 0 in dogfood = P1 investigation signal.

## Consequences

- The input-event path has an explicit "am I composing?" check. Minor complexity increase, major correctness dividend.
- Preedit is paint-layer only. The grid reducer never sees composition events — aligns with the SSOT boundary (RFC 0001 §3).
- Blur policy differs by platform; we pay that complexity in exchange for matching user expectations. Tested per platform.
- Sidecar restart during composition is a defined path, not an undefined crash.

## Open (to resolve during Phase 3 implementation)

- Dead-key composition (Opt+e) on macOS uses the browser composition API but feels instantaneous — should we fast-path it without the overlay? Decision deferred to first-run dogfood.
- Whether to show the preedit with an underline (Chrome convention) vs a highlighted box (native macOS convention). UX decision; ship with underline, re-evaluate.
- Candidate popup may extend beyond the terminal canvas bounds. Clip or overflow? Browser handles natively; no action needed unless tested-bad.

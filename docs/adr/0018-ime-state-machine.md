# ADR 0018 — IME State Machine

- **Status**: Accepted (v1 decisions locked)
- **Date**: 2026-04-19 (promoted from Proposed; updated during EPIC-E design-freeze)
- **Related**: RFC 0001 §10 (IME state machine authority), RFC 0001 §13.6 (IME acceptance), RFC 0001 §2 (invariants I-6 input-encoder-mandatory, I-7 preedit-never-enters-grid), RFC 0001 §13.14 (telemetry), ADR 0017 (reducer ordering + mode authority), EPIC-E Design (`docs/rfc/epics/epic-E-input-ime-design.md`) — §5 transition table, §6 PreeditOverlay, §9 recording format, §10 test plan. Prior session user feedback (Korean double-input bug).

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

Three explicit states (`Idle`, `Composing`, `Committed`, `Cancelled`); the latter two are transient and auto-return to `Idle`. `Composing` carries a `persisted` sub-flag used by the Linux/Windows blur-preservation path. **Full transition table with guards and side effects is in EPIC-E Design §5.3 (T1-T18) and is the source of truth for implementation.**

### 2. Invariants

- **I-1**: PTY bytes emitted ONLY on `Composing → Committed` transition (EPIC-E §5.3 T3).
- **I-2**: `compositionupdate` updates ONLY the local preedit overlay (EPIC-E §5.3 T2). No PTY emission.
- **I-3**: Preedit text is **never** inserted into the semantic terminal grid. Preedit lives in a paint-layer overlay; grid is untouched. Structurally enforced: `PreeditOverlay.tsx` does not import from `packages/ui/src/shared/lib/grid-mirror/**` — grep-enforced by repository `tools/check-*` (EPIC-E §6.5).
- **I-4**: Commit inserts the finalized grapheme sequence through the normal input-encoder path. If DECSET 2004 (bracketed paste) is on, the commit wraps with sentinels via `Paste.encode()` (EPIC-E §5.3 T3 side effect).
- **I-5**: Cancel (Esc while Composing) clears overlay without PTY emission; the Escape byte is ALSO suppressed (not forwarded to PTY) — T5.
- **I-6**: Blur during `Composing` is platform-dependent; partial bytes **NEVER** emitted. See §3 below.
- **I-7**: Intermediate `keydown` events during `Composing` are **fully suppressed** in the input handler. They do not reach `KeyEncoder.encode()` or the PTY bridge (T5/T6, plus `KeyEvent.isComposing === true` short-circuits the encoder per EPIC-E §3.1 step 2).

### 3. Blur policy per platform

- **DECISION**: macOS = cancel composition immediately (EPIC-E §5.3 T7). Linux + Windows = preserve preedit for **1000 ms** with `dimmed=true` overlay; cancel on timer expiry (T10); resume on `focus()` if the timer is still running (T9).
- **Rationale**: macOS native text input cancels preedit on focus loss by convention; any other behavior surprises macOS users. Linux (fcitx5, ibus) and Windows IME flows often involve a brief candidate-window focus transition that reads as `blur` to the browser — preserving for 1 s covers the common case without orphaning state for longer than user patience.
- **ESCAPE**: if Linux IME integration in dogfood reveals fcitx5 users consistently expect cancel-on-blur (the candidate popup focus theft case is browser-compensated on their setup), flip Linux to cancel. Preference hook reserved: `preferences.imeBlurPolicy: 'cancel' | 'preserve-1s'` — default continues to be `preserve-1s` on Linux/Windows and `cancel` on macOS. The hook exists specifically so a per-user override is possible without a code change.

### 4. Preedit visual style

- **DECISION**: single underline, monospace (inheriting the terminal font), inherits foreground color. No background fill. No independent caret — the terminal's own cursor from the `CursorState` stream (EPIC-C §1.4) shows position.
- **ESCAPE**: if the preedit text itself contains an underline glyph — for example an underlined URL inside composition — switch to a dotted underline via CSS `text-decoration-style: dotted`. Vanishingly rare in practice (no mainstream IME produces underlined glyphs during composition), so v1 ships with solid underline.

### 5. Candidate popup overflow

- **DECISION**: rely on browser-native clipping. No custom handling. Document that IME candidate popups near terminal-canvas edges may be cut off by the window chrome; this matches every other browser-embedded terminal.
- **ESCAPE**: if users report regularly lost candidates (telemetry counter `ime.candidate_popup_clip_reports` ≥ N/week from in-app feedback), add a `BoundingBoxObserver` that measures the overlay's rect and reflows the popup via `window.requestAnimationFrame` + the platform IME APIs where available (`document.activeElement.setCaretPos()` on supporting browsers).

### 6. Dead-key handling

- **DECISION**: the same state machine handles dead-key composition. macOS Opt+e triggers `compositionstart(" ")` (space as filler per macOS convention) immediately followed by `compositionupdate("´")`; the next key closes the composition with `compositionend("é")` (or `"ä"`, etc., depending on the base letter). Overlay is mounted for the short interval (typically < 200 ms end-to-end) — no fast-path bypass.
- **Rationale**: uniform path = fewer code branches = fewer bugs. The overlay mount/unmount cost at < 200 ms window is imperceptible even on low-end hardware.
- **ESCAPE**: if measured dead-key end-to-end latency exceeds 50 ms on M-series (P95 over dogfood week) AND users complain, add a fast-path branch that skips the overlay when the entire composition lifecycle is under a threshold (e.g., < 50 ms between start and end, and `data.length ≤ 2`). The fast-path would pre-commit bytes into a coalescing buffer and never mount React. This is a pure optimization; correctness does not depend on it.

### 7. UI layering

- **DECISION**: preedit overlay layer is **above** the cursor layer and **below** the selection-highlight layer. This is stricter than the original skeleton wording "same z as selection"; testing against layered renderers (EPIC-D §14.1 cursor overlay + selection overlay) showed that equal z with selection caused flicker when a selection was active during composition (rare but possible in chorded keyboard shortcuts). Above-cursor / below-selection gives a stable paint order.
- **Candidate-popup anchor**: DOM-native via focused element's caret position, with `cellToScreen(cursor) + lineHeight` used as the initial anchor (EPIC-E §6.2). Overlay resize during composition recomputes the anchor without resetting state (T16/T17).
- **Sidecar restart during composition**: state machine forced to `Cancelled` (T12), overlay unmounted, banner "session restarted; re-enter text" surfaced via the shell-layer notification system. No partial bytes.

### 8. Testing coverage expectations

Test plan in full at **EPIC-E Design §10**. Highlights:

- Per IME in the matrix, **≥ 4 recordings** under `packages/ui/src/features/input/fixtures/ime-recordings/`. Seed corpus (6 recordings) enumerated at EPIC-E §9.2; implementation agent expands to ≥ 4 per IME covering shell / vim-insert / tmux / cancel / blur / resize-mid-compose (= 18 minimum per Epic-E acceptance).
- `ImeStateMachine.test.ts` covers every row of the §5.3 transition table (≥ 20 cases including stray-event coverage).
- `blur-policy.test.ts` proves platform-dependent blur behavior (macOS cancel vs Linux/Windows preserve-1s).
- `sidecar-restart.test.ts` proves abnormal-termination path (T12/T13).
- `PreeditOverlay.test.tsx` proves paint-layer pure-view contract.
- `deadkey.test.ts` covers Opt+e+e, Opt+e+a, Opt+e+Escape.

Per IME in the matrix (macOS Korean 2-set, macOS Korean 3-set, macOS JP IME, CN pinyin): all in CI, no manual testing.

Scenarios per IME (all recorded):

- [ ] Compose then commit in shell prompt.
- [ ] Compose then cancel (Esc) in shell prompt.
- [ ] Compose then blur (focus leaves window) — platform-specific expectations.
- [ ] Compose in `vim` insert mode.
- [ ] Compose in `tmux` pane.
- [ ] Compose during a long-running output (heavy PTY traffic during composition).
- [ ] Resize mid-composition.
- [ ] Sidecar restart mid-composition.

Dead-key composition (macOS Opt+e + e → é) tested independently — it is NOT CJK IME but uses the same browser composition API and the same state machine per §6 above.

### 9. Telemetry

Counters and histograms — mirrors RFC 0001 §13.14 IME coverage. Metric names are stable; emission happens via `quanta-metrics` (the cross-cutting infra agent owns the crate).

| Metric | Type | Fires on |
|---|---|---|
| `ime.lifecycle_start` | counter | T1 (Idle → Composing) |
| `ime.lifecycle_commit` | counter | T3 (Composing → Committed, non-empty data) |
| `ime.lifecycle_cancel` | counter | T4 (empty-end), T5 (Esc), T7 (macOS blur), T10 (Linux/Win timeout). Labeled with `reason={empty_end, esc, blur, blur_timeout}`. |
| `ime.abnormal_termination` | counter | T12, T13 (sidecar disconnect during composition). **P1 signal — any non-zero count in dogfood is investigated.** |
| `ime.composition_duration_ms` | histogram | At T3 / T4 / T5 / T7 / T10 — records `now - compositionStartedAt`. |
| `ime.stray_end` | counter | T14 (compositionend without a start). Debug/diagnosis only. |
| `ime.stray_nested_start` | counter | T15 (nested compositionstart during Composing). Debug only. |
| `ime.stray_transition` | counter | Catch-all from the exhaustiveness guard in `transition()` (EPIC-E §5.5). Should always be zero. |

Abnormal-termination counter > 0 in dogfood = P1 investigation signal.

## Consequences

- The input-event path has an explicit "am I composing?" check (`KeyEvent.isComposing` — EPIC-E §3.1 step 2). Minor complexity increase, major correctness dividend.
- Preedit is paint-layer only. The grid reducer never sees composition events — aligns with the SSOT boundary (RFC 0001 §3, invariants I-3 / I-7).
- Blur policy differs by platform; we pay that complexity in exchange for matching user expectations. Tested per platform (EPIC-E §10.10).
- Sidecar restart during composition is a defined path (T12/T13), not an undefined crash.
- The 1000 ms Linux/Windows blur-preserve timer is cross-platform and not user-configurable in v1 (see Open below). Users on Linux with unusual IME setups can override via `preferences.imeBlurPolicy` if the ESCAPE path in §3 is activated.

## Open

Two items remain open; neither gates v1 ship:

1. **macOS "Opt" vs "Alt" terminology** in UI strings. The physical key has the legend "⌥/option" on Apple keyboards; some Linux/Windows crossover users call it "Alt". Current leaning: refer to it as "Option" in UI strings when running on macOS, "Alt" elsewhere, detected via `navigator.platform`. Revisit after first dogfood week with user feedback.
2. **Whether the 1000 ms Linux/Windows blur-preserve timer should be user-configurable.** Tentatively: **no**, to keep cross-platform behavior predictable. The `preferences.imeBlurPolicy` hook exists as an escape hatch (binary: `cancel` vs `preserve-1s`); the duration itself is a design constant. Revisit only if dogfood reveals 1 s is wrong for enough users to matter.

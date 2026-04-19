# RFC 0001 — Custom VT Engine + xterm Removal ("Warp-level Engine")

- **Status**: Proposed (v4, authority contracts + SSOT boundaries integrated)
- **Author**: Quanta Terminal Team
- **Date**: 2026-04-19
- **Related**: ADR 0001 (host modes), ADR 0002 (execution boundary contract), ADR 0010 (degraded-mode UI contract), ADR 0011 (event replay / reducer semantics), ADR 0014 (architecture invariants)
- **Spawns**: ADR 0015 (width / grapheme / line-break SSOT), ADR 0016 (selection / search / copy semantics), ADR 0017 (terminal mode + reducer ordering — new), ADR 0018 (IME state machine — new), RFC 0002 (WebGL/WebGPU renderer — follow-up), RFC 0003 (sixel / kitty graphics — follow-up)
- **Supersedes**: the implicit "xterm-as-TUI-fallback" architecture shipped in Phase 2

---

## 0. Purpose

1. Replace xterm with a single Rust VT engine.
2. Multi-language (CJK + emoji + IME) fully correct, not "best-effort."
3. vim / tmux / ssh integrity preserved across the transition.
4. Regression-detection infrastructure (golden replay + side-by-side diff + telemetry) in place before xterm is removed.

## 1. One-paragraph read

We replace `xterm.js` with a custom Rust VT engine that is the single source of truth for every cell on screen. Block UX becomes a *presentation layer* on top of that engine. **The real risk is not the renderer; it is input correctness + terminal semantics + width/grapheme.** Six authority contracts (§5-§9) govern who owns what. xterm stays alive in side-by-side co-existence mode until a hard all-true gate is satisfied (§18). xterm is removed *last*. Success turns on six axes: **width/grapheme, input encoding, IME, tmux, alt-screen, xterm-diff infrastructure.** Everything in this RFC serves one of those six.

## 2. Non-negotiable invariants

Hard rules. Violating any one is a design-level defect, not a bug. These are enforced by CI (grep rules + parity tests), not by review taste.

- **I-1 — Exactly one VT engine.** All PTY bytes pass through `quanta-vt`. Zero exceptions.
- **I-2 — UI does not parse ANSI.** No `\x1b` escape-sequence interpretation, no CSI/OSC/DCS handling anywhere in TS. CI greps for this.
- **I-3 — Grid is the truth.** Cells, widths, grapheme boundaries, cursor, wrap decisions, buffer membership — the engine decides. UI mirrors; UI never reinterprets.
- **I-4 — Semantic width wins, paint adapts.** Font metrics MAY affect pixel placement, but they MAY NOT override the engine's semantic cell width or grapheme segmentation.
- **I-5 — Delta from day one.** Full `GridSnapshot` only on connect / resume / resize / divergence-resync. Steady-state is `GridDelta`.
- **I-6 — Input encoder layer is non-optional.** Browser `KeyboardEvent` → encoder → bytes. Never browser → PTY directly.
- **I-7 — IME preedit never enters the grid.** Composition lives in an overlay until commit. Grid sees bytes only at `compositionend`.
- **I-8 — No black screen.** On any failure short of process exit, the user sees the last consistent frame + a banner explaining it.
- **I-9 — Ordered reducer stream.** Events apply strictly in (`grid_epoch`, `sequence_no`) order. Stale epochs fenced, not "best-effort applied."
- **I-10 — xterm is removed only after §19 gate is ALL-TRUE.**

## 3. Source-of-truth boundaries

The system has exactly four authority layers. Each owns what it owns; no layer may poach from another.

### 3.1 Terminal semantic truth — **owned by `quanta-vt::Grid`** (Rust)

Everything derived from interpreting PTY bytes:

- Cell contents (grapheme clusters).
- Cell widths and right-half-of-wide-char markers.
- Cursor position, visibility, shape, save/restore state.
- Scrollback membership and row-continuation metadata.
- Main/alt buffer state + transition ordering.
- Mode state (DEC private modes, SGR state, charset state).
- OSC-derived metadata (title, cwd, hyperlinks).

**Nothing outside the engine produces or mutates this.**

### 3.2 Protocol truth — **owned by the ordered event stream** (Rust → UI)

- `GridSnapshot`, `GridDelta`, `CursorMoved`, `ModeChanged`, `TitleChanged`, `BellRequested`, `HyperlinkAdded/Removed`, `ClipboardRequest`, `SynchronizedUpdate`.
- Carries `grid_epoch`, `sequence_no`, `buffer_kind`, `resize_generation` (§7 reducer contract).
- UI MAY cache / mirror this stream. UI MAY NOT re-derive terminal semantics from raw PTY bytes.

### 3.3 Interaction truth — **owned by shared contracts** (ADR-level, Rust/TS parity-tested)

- Selection anchoring, normalization, range semantics (§9 + ADR 0016).
- Copy output formatting (wrap-join rules, grapheme safety, trailing-half-cell strip).
- Search result ranges (logical text view, continuation-aware).
- Hit-testing (`screenToCell` / `cellToScreen`) and hyperlink resolution.

UI MAY execute these locally for latency. Behavior MUST match the shared contract exactly, verified by parity tests.

### 3.4 Paint truth — **owned by the renderer** (browser/runtime)

- Pixel placement, font rasterization, glyph kerning, atlas management, DPR handling, cursor blink timing, animation easing.

Paint MAY affect where pixels land. Paint MAY NOT change:

- semantic cell width
- grapheme segmentation
- wrap boundary
- any layer 1 or 2 state

If glyph metrics visually disagree with semantic width, **semantic width wins and paint adapts around it** (whitespace padding, kerning adjustments, fallback glyph scaling — never silent width correction).

### 3.5 Enforcement

- CI grep: no `\x1b` parsing outside `crates/quanta-vt/`. No DEC/CSI/OSC code point handling in TS.
- Rust↔TS parity suites for width/grapheme/wrap (ADR 0015) and selection/copy/search (ADR 0016).
- Protocol-layer tests fail a CI job if any TS consumer infers state that the engine didn't emit.

## 4. Motivation

### 4.1 Two state models, not two renderers

Today Quanta runs two rendering surfaces side-by-side: our block-oriented React surface and `xterm.js`. The structural cost is **two independent state models**. Our block parser stores per-line spans; xterm holds a full grid + cursor + DEC modes + OSC + charset + scrollback ring. Selection, copy, search, font metrics, IME, mouse reporting — every one is a bug farm as long as the two models disagree on what a cell is. Features don't fix it; collapsing to one model does.

### 4.2 The bar is "no seam"

Warp's promise isn't "blocks." It's "no seam" — `vim` doesn't feel like a different app. Alt-screen renders *inside* the same engine. Blocks are a spatial affordance around a unified grid.

### 4.3 Dependency risk

xterm.js v5 has shipped CJK width bugs, WebGL crashes, IME double-input bugs that cost us days. Every upstream release is risk we don't own.

### 4.4 What we are *not* solving for

ROI. Time-to-first-byte. Per stakeholder direction: architectural parity with Warp at any reasonable engineering cost.

## 5. Six axes that decide success

Each has killed comparable projects. Everything below exists to retire risk on one of these:

1. **Width / grapheme / CJK** — Korean `한` = 2 cells; ZWJ emoji = 2 cells across N code points; `é` = 1 or 2 code points. One wrong width → every column after misaligned. Catastrophic, not graceful.
2. **Input encoding** — kitty keyboard, `modifyOtherKeys`, DECCKM-dependent cursor keys, tmux re-encoding. Bad modifier = vim macros break silently.
3. **IME (Korean 2-set especially)** — `compositionupdate` must NOT leak to PTY; focus-out mid-composition must be safe.
4. **tmux** — terminal inside terminal; canary for whole-system correctness.
5. **Alt-screen** — DECSET 1049/47/1047/1048, cursor save/restore, scrollback disjointness. Block chrome swaps in lockstep with engine, not after.
6. **Dirty/diff protocol** — full snapshot per tick = CPU spikes; need row-damage + rect-damage + cursor-separate + metadata-separate events from day one.

**Engineering principle**: renderer correctness ≠ product correctness.

## 6. Difficulty, honest-rated

| Level | Means | Ours |
|---|---|---|
| L1 | "toy" | — |
| L2 | "usable" | — |
| L3 | "xterm replacement" — alt-screen, DEC modes, resize, wrap | v1 starts here |
| L4 | "vim/tmux fully correct" | **v1 acceptance bar** |
| L5 | "Warp-class" — block layer, zero seam, 60 fps | v1.1 |

L3 is where most from-scratch terminals ship and die. We commit to L4.

## 7. Architecture Overview

```
                ┌─────────────────────────────────────────────┐
                │               QUANTA ENGINE (Rust)           │
                │                                              │
   PTY bytes ──▶│  quanta-vt::Processor  (vte Perform impl)    │
                │      │                                       │
                │      ▼                                       │
                │  quanta-vt::Grid  ← scrollback, alt-screen,  │
                │      │               cursor, SGR, DEC modes, │
                │      │               OSC, WIDTH, charset     │
                │      │                                       │
                │      ▼                                       │
                │  Ordered event stream                        │
                │   (grid_epoch, sequence_no, buffer_kind,     │
                │    resize_generation)                        │
                │   - GridSnapshot / GridDelta                 │
                │   - CursorMoved / ModeChanged                │
                │   - TitleChanged / BellRequested / ...       │
                └──────────────────────────┬───────────────────┘
                                           │
                                           ▼
                     ┌─────────────────────────────────────────┐
                     │        QUANTA UI  (TypeScript)          │
                     │                                         │
                     │  vt-client::GridMirror                  │
                     │    - apply in (epoch, seq) order        │
                     │    - drop stale epoch                   │
                     │    - revision mismatch → ResyncRow      │
                     │      │                                  │
                     │      ▼                                  │
                     │  cell-renderer  (Canvas2D → WebGL)      │
                     │    - backend-agnostic contract          │
                     │      │                                  │
                     │      └──▶ BlockList wraps row ranges    │
                     │           as measured overlays          │
                     └─────────────────────────────────────────┘
```

---

# AUTHORITY CONTRACTS

Five contracts. Each is an acceptance gate in its own right, factored out because it touches multiple layers.

## 8. Width / grapheme / line-break authority (→ ADR 0015)

`quanta-vt-width` is the sole authority for:

- Grapheme segmentation
- Display width classification
- Wrap eligibility
- Continuation-row semantics

### 8.1 Policy

- [ ] Unicode version pinned + versioned in the crate. Bumps require parity-test re-run.
- [ ] East-Asian Ambiguous width is a per-session setting with documented default (macOS/Windows narrow; Linux with CJK locale wide).
- [ ] Variation selectors (VS15/VS16), ZWJ sequences, combining marks, emoji presentation — all covered by golden cases.
- [ ] Browser font fallback MAY change raster shape; MUST NOT change semantic width.
- [ ] When glyph metrics visually disagree with semantic width, **semantic width wins and paint adapts**. No silent UI-side width correction.

### 8.2 Acceptance

- [ ] Rust↔TS parity suite: grapheme segmentation, width classification, wrap boundary, continuation tagging.
- [ ] Resize/reflow suite: selection & search anchor stability across visual row changes.
- [ ] Ambiguous-width policy documented; does NOT vary implicitly by host OS/browser locale.

## 9. Reducer ordering + mode negotiation authority (→ ADR 0017)

All UI-visible terminal state derives from a single ordered reducer stream.

### 9.1 Event carries

Every engine-emitted event:

- `session_id`
- `grid_epoch: u64` — changes on reconnect, full snapshot reseed, buffer re-init.
- `sequence_no: u64` — strictly ascending within an epoch.
- `buffer_kind: Main | Alt`
- `resize_generation: u64` — increments on every resize that affects wrap/reflow.

### 9.2 Ordering invariants

- [ ] Events apply in `(grid_epoch, sequence_no)` lexicographic ascending order.
- [ ] Deltas with stale `grid_epoch` or `resize_generation` are DISCARDED, not "applied best-effort."
- [ ] `CursorMoved` / `ModeChanged` with `sequence_no` older than the latest applied are rejected.
- [ ] Alt-screen enter/exit `ModeChanged` is sequenced BEFORE the first cell-delta of the new buffer. Chrome transition begins only after `ModeChanged` arrives.

### 9.3 Recovery rules

- [ ] `ResyncRow` allowed only when `(grid_epoch, resize_generation)` match.
- [ ] If row-level recovery isn't possible, UI requests full `GridSnapshot`.
- [ ] Reconnect / resume fences ALL pre-reconnect events via a new `grid_epoch`.

### 9.4 Terminal mode authority

All negotiated input modes live in a single authoritative `TerminalModeState`:

- DECCKM (cursor key application mode)
- Bracketed paste (2004)
- Focus reporting (1004)
- Mouse tracking (1000/1002/1003) + SGR encoding (1006)
- `modifyOtherKeys` level (xterm)
- Kitty keyboard protocol level
- Alt-screen active
- Synchronized update (2026)

Rules:

- [ ] Input encoder reads a *snapshot* of `TerminalModeState` — never live-reads mid-encode.
- [ ] PTY-driven mode changes update `TerminalModeState` through the SAME reducer stream as visual state.
- [ ] No browser event handler infers mode independently.
- [ ] Mode reads for key encoding are sequence-consistent with the latest applied reducer state.

### 9.5 Acceptance

- [ ] Out-of-order delta application is a telemetry-counted protocol error.
- [ ] Repeated row resync beyond threshold triggers full-snapshot fallback.
- [ ] Snapshot-fallback storms are tracked as a P1 perf signal.
- [ ] Mode transitions logged + replayable.
- [ ] Negotiation conflicts under tmux/ssh covered by golden scenarios.

## 10. IME state machine authority (→ ADR 0018)

IME is modeled as an explicit state machine:

```
Idle ──▶ Composing ──▶ Committed ──▶ Idle
            │
            └──▶ Cancelled ──▶ Idle
```

### 10.1 Rules

- [ ] PTY bytes emitted ONLY on `Composing → Committed` transition.
- [ ] `compositionupdate` updates ONLY the local preedit overlay.
- [ ] **Preedit text is never inserted into the semantic terminal grid.** Overlay is a paint-layer concern; grid is untouched.
- [ ] Commit inserts finalized grapheme sequence through the normal input encoder path (bracketed paste if DECSET 2004 on).
- [ ] Cancel (Esc) clears overlay without PTY emission.
- [ ] Blur during composition: cancels OR safely preserves preedit per host-platform rule. Partial bytes NEVER emitted.

### 10.2 UI behavior

- [ ] Terminal cursor and IME preedit caret layering is explicitly defined (preedit sits above cursor, same z as selection).
- [ ] Candidate-popup anchoring uses terminal caret screen coordinates (`cellToScreen(cursor)` + line-height offset).
- [ ] Resize during composition repositions overlay without committing.
- [ ] Sidecar restart / reconnect during composition clears overlay + banner; no orphaned state.

### 10.3 Acceptance

- [ ] macOS Korean 2-set, Japanese IME, Chinese pinyin recorded separately.
- [ ] Composition in shell prompt, `vim` insert mode, `tmux` pane tested per IME.
- [ ] Dead-key / accent composition (e.g., macOS `Opt+e` + `e` → `é`) tested independently from CJK IME.

## 11. Selection / copy / search semantics (→ ADR 0016)

Elevated to authority contract. Warp-grade UX stands or falls on this.

### 11.1 Selection

- [ ] Single-click / double-click / triple-click semantics explicit (char / word / line).
- [ ] Selection anchors are cell-based, grapheme-safe, wide-char-half normalized.
- [ ] Selection across continuation rows normalized by shared rules.
- [ ] Rectangular selection: Alt/Opt+drag. Explicitly supported for v1.

### 11.2 Copy

- [ ] Preserves hard newlines (explicit `\n` rows).
- [ ] Rejoins soft-wrapped continuation rows (no inserted newline).
- [ ] Never emits trailing half-cell of a wide char.
- [ ] Never splits a grapheme cluster.
- [ ] Tab and trailing-space normalization policy explicit.

### 11.3 Search

- [ ] Operates on the logical text view defined by continuation-row rules (wrap-aware).
- [ ] Match-to-cell mapping stable after resize/reflow OR deterministically recomputed.
- [ ] Highlight ranges obey grapheme boundaries + wide-char normalization.

### 11.4 Security / protocol

- [ ] OSC 52 clipboard handling policy explicit (permission-gated per ADR 0016).
- [ ] Remote clipboard requests may be denied by policy; denials observable via telemetry.

## 12. Renderer backend contract

VT engine + UI mirror are **renderer-agnostic**. Canvas2D is the initial backend; WebGL/WebGPU are optional follow-up backends behind the same contract.

### 12.1 Contract

- [ ] Renderer consumes ONLY: mirrored cell state, damage metadata, cursor/overlay events.
- [ ] Renderer MAY NOT own semantic terminal state.
- [ ] Switching backends MUST NOT change selection/copy/search semantics.
- [ ] Backend selection is a configuration detail, not an architecture fork.

### 12.2 Acceptance

- [ ] A second backend stub (even a no-op / memory-only backend used in tests) exists to prove the contract boundary.
- [ ] Selection/copy/search parity tests pass regardless of active backend.

---

# ACCEPTANCE FRAMEWORK

Operational contract. Every subsection is an acceptance gate.

## 13. MUST — shipping without any of these is a defect

### 13.1 Engine SSOT

- [ ] Every PTY byte passes through exactly one Rust VT engine (`quanta-vt`).
- [ ] UI does NOT parse ANSI / CSI / OSC. Grep enforces.
- [ ] Source of truth for on-screen output is `Grid`. UI mirrors; does not reinterpret.

### 13.2 Cell / Grid model — multilingual core

Cell struct:

- [ ] Stores a grapheme cluster, not `char`.
- [ ] `width: CellWidth` (0 / 1 / 2).
- [ ] Right-half-of-wide-char marker.
- [ ] Combining-mark support.
- [ ] Zero-width handling (combining, VS15/VS16, ZWJ continuations).

Required cases (test set in §21):

- [ ] Korean: 가, 한, 테스트
- [ ] Japanese: あ, カ, 漢字
- [ ] Chinese: 汉字
- [ ] Emoji: 🙂 😂 👨‍👩‍👧‍👦
- [ ] ZWJ: 👩‍💻, 👨‍👩‍👧‍👦
- [ ] Combining: `e + U+0301` = `é`, one cell
- [ ] VS15/VS16 correct

Gate-fail modes: cursor drift, glyph corruption, wrap break, wrong-substring selection.

### 13.3 Line wrap / layout

- [ ] Width-aware wrapping (never split 2-cell char across rows).
- [ ] Reflow policy explicit (continuation rows reflow on resize; `\n`-terminated rows do not).
- [ ] Resize preserves wrap consistency.

### 13.4 Main / alt-screen

- [ ] Main / alt buffers are independent structures.
- [ ] Cursor save/restore on alt-screen enter/exit (1049 / 1047 / 1048).
- [ ] Scrollback lives on main only.
- [ ] Alt-screen `ModeChanged` arrives before the first alt-buffer cell delta.

Tests:

- [ ] `vim` enter/exit preserves prior output.
- [ ] `less` enter/exit restores cursor.
- [ ] `tmux` running `vim` — nested depth tracked.
- [ ] Resize mid-alt-screen preserves state.

### 13.5 Input encoding

- [ ] Key encoder layer exists — `KeyboardEvent` never reaches PTY directly.
- [ ] Modifiers: Ctrl / Alt / Opt / Meta / Cmd / Shift in all combos.
- [ ] Function keys F1-F24.
- [ ] Bracketed paste (DECSET 2004).
- [ ] Focus in/out (DECSET 1004).
- [ ] Mouse SGR 1006.
- [ ] `modifyOtherKeys=2` when negotiated.
- [ ] Kitty keyboard levels 1-3 when negotiated.

Gate-fail: vim keybind wrong, tmux prefix broken, paste corrupts.

### 13.6 IME (Korean mandatory)

Per §10 state machine. Acceptance:

- [ ] Korean 2-set double-input bug absent (recorded test).
- [ ] JP IME hiragana + kanji conversion clean.
- [ ] CN pinyin clean.
- [ ] Composition in `vim` insert + `tmux` pane + shell prompt all pass.
- [ ] Esc-cancel works.
- [ ] Blur during composition safe.

### 13.7 Dirty / delta protocol

- [ ] Row dirty tracking.
- [ ] Rect damage for scroll regions.
- [ ] `GridSnapshot` only on initial / resume / resize / revision-resync.
- [ ] `GridDelta` steady-state.
- [ ] `CursorMoved` / `ModeChanged` separate events.
- [ ] Row revisions on every `RowDelta`; mirror detects mismatch → `ResyncRow`.
- [ ] `(grid_epoch, sequence_no, resize_generation)` on every event.

### 13.8 Selection / copy

Per §11.

### 13.9 Compatibility matrix

- [ ] `vim` / `nvim` — normal, insert, `:split`, `:term`, `:%s`, visual, `"*p`, NerdTree, fzf.vim
- [ ] `less` — up/down/space/`/`/n/N/g/G/q
- [ ] `nano` — ^O, ^X
- [ ] `htop` / `btop` — color, mouse click, F-keys
- [ ] `top` — refresh, field toggle
- [ ] `tmux` — split, resize, status, copy-mode, mouse, `allow-passthrough on`
- [ ] **`vim` inside `tmux`** — distinct entry
- [ ] `ssh` localhost → all of the above
- [ ] `man` — less-based
- [ ] `ranger` / `mc`

### 13.10 Golden replay

- [ ] PTY byte streams recorded per compat entry.
- [ ] Engine replay → recorded grid snapshot match.
- [ ] Cursor + mode state compared.

### 13.11 Side-by-side diff

- [ ] `data-renderer="canvas"|"xterm"` dev flag.
- [ ] Both consume same PTY stream simultaneously.
- [ ] Harness diffs cells / cursor / mode / encoded input bytes.

### 13.12 Performance gate

- [ ] Keystroke → rendered cell p95 ≤ 16 ms on baseline (M-series macOS).
- [ ] `yes | head -10000` sustained 60 fps.
- [ ] Idle CPU < 0.1%.
- [ ] Memory ≤ 22 MB for 10k scrollback × 120 cols.
- [ ] Steady delta ≤ 200 KB/s on `cargo build`.

### 13.13 Performance budget decomposition

Steady-state frame budget decomposes into measurable stages:

- [ ] PTY parse/apply budget
- [ ] Reducer / apply-delta budget
- [ ] Layout / hit-test budget
- [ ] Raster budget
- [ ] Cursor / overlay budget
- [ ] Atlas miss recovery budget

Each stage individually measurable in telemetry. Full-snapshot-fallback cost measured separately from steady-state delta cost. Font-atlas rebuild + late-load invalidation benchmarked independently. Scroll-region-heavy / high-churn TUI workloads benchmarked separately from line-oriented shell output.

### 13.14 Telemetry

Observability for the wild.

- [ ] Counter: unknown CSI sequences (per session).
- [ ] Counter: unknown OSC codes (per session).
- [ ] Counter: width-mismatch detections (mirror vs engine).
- [ ] IME lifecycle traces: start / update-count / commit / cancel.
- [ ] Counter: full-redraw (snapshot) frequency — must trend to zero.
- [ ] Histogram: delta size distribution.
- [ ] Counter: out-of-order events dropped.
- [ ] Counter: row resync requests.
- [ ] Counter: full-snapshot fallbacks.
- [ ] Histogram: selection normalization corrections.
- [ ] Counter: IME overlay abnormal termination.
- [ ] Counter: mode-negotiation conflicts.
- [ ] Counter: backend renderer recovery events.

Metrics via `quanta-metrics` crate.

## 14. SHOULD — strong recommend, ship if schedule allows

### 14.1 Renderer

- [ ] Glyph atlas (shared offscreen, LRU).
- [ ] Damage-based redraw.
- [ ] Cursor in separate layer.
- [ ] IME overlay in own layer.

### 14.2 Debug tools

- [ ] Grid dump (`quanta-replay dump-grid <session>`).
- [ ] Cursor state dump.
- [ ] Last-N escape-sequence log per session.
- [ ] Mode flags dump.

### 14.3 Fuzz testing

- [ ] `cargo-fuzz` target on `VteProcessor`.
- [ ] Invariants: no panic, bounded memory, grid row count stable, cursor in range, revisions monotonic.

### 14.4 Resize stress

- [ ] 200 rapid cycles < 10 s.
- [ ] During alt-screen active.
- [ ] tmux pane resize propagation.

### 14.5 Host / platform matrix

- [ ] macOS, Linux, Windows behavior matrix maintained.
- [ ] Browser-specific IME/input quirks tracked per runtime version.
- [ ] Font fallback + candidate-popup anchoring differences documented per platform.

### 14.6 TERM / remote compatibility stance

- [ ] Supported `$TERM` identity declared for v1 (`xterm-256color`).
- [ ] Unsupported capabilities degrade predictably + observably.
- [ ] Remote mismatches between local semantics and remote terminfo expectations tracked + testable.

## 15. DEFER — out of scope for v1

- sixel / iTerm image protocol / kitty graphics (RFC 0003)
- bidi / RTL
- screen-reader a11y for alt-screen programs
- GPU renderer (WebGL / WebGPU) — RFC 0002
- scrollback persistence beyond event-log replay (ADR 0011 authoritative)
- custom `$TERM` / terminfo distribution

## 16. BAN — must not start the project this way

Each has sunk comparable projects.

1. **UI re-parses ANSI.** Two state models again. Hard fail.
2. **Block owns the output buffer.** Block is a view. If store holds rendered text, alt-screen + scrollback can't compose.
3. **Cell is `char`-based.** `한` doesn't fit. ZWJ emoji doesn't fit. Everything breaks the moment a non-Latin byte arrives.
4. **Full snapshot per tick.** "Optimize later" = 30% idle CPU shipped.
5. **Keyboard via browser text-input / `onChange`.** Loses IME, modifiers, function keys.
6. **tmux tested last.** tmux is the canary. Must appear in every cycle from Phase 4 onward.
7. **IME tested last / manually.** Korean 2-set needs golden recordings in CI, not "I typed 한글 and it looked fine."
8. **"Works on my laptop" as acceptance.** Acceptance = golden-replay green + side-by-side diff zero + dogfood ≥ 1 week clean (§19).
9. **Paint layer corrects semantic width.** Browser font metric is NOT authoritative. Semantic width wins.
10. **UI-local mode inference.** Input encoder only reads `TerminalModeState` snapshots; never guesses from past bytes.

---

# OPERATIONAL PLAN

## 17. Migration plan — 7 phases

Re-ordered per stakeholder guidance: width SSOT first, xterm removal last, renderer before input so input debugging has visual feedback.

### Phase 0 — Grid + Width + Cursor + Buffer foundations (~1.5w)
- ADR 0015 written + accepted.
- `crates/quanta-vt-width` with 500+ codepoint golden table, Rust↔TS parity.
- `crates/quanta-vt` skeleton: `Grid`, main/alt buffers, cursor state, charset state.
- **Exit**: width parity green; grid invariants under fuzz; `vte::Perform` stub compiles.

### Phase 1 — SGR + CSI + scrollback + resize + dirty tracking (~2w)
- Full SGR (16/256/truecolor/all attrs).
- Core CSI handling.
- Scrollback ring, alt-buffer swap (1049 / 47 / 1047 / 1048).
- Resize → reflow.
- Damage tracker + row revisions + `grid_epoch` / `sequence_no` / `resize_generation`.
- OSC 0/2/7/8/133 basic.
- ADR 0017 written.
- **Exit**: golden PTY streams from `cat`, `ls --color`, `vim --clean` reproduce grid within ±0 cells.

### Phase 2 — Canvas renderer + local selection + protocol (~2w)
- Protocol wire-format frozen; golden JSON snapshots.
- `CellBuffer` mirror with revision + epoch + resize_generation handling.
- `FontAtlas` grapheme-keyed LRU.
- Canvas2D renderer: dirty rows, cursor layer, IME overlay layer.
- ADR 0016 skeleton implemented: selection anchors + hit-test + wrap-joined copy.
- Renderer backend contract (§12) established; second stub backend exists in tests.
- **Exit**: fixed snapshot+delta stream renders pixel-perfect ±1 px; 60 fps on perf harness.

### Phase 3 — Input encoder + IME + mouse + paste + focus (~2w)
- `packages/ui/src/features/input/` with 3-mode keyboard encoder.
- ADR 0018 written; IME state machine implemented.
- SGR 1006 mouse encoding.
- Bracketed paste (2004), focus events (1004).
- Golden input matrix: 800+ `(mode × key × modifiers × layout)` cases + IME recordings (Korean 2-set / JP / CN).
- `TerminalModeState` snapshot-based encoder reads.
- **Exit**: input matrix green; Korean 2-set double-input reproducibly absent.

### Phase 4 — Compat matrix (~1.5w)
- Scripted scenarios per §13.9 MUST entry.
- `vim inside tmux` distinct.
- `ssh` loopback running the full matrix.
- Mismatches → `compat-gap/<program>.report`.
- Fuzz + resize-stress.
- **Exit**: every MUST green in scripted + 90-min interactive dogfood.

### Phase 5 — Block overlay + alt-screen UX + side-by-side diff (~1w)
- Block chrome re-anchored via `cellToScreen`.
- Alt-screen entry/exit chrome collapse (160ms fade, configurable).
- `data-renderer="canvas"|"xterm"` flag lands; side-by-side harness diffs zero divergence.
- Crash mode: `kill -9 quanta-core` → read-only last snapshot + banner. Never black screen.
- Degraded-mode contract (§20) implemented.
- **Exit**: side-by-side diff zero across compat matrix.

### Phase 6 — xterm removal (~3d)
Gated hard on §19 ALL-TRUE.
- Flip renderer default to canvas.
- Delete `packages/ui/src/widgets/terminal-shell/`.
- Remove `@xterm/*` deps.
- Remove `tuiActive`/`needsAltScreen`/`altScreenVisible` branching.
- Update ADR 0001, `docs/terminal-benchmark-matrix.md`.
- **Exit**: `grep -ri "xterm" packages/` zero source hits.

### Parallel wall-clock

Sequential: 0 → 1 → (2 ‖ 3) → 4 → 5 → 6.

Tracks: A(width 1.5w) / B(VT engine 2w, dep A) / C(protocol+renderer 2w, dep B contract) / D(input+IME 2w, parallel C after contract freeze) / E(compat 1.5w, dep B+C+D) / F(block+side-by-side 1w) / G(removal 3d).

**Total parallel ≈ 7-8 weeks + 2 weeks contingency.**

## 18. Testing strategy

- **Unit** ≥ 95% line coverage on `quanta-vt`.
- **Fuzz** — panic-free, bounded memory, invariants hold.
- **Width parity** — golden table, Rust & TS.
- **Input matrix** — 800+ recorded including IME.
- **Golden PTY streams** — per compat entry.
- **Cross-renderer equivalence** — Phase 5 side-by-side.
- **Perf harness** — keystroke latency + frame cadence + memory per PR.
- **Divergence fault injection** — drop/reorder deltas → mirror resync.
- **Crash fault injection** — `kill -9` → read-only last snapshot + banner.
- **Resize stress** — 200 cycles, during alt-screen, tmux pane.
- **Epoch-drift fault injection** — feed stale-epoch deltas → UI discards + requests snapshot.
- **Mode-state fault injection** — inject conflicting mode change mid-encode; assert encoder uses snapshot, not live read.

## 19. Final xterm-removal gate

All TRUE is the ONLY condition under which xterm is deleted.

- [ ] Golden replay 100% pass.
- [ ] xterm vs canvas diff = 0 across matrix.
- [ ] IME real-usage clean (Korean, Japanese, Chinese).
- [ ] CJK + emoji width correct (ZWJ, VS16 included).
- [ ] `vim` OK.
- [ ] `tmux` OK.
- [ ] `vim` inside `tmux` OK.
- [ ] `ssh` remote OK.
- [ ] Alt-screen enter/exit/nested OK.
- [ ] Resize during alt-screen OK.
- [ ] Performance gate green.
- [ ] Performance budget decomposition green per-stage.
- [ ] Telemetry healthy (no unknown-CSI storm, full-redraw frequency trending to zero, no epoch-drift storm).
- [ ] ≥ 1 week internal dogfood clean.

Any single FALSE = no removal. Canvas renderer stays experimental-flag; xterm stays default.

## 20. Degraded mode contract

If engine sidecar or renderer fails:

- [ ] Last consistent snapshot remains visible in **read-only** form.
- [ ] User sees clear degraded-state banner.
- [ ] Input is either disabled OR explicitly redirected only after capability check.
- [ ] Session identity + scrollback authority remain intact.
- [ ] Recovery path (restart / reconnect / resnapshot) is observable + logged.

Non-goals in degraded mode:

- No speculative local ANSI parsing.
- No silent fallback to an alternate semantic model.
- **No black-screen failure.**

Rollback plan: if Phase 5 exits with > 2 unrecoverable MUST-bucket compat gaps, canvas stays `experimental.renderer = 'canvas'` setting; xterm stays default; Phase 6 deferred. `quanta-vt` continues as debug/replay/scripting surface regardless.

## 21. Multilingual focused test set

Committed fixtures. Run in golden replay, input matrix, side-by-side.

### 21.1 String corpus

**Korean**
- 한글 테스트입니다
- 가나다라마바사
- 안녕하세요 세계

**Japanese**
- こんにちは
- カタカナ
- 漢字テスト

**Chinese**
- 你好世界
- 汉字测试

**Emoji**
- 🙂 😂 🤔 🚀
- 👨‍👩‍👧‍👦 👩‍💻 🧑‍🚀

**Combining / variations**
- `é` (`e` + `U+0301`)
- `â` `ö`
- `1️⃣` (1 + VS16 + combining enclosing keycap)
- `❤️` (❤ + VS16)

### 21.2 Scenario matrix

Per string:

- [ ] Type via IME → cursor advances by correct cell count.
- [ ] Backspace → deletes whole grapheme, not partial code points.
- [ ] Selection anchors honor wide-char halves.
- [ ] Copy round-trips (paste back = identical bytes).
- [ ] Wrap at row end → no split glyph; continuation tagged.
- [ ] Resize → reflow correct.
- [ ] `vim` insert mode identical to terminal.
- [ ] `tmux` inside `vim` identical.

## 22. Where we die — 20 concrete failure modes

Each has an owning phase + test. Missing test = phase does not exit.

1. Korean 2-set IME double-input on `vim :%s` — Phase 3 recorded.
2. `Ctrl+Shift+A` ≡ `Ctrl+A` legacy encoding — Phase 3 matrix.
3. `fzf` `Alt+Enter` kitty-level change — Phase 3 matrix.
4. tmux prefix `Ctrl+b` vs `modifyOtherKeys` — Phase 3+4 scripted.
5. `한` = 1 cell → column misalignment — Phase 0 width.
6. `👨‍👩‍👧‍👦` = 8 cells → wrong substring copy — Phase 0 width + Phase 2 selection.
7. VS16 flipping width mid-stream — Phase 0 override table.
8. 1049 enter races first alt-frame → unformatted flash — Phase 5 ordering.
9. `vim` `ZZ` cursor wrong post-exit — Phase 1 cursor save/restore.
10. `tmux` resize SIGWINCH not sent — Phase 1 resize test.
11. `less` `q` → broken scrollback — Phase 1 alt-buffer disjointness.
12. `htop` SGR `;` vs `:` — Phase 3 mouse encoding.
13. Bracketed paste leaks into vim insert — Phase 3.
14. `emacs -nw` echoes wrong `modifyOtherKeys` level — Phase 3 negotiation.
15. `ssh` slow link > 100ms keystroke — perf harness with delay.
16. `GridDelta` out-of-order → resync storm — Phase 2 fault-inject.
17. Engine crash mid-alt-screen → black screen — §20 degraded mode.
18. Sidecar restart mid-composition → orphan IME overlay — Phase 3 IME lifecycle.
19. Web font late load → atlas invalidates mid-frame → flash — Phase 2 font load test.
20. Selection across wrapped row → copy joined-wrong → paste wrong text — ADR 0016 normalization.

## 23. Six-axis summary

Success / failure turns on:

1. **Width / grapheme** — correct?
2. **Input encoding** — correct?
3. **IME** — doesn't break?
4. **tmux** — doesn't break?
5. **Alt-screen** — perfect?
6. **xterm-diff infrastructure** — in place + zeroed?

Every phase, test, gate above serves one of these six.

---

**Next step**: sign-off on §2 (invariants) + §3 (SSOT boundaries) + §8-§12 (authority contracts) + §19 (removal gate) freezes the contract and authorizes Phase 0 kickoff.

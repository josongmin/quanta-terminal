# RFC 0001 — Epic Plan

Companion to [RFC 0001](./0001-custom-vt-engine-xterm-removal.md). Breaks the work into 11 epics with explicit dependencies, acceptance gates mapped to RFC sections, and parallel-execution strategy.

- **Status**: Proposed (companion to RFC 0001 v4)
- **Date**: 2026-04-19

---

## 0. Epic map

11 epics. 7 implementation + 2 cross-cutting + 2 cleanup/removal.

| Epic | Title | Phase | Duration | Blocks on | Freezes contract |
|------|-------|-------|----------|-----------|------------------|
| **A** | Width / Grapheme SSOT | 0 | 1.5w | — | ADR 0015 + `CellWidth`/`Grapheme` API |
| **B** | VT Engine Core | 1 | 2w | A | ADR 0017 event envelope, grid-invariant API |
| **C** | Protocol + Reducer + UI Mirror | 1→2 | 2w | B (contract) | Wire protocol (§7.4), golden JSON schemas |
| **D** | Canvas Renderer + Selection | 2 | 2w | C (protocol) | ADR 0016, renderer backend contract (§12) |
| **E** | Input Encoder + IME | 3 | 2w | C (mode state) | ADR 0018, input matrix golden format |
| **F** | Session Integration + Actor Wiring | 3 | 1.5w | B, C | — |
| **G** | Compat Matrix + Golden Streams | 4 | 1.5w | B+C+D+E | golden-stream format, `compat-gap/` report schema |
| **H** | Block Overlay + Alt-screen UX + Side-by-side | 5 | 1w | D, E, F, G | — |
| **I** | xterm Removal + Cleanup | 6 | 3d | §19 gate ALL-TRUE | — |
| **J** | Telemetry + Perf Harness (cross-cutting) | 0→5 | rolling | spec-ready | metric schema, perf-harness fixtures |
| **K** | CI + Platform Matrix + Golden Infra (cross-cutting) | 0→6 | rolling | spec-ready | CI job shapes, fixture-corpus layout |

**Total parallel wall-clock**: ~7-8 weeks + 2 weeks contingency. Sequential would be ~12 weeks.

## 1. Dependency graph

```
              ┌─────┐
              │  A  │  Width SSOT (Phase 0)
              └──┬──┘
                 │ freezes CellWidth / Grapheme API
                 ▼
              ┌─────┐
              │  B  │  VT Engine Core (Phase 1)
              └──┬──┘
                 │ freezes event envelope + grid API
                 │
       ┌─────────┼──────────┐
       ▼         ▼          ▼
    ┌─────┐  ┌─────┐    ┌─────┐
    │  C  │  │  F  │    │  J  │ telemetry
    └──┬──┘  └──┬──┘    └──┬──┘ (cross-cut)
       │        │          │
       │ freezes protocol
       ▼
    ┌─────┐  ┌─────┐
    │  D  │  │  E  │    ┌─────┐
    └──┬──┘  └──┬──┘    │  K  │ CI/platform
       │        │       └──┬──┘ (cross-cut)
       └───┬────┘          │
           ▼                │
        ┌─────┐             │
        │  G  │ Compat      │
        └──┬──┘             │
           ▼                │
        ┌─────┐             │
        │  H  │ Block+SxS   │
        └──┬──┘             │
           ▼                │
        ┌─────┐             │
        │  I  │ xterm cut ◀─┘
        └─────┘
```

## 2. Contract freeze milestones

Contracts that, once frozen, unblock the next wave of parallel work:

1. **After A ships** (end of Phase 0): `CellWidth`, `Grapheme`, wrap-eligibility API frozen. Unblocks B.
2. **After B spec-freezes** (~Phase 1 week 1): `EventEnvelope`, `Grid` public API, `TerminalModeState` shape frozen. Unblocks C, F, and E (mode-state read contract).
3. **After C spec-freezes** (~Phase 1-2 boundary): Wire protocol + golden JSON schemas frozen. Unblocks D.
4. **After E spec-freezes** (~Phase 3 week 1): Input matrix golden format frozen. Unblocks G's scripted input scenarios.
5. **After D+E+F all ship**: Unblocks G compat matrix.
6. **After H ships**: §19 gate checklist evaluated; if ALL-TRUE, unblocks I.

## 3. Parallel execution strategy

Three gears, running simultaneously once dependencies allow:

### Gear 1 — Implementation trunk (strictly sequential by dependency)
A → B → (C ‖ F) → (D ‖ E) → G → H → I

### Gear 2 — Cross-cutting (rolling, starts immediately)
- **J (telemetry)**: metric schema from day 1; instrumentation lands with each implementation epic as hooks become available.
- **K (CI/platform)**: CI job stubs from day 1; fixture-corpus layout; platform-matrix runners configured before Phase 4.

### Gear 3 — Design-ahead (spec writing parallel to upstream implementation)
Once an epic's dependency is in motion (not finished), the downstream epic's spec agent can begin:
- Detailed file/module layout.
- Test case enumeration.
- Contract draft to converge with upstream.
- Failure-mode test designs.

Design-ahead is safe because it produces documents, not code that could collide.

---

# EPIC DETAILS

Each epic below has the same shape:
- **Goal** — one sentence.
- **Phase** / **Duration** / **Dependencies**.
- **Scope** — files, modules, what's in / out.
- **Contracts frozen** — what locks after this epic.
- **Acceptance** — checklist mapped to RFC §13 subsections.
- **Failure modes retired** — mapped to RFC §22 20-point list.
- **Test deliverables**.
- **Exit gate** — the "done" definition.
- **Rollback** — what happens if this epic is blocked.

---

## Epic A — Width / Grapheme SSOT

**Goal**: Establish the sole authority for grapheme segmentation, cell width, and wrap eligibility. Rust + TS parity.

**Phase**: 0 · **Duration**: 1.5 weeks · **Dependencies**: none

### Scope

**Files (new)**:
- `crates/quanta-vt-width/Cargo.toml`
- `crates/quanta-vt-width/src/lib.rs`
- `crates/quanta-vt-width/src/domain/mod.rs` — `CellWidth { Zero, One, Two }`, `Grapheme(SmallString)`, `AmbiguousWidthPolicy`, `WrapEligibility`
- `crates/quanta-vt-width/src/adapters/default.rs` — wraps `unicode-segmentation` + `unicode-width`
- `crates/quanta-vt-width/src/overrides.rs` — curated override table (VS15/VS16, emoji ZWJ, regional indicators, ambiguous-width exceptions)
- `crates/quanta-vt-width/tests/width_corpus.txt` — 500+ codepoint golden table
- `crates/quanta-vt-width/tests/grapheme_corpus.txt` — ZWJ sequences, VS modifiers, combining marks
- `crates/quanta-vt-width/tests/wrap_corpus.txt` — wrap boundary decisions
- `packages/ui/src/shared/lib/width/` (new) — TS mirror
- `packages/ui/src/shared/lib/width/__tests__/parity.test.ts` — feeds Rust golden corpus through TS port; assert identical results

**Files (updated)**:
- `Cargo.toml` — add `quanta-vt-width` workspace member
- `docs/adr/0015-width-grapheme-line-break-ssot.md` — move from skeleton to accepted

**Out of scope**: VT engine, rendering, input. Pure library.

### Contracts frozen

- `CellWidth` enum + all transitions.
- `Grapheme` storage semantics (SmallString ≤ 8 bytes inline).
- `AmbiguousWidthPolicy { Narrow, Wide, Auto }` + auto-detection rules.
- `wrap_eligible(prev: Grapheme, next: Grapheme) -> WrapEligibility` API.
- Golden corpus format (line per entry, UTF-8 text + tab + expected width + tab + notes).

### Acceptance (maps to RFC §13.2, §8)

- [ ] `unicode-segmentation` + `unicode-width` versions pinned in Cargo.toml.
- [ ] Curated override table covers ≥ 30 entries (VS15/16, ZWJ patterns, at least 5 ambiguous-width corners).
- [ ] AmbiguousWidthPolicy::Auto resolves: macOS narrow, Windows narrow, Linux+CJK LANG wide.
- [ ] Corpus ≥ 500 codepoints: ASCII, Latin-1 extensions, CJK common, emoji + ZWJ, combining marks, VS15/VS16 pairs, DEC line-drawing.
- [ ] Rust test: corpus parity green.
- [ ] TS test: same corpus via port, parity green.
- [ ] Wrap-eligibility tests: 2-cell char at col 79 in 80-col grid forces wrap; 1-cell + 1-cell fits.
- [ ] `#[derive(Debug, Clone, Copy, PartialEq, Eq)]` on all public types, `#[must_use]` where appropriate.
- [ ] No `panic!` / `unwrap` in library code — all fallible paths return `Result`.

### Failure modes retired

- RFC §22 #5 (`한` = 1 cell → misalignment)
- RFC §22 #6 (ZWJ emoji = N cells → wrong substring)
- RFC §22 #7 (VS16 flip mid-stream)

### Test deliverables

- `width_corpus.txt` (500+ entries, reviewed).
- `grapheme_corpus.txt` (100+ ZWJ/combining/VS entries).
- `wrap_corpus.txt` (200+ wrap boundary cases).
- Rust parity test.
- TS parity test.
- Fuzz target: random UTF-8 bytes → segment → no panic, total width in bounds.

### Exit gate

- [ ] All ACR items checked.
- [ ] `cargo test -p quanta-vt-width` green.
- [ ] `pnpm -r --filter ui test` covering width parity green.
- [ ] ADR 0015 status → Accepted.

### Rollback

If auto ambiguous-width detection turns out wrong for a platform, user can override via Settings (§Settings panel already ships). No architectural rollback required.

---

## Epic B — VT Engine Core

**Goal**: Rust VT engine — grid, cursor, SGR, charset, DEC modes, OSC, scrollback, alt buffer, damage tracking, row revisions.

**Phase**: 1 · **Duration**: 2 weeks · **Dependencies**: A (width SSOT)

### Scope

**Files (new)**:
- `crates/quanta-vt/Cargo.toml`
- `crates/quanta-vt/src/lib.rs`
- `crates/quanta-vt/src/domain/cell.rs` — `Cell { grapheme, width, fg, bg, attrs, hyperlink_id }`
- `crates/quanta-vt/src/domain/grid.rs` — `Grid`, main/alt buffers, scrollback ring, `row_revisions: Vec<u64>`
- `crates/quanta-vt/src/domain/cursor.rs` — position, style, visibility, save/restore
- `crates/quanta-vt/src/domain/sgr.rs` — current SGR state, reset via CSI 0 m
- `crates/quanta-vt/src/domain/charset.rs` — G0-G3, SS2/SS3, DEC line drawing
- `crates/quanta-vt/src/domain/modes.rs` — `Modes` bitfield over DEC private modes
- `crates/quanta-vt/src/domain/color.rs` — `Color { Palette8, Palette256, TrueColor, Default }`
- `crates/quanta-vt/src/domain/mode_state.rs` — `TerminalModeState` (ADR 0017 §4)
- `crates/quanta-vt/src/ports/event.rs` — `TerminalEvent`, `EventEnvelope` (ADR 0017 §1)
- `crates/quanta-vt/src/ports/input.rs` — `TerminalInput` trait (used by Epic E)
- `crates/quanta-vt/src/adapters/vte_processor.rs` — implements `vte::Perform`
- `crates/quanta-vt/src/adapters/grid_renderer.rs` — diff computation
- `crates/quanta-vt/src/adapters/damage_tracker.rs` — per-row dirty flags
- `crates/quanta-vt/tests/unit/` — per-Perform, per-DECSET, per-OSC tests
- `crates/quanta-vt/tests/grid_invariants.rs` — invariant properties
- `crates/quanta-vt/fuzz/fuzz_targets/vte_process.rs` — cargo-fuzz target

**Files (updated)**:
- `Cargo.toml` — add `quanta-vt` member.

**Out of scope**: protocol events over the wire (that's Epic C). PTY bytes in → events out; no I/O.

### Contracts frozen

- `EventEnvelope<P> { session_id, grid_epoch, sequence_no, buffer_kind, resize_generation, payload }` — exact shape.
- `TerminalEvent` enum variants (CellsChanged, CursorMoved, ModeChanged, BellRequested, TitleChanged, CwdChanged, HyperlinkOpened/Closed, ClipboardRequest, OscPassthrough, ClearScrollback, Resize, SynchronizedUpdate).
- `Grid::feed(&mut self, bytes: &[u8]) -> Vec<TerminalEvent>` — primary entry point.
- `TerminalModeState` snapshot shape (used by Epic E).

### Acceptance (maps to RFC §13.1, §13.2, §13.3, §13.4, §13.7, §9 reducer ordering)

**Engine SSOT (§13.1)**:
- [ ] `Grid::feed` is the only entry point for PTY bytes.
- [ ] No I/O inside the crate (no file, no socket, no stdout).

**Cell / grid (§13.2)**:
- [ ] `Cell` stores `Grapheme`, `CellWidth`, attrs, color, hyperlink_id.
- [ ] Right-half-of-wide-char marker: adjacent `Cell` with `CellWidth::Zero`.
- [ ] Combining marks attach to preceding grapheme, not separate cell.

**Line wrap (§13.3)**:
- [ ] Width-aware wrapping via Epic A's API.
- [ ] Continuation flag set on wrapped rows.
- [ ] Reflow on resize: continuation-tagged rows reflow; `\n`-terminated rows don't.

**Main / alt (§13.4)**:
- [ ] Main and alt buffers independent.
- [ ] Cursor save/restore on DECSET 1049 / 1047 / 1048.
- [ ] Scrollback attached to main only.
- [ ] `ModeChanged(AltScreen, true)` emitted BEFORE first alt-buffer cell delta.

**Dirty / delta (§13.7)**:
- [ ] Row dirty tracking with revision counters.
- [ ] Rect damage for scroll regions.
- [ ] `CursorMoved` emitted separately from cell deltas.
- [ ] `ModeChanged` emitted separately.

**Ordering (§9, ADR 0017)**:
- [ ] Every event carries `(grid_epoch, sequence_no, buffer_kind, resize_generation)`.
- [ ] `sequence_no` strictly ascending within an epoch.
- [ ] Resize increments `resize_generation`.

### Failure modes retired

- RFC §22 #8 (1049 enter races first alt-frame — ordering guarantee here)
- RFC §22 #9 (`vim ZZ` cursor wrong — cursor save/restore here)
- RFC §22 #10 (SIGWINCH — emitted here; delivery in Epic F)
- RFC §22 #11 (`less q` broken scrollback — alt-buffer disjointness here)

### Test deliverables

- Unit tests per `Perform` method (≥ 95% line coverage).
- Unit tests per DECSET mode (for v1 set per RFC §8).
- Unit tests per OSC (0/2/4/7/8/10/11/12/52/104/105/133).
- Golden PTY stream tests for `cat`, `ls --color`, `echo '\x1b[1;31mred\x1b[0m'`, `vim --clean | head -n 20`, `tmux new-session -d | …`.
- Fuzz target: random bytes → no panic, grid invariants hold (row count stable, cursor in range, revisions monotonic, scrollback ring bounded).
- Grid invariant property tests (proptest): any sequence of ops leaves grid consistent.

### Exit gate

- [ ] All ACR items checked.
- [ ] `cargo test -p quanta-vt` green.
- [ ] `cargo clippy -p quanta-vt -- -D warnings` clean.
- [ ] Fuzz target runs 1 hour on CI without finding a panic.
- [ ] Engine fed recorded `vim --clean` / `tmux new-session` / `htop -d 1` streams produces grid within ±0 cells of Alacritty reference.
- [ ] ADR 0017 status → Accepted.

### Rollback

If VT semantics prove too deep for the 2-week budget, scope reduces by deferring lesser-used DEC modes (1034, 1036, charset SS2/SS3 complex cases) with clear "Unknown" event fallthrough. Hard gate (alt-screen, cursor, SGR, resize) cannot be reduced.

---

## Epic C — Protocol + Reducer + UI Mirror

**Goal**: Add protocol events to `quanta-proto`; implement UI-side `GridMirror` that applies deltas in (epoch, seq) order with resync-on-divergence.

**Phase**: 1→2 · **Duration**: 2 weeks · **Dependencies**: B (EventEnvelope + TerminalEvent)

### Scope

**Files (updated)**:
- `crates/quanta-proto/src/events.rs` — add new payload variants (GridSnapshot, GridDelta, CursorMoved, ModeChanged, TitleChanged, BellRequested, HyperlinkAdded/Removed, ClipboardRequest, SynchronizedUpdate).
- `crates/quanta-proto/src/envelope.rs` — extend with `grid_epoch`, `buffer_kind`, `resize_generation` (if not already carried).
- `packages/host-common/src/events.ts` — TS mirror literals.

**Files (new)**:
- `crates/quanta-proto/tests/grid_schema_snapshots.rs` — 9+ golden JSON for each payload.
- `crates/quanta-proto/tests/fixtures/schemas/grid_*.golden.json` — committed golden JSON.
- `packages/ui/src/shared/lib/grid-mirror/GridMirror.ts` — client-side state, applies deltas.
- `packages/ui/src/shared/lib/grid-mirror/__tests__/ordering.test.ts` — stale-epoch drop, sequence gap detection.
- `packages/ui/src/shared/lib/grid-mirror/__tests__/resync.test.ts` — revision mismatch → ResyncRow request.

### Contracts frozen

- Wire-format JSON shape per payload (MessagePack encoding derived).
- `GridMirror.apply(envelope)` API.
- `ResyncRow` request shape.
- Host-side `ResyncRow` handler expected behavior.

### Acceptance (maps to RFC §13.7, §9)

- [ ] All payloads have `#[serde(default)]` on additive fields.
- [ ] Golden JSON schemas committed and versioned.
- [ ] `GridMirror` discards deltas whose `grid_epoch` < applied epoch.
- [ ] `GridMirror` discards deltas whose `resize_generation` < applied generation.
- [ ] Row revision mismatch → `ResyncRow` request emitted; applied on response.
- [ ] Snapshot-fallback storm threshold (> 3/min) tracked as telemetry signal.
- [ ] Schema parity test (host-common ↔ quanta-proto enum variant names) green.

### Failure modes retired

- RFC §22 #16 (GridDelta out-of-order → resync storm — ordering + resync here)

### Test deliverables

- Golden JSON for each payload.
- Unit tests for `GridMirror`: apply in order, drop stale epoch, detect revision mismatch, request + apply ResyncRow, full-snapshot fallback on repeated mismatch.
- Fault-injection integration test: drop every 10th delta → mirror detects and resyncs.

### Exit gate

- [ ] All ACR items checked.
- [ ] `cargo test -p quanta-proto` green.
- [ ] `pnpm --filter ui test` covering GridMirror green.
- [ ] Schema-parity vitest green.

### Rollback

If MessagePack encoding overhead is problematic, swap to bincode for the grid-delta variants only (benchmark first). Contract unchanged.

---

## Epic D — Canvas Renderer + Selection

**Goal**: Canvas2D cell renderer, glyph atlas, hit-test + selection per ADR 0016, cursor/IME overlay layers, renderer backend contract (§12).

**Phase**: 2 · **Duration**: 2 weeks · **Dependencies**: C (wire protocol)

### Scope

**Files (new)**:
- `packages/ui/src/shared/ui/cell-renderer/CellBuffer.ts` — mirror the grid (delegates to Epic C's `GridMirror`).
- `packages/ui/src/shared/ui/cell-renderer/FontAtlas.ts` — offscreen-canvas rasterization, LRU 4096.
- `packages/ui/src/shared/ui/cell-renderer/Renderer.ts` — Canvas2D per-frame draw.
- `packages/ui/src/shared/ui/cell-renderer/DamageSet.ts` — sparse row/col set.
- `packages/ui/src/shared/ui/cell-renderer/HitTest.ts` — `screenToCell` / `cellToScreen`.
- `packages/ui/src/shared/ui/cell-renderer/Selection.ts` — `SelectionAnchor`, mode, normalization.
- `packages/ui/src/shared/ui/cell-renderer/backend/` — `BackendContract.ts` + `Canvas2DBackend.ts` + `MemoryBackend.ts` (no-op test double).
- `packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx` — hosting widget.
- `packages/ui/src/widgets/terminal-canvas/terminal-canvas.module.css`.
- `packages/ui/src/widgets/terminal-canvas/__tests__/` — render tests, hit-test tests, selection tests, font-atlas invalidation tests.

**Files (updated)**:
- `docs/adr/0016-selection-search-copy-semantics.md` — skeleton → Accepted.

**Out of scope**: Input events (Epic E). Alt-screen overlay UX (Epic H). xterm removal (Epic I).

### Contracts frozen

- `BackendContract` interface: `mount(container)`, `applyGridSnapshot`, `applyGridDelta`, `applyCursor`, `applyMode`, `requestDamageFlush`, `unmount`.
- Selection anchor shape + copy normalization rules (ADR 0016).
- Hit-test return shape.

### Acceptance (maps to RFC §13.5 renderer requirements, §13.8, §11, §12)

- [ ] Canvas2D backend passes contract tests.
- [ ] `MemoryBackend` (no-op) passes same contract tests (proves renderer-agnosticism).
- [ ] FontAtlas LRU evicts beyond 4096 entries; invalidates on DPR change / theme change / font-family change.
- [ ] Cursor rendered in a separate z-layer (no full-row re-blit on blink).
- [ ] IME overlay rendered in its own layer (above cursor).
- [ ] Selection anchors are cell-based, wide-char-half-normalized.
- [ ] Copy output: wrap-joined continuation, hard-newline preserved, trailing half-cell stripped, grapheme-intact.
- [ ] Hit-test `screenToCell` inverse of `cellToScreen` ± ½ cell.
- [ ] Selection modes: char (single-click drag), word (double-click), line (triple-click), block (Alt-drag).

### Failure modes retired

- RFC §22 #19 (web font late load → atlas invalidates mid-frame — handled in FontAtlas.ts)
- RFC §22 #20 (selection across wrapped row → wrong substring copy — normalization in Selection.ts)

### Test deliverables

- Renderer backend contract test suite, runs against both Canvas2D and Memory backends.
- Visual regression test: fixed `GridSnapshot` + `GridDelta` stream produces pixel-perfect output vs committed reference image (±1 px).
- Font-atlas LRU eviction test.
- Font-atlas late-load invalidation test.
- Selection round-trip tests (15+ cases across wide chars, ZWJ, wrap boundaries).
- Hit-test inverse-consistency tests.

### Exit gate

- [ ] All ACR items checked.
- [ ] `pnpm --filter ui test` green.
- [ ] Perf harness: 60 fps on 120×40 viewport with 1 MB/s output.
- [ ] ADR 0016 status → Accepted.

### Rollback

If Canvas2D perf insufficient for perf gate, move WebGL backend forward from RFC 0002 into this epic (extends duration ~1 week). Backend contract protects the rest of the system from the swap.

---

## Epic E — Input Encoder + IME

**Goal**: Keyboard encoder (3 modes), mouse (SGR 1006), bracketed paste, focus events, IME state machine per ADR 0018.

**Phase**: 3 · **Duration**: 2 weeks · **Dependencies**: C (mode state snapshot)

### Scope

**Files (new)**:
- `packages/ui/src/features/input/KeyEncoder.ts` — `KeyEvent` → bytes; 3 encoding modes (legacy xterm, `modifyOtherKeys=2`, kitty levels 1-3).
- `packages/ui/src/features/input/MouseEncoder.ts` — SGR 1006 encoding.
- `packages/ui/src/features/input/Paste.ts` — bracketed paste wrapping.
- `packages/ui/src/features/input/Focus.ts` — focus in/out encoding.
- `packages/ui/src/features/input/ime/ImeStateMachine.ts` — per ADR 0018.
- `packages/ui/src/features/input/ime/PreeditOverlay.tsx` — pure view, takes composition text + cursor anchor.
- `packages/ui/src/features/input/ModeSnapshot.ts` — reads `TerminalModeState` snapshot; never live-reads.
- `packages/ui/src/features/input/input-host.ts` — binds to DOM events on the terminal container.
- `packages/ui/src/features/input/__tests__/` — key matrix, mouse matrix, IME states, paste, focus.
- `packages/ui/src/features/input/fixtures/input-matrix.json` — 800+ `(mode × key × modifiers × layout)` cases with expected bytes.
- `packages/ui/src/features/input/fixtures/ime-recordings/` — Korean 2-set, JP, CN recorded composition sessions.

**Files (updated)**:
- `docs/adr/0018-ime-state-machine.md` — skeleton → Accepted.

### Contracts frozen

- `KeyEvent` shape.
- Mode-snapshot read contract (never live-reads, always `getSnapshot()`).
- Input-matrix golden format.
- IME recording format.

### Acceptance (maps to RFC §13.5, §13.6, §10)

**Keyboard (§13.5)**:
- [ ] Key encoder layer mandatory — `KeyboardEvent` reaches encoder, never PTY directly.
- [ ] Ctrl/Alt/Opt/Meta/Cmd/Shift in all combos covered.
- [ ] F1-F24 covered.
- [ ] Legacy xterm encoding default.
- [ ] `modifyOtherKeys=2` honored on negotiation.
- [ ] Kitty keyboard levels 1-3 honored on negotiation.

**Mouse**:
- [ ] SGR 1006 encoding correct.
- [ ] Wheel → cursor keys when mouse off, SGR button 4/5 when on.

**Paste + focus**:
- [ ] Bracketed paste wraps with sentinels if DECSET 2004 on.
- [ ] Focus in `ESC [ I` / out `ESC [ O` if DECSET 1004 on.

**IME (§10, §13.6, ADR 0018)**:
- [ ] State machine: Idle → Composing → Committed|Cancelled → Idle.
- [ ] PTY bytes emitted ONLY on commit.
- [ ] Preedit NEVER enters grid; overlay-layer only.
- [ ] `keydown` events during Composing fully suppressed.
- [ ] Cancel (Esc): cleared without PTY emission.
- [ ] Blur policy: platform-dependent (macOS cancel; Win/Linux preserve 1s).
- [ ] Sidecar restart during Composing: state forced to Cancelled, banner shown.

### Failure modes retired

- RFC §22 #1 (Korean 2-set double-input on `vim :%s`)
- RFC §22 #2 (`Ctrl+Shift+A` ≡ `Ctrl+A`)
- RFC §22 #3 (fzf Alt+Enter kitty level)
- RFC §22 #4 (tmux prefix modifyOtherKeys)
- RFC §22 #12 (htop SGR `;` vs `:`)
- RFC §22 #13 (bracketed paste leaks into vim)
- RFC §22 #14 (emacs -nw modifyOtherKeys negotiation)
- RFC §22 #18 (sidecar restart mid-composition)

### Test deliverables

- Input matrix: 800+ recorded cases.
- IME recordings: 3 IMEs × 6 scenarios (shell / vim insert / tmux / cancel-via-Esc / blur / resize-mid-compose) = 18 minimum.
- Dead-key composition (macOS Opt+e+e → é) tested separately.
- Mode-state fault-injection: encoder with conflicting mid-encode mode change, assert snapshot-based read wins.

### Exit gate

- [ ] All ACR items checked.
- [ ] `pnpm --filter ui test` green.
- [ ] 800+ input matrix all pass.
- [ ] 3 IMEs all pass.
- [ ] Korean 2-set double-input bug reproducibly absent.
- [ ] ADR 0018 status → Accepted.

### Rollback

Kitty keyboard levels 4-5 deferred to v2 (already in RFC non-goals). If level 1-3 proves impractical in 2 weeks, ship with `modifyOtherKeys=2` only; kitty support behind a feature flag. Hard gate is legacy xterm + `modifyOtherKeys=2`; kitty is best-effort.

---

## Epic F — Session Integration + Actor Wiring

**Goal**: Wire `quanta-vt` into the session actor; feed PTY bytes through the engine; emit events via fanout.

**Phase**: 3 · **Duration**: 1.5 weeks · **Dependencies**: B, C

### Scope

**Files (updated)**:
- `crates/quanta-session/src/adapters/actor.rs` — PTY byte chunks → `Grid::feed(...)` → events → `sink.append(envelope)`.
- `crates/quanta-session/src/ports/` — event type imports from `quanta-vt`.
- `crates/quanta-core/src/adapters/fanout.rs` — broadcast new event types.
- `crates/quanta-events/` — persist grid-delta and ancillary events for replay.

**Files (new)**:
- `crates/quanta-session/tests/vt_integration.rs` — end-to-end: PTY byte stream → actor → fanout → event trace; verifies ordering invariants.
- `tests/integration/tests/resume_vt.rs` — disconnect, reconnect, engine replays events, UI sees `GridSnapshot` scoped to resume cursor.

### Contracts frozen

- Actor ↔ engine invocation pattern (one `Grid::feed` per PTY chunk).
- Event-log persistence shape for new event types.
- Resume semantics: engine replays log-then-emits-snapshot.

### Acceptance (maps to RFC §7.9 scrollback authority, §13 actor invariants)

- [ ] Every PTY byte chunk passes through `Grid::feed`.
- [ ] Emitted events carry monotonic `sequence_no` (existing `monotonic_seq`).
- [ ] Events persisted to event log.
- [ ] Resume: engine reconstructs grid by replaying OutputChunks; emits `GridSnapshot` to host.
- [ ] Resize through the actor increments `resize_generation`.
- [ ] Session close: grid state discarded; event log preserved.

### Failure modes retired

- Grid state divergence across reconnect (verified by vt_integration test).

### Test deliverables

- End-to-end `vt_integration.rs` test.
- Resume test verifying identical grid state pre- and post-reconnect.
- Resize-during-output test verifying `resize_generation` bump + reflow.

### Exit gate

- [ ] All ACR items checked.
- [ ] `cargo test --workspace` green.
- [ ] Existing session tests continue to pass.
- [ ] Event-log replay determinism test green.

### Rollback

If ordering breaks existing actor tests, a feature flag `session.use_vt_engine = false` reverts to the pre-VT emitter path. This flag is removed in Epic I.

---

## Epic G — Compat Matrix + Golden Streams

**Goal**: Record golden PTY byte streams for every §13.9 MUST program; scripted interactive scenarios; automated diff against expected grid snapshots.

**Phase**: 4 · **Duration**: 1.5 weeks · **Dependencies**: B+C+D+E (engine + protocol + renderer + input)

### Scope

**Files (new)**:
- `crates/quanta-vt/tests/compat/vim/input.pty` — recorded bytes
- `crates/quanta-vt/tests/compat/vim/scenario.md` — human-readable
- `crates/quanta-vt/tests/compat/vim/expected_grid_snapshot.json`
- `crates/quanta-vt/tests/compat/vim/expected_cursor.json`
- `crates/quanta-vt/tests/compat/vim/expected_modes.json`
- …repeat for: nvim, less, nano, htop, btop, top, man, ranger, mc, tmux, vim-in-tmux, ssh-loopback, ncmpcpp
- `crates/quanta-vt/tests/compat/harness.rs` — replay + compare.
- `scripts/record-compat-stream.sh` — `script(1)` wrapper with fixed `TERM`/`LINES`/`COLUMNS`.
- `tests/integration/tests/compat_scripted.rs` — scripted interactive scenarios (launch program, send keystrokes, verify visible output).

### Contracts frozen

- Golden-stream format (bytes + expected snapshot + expected cursor + expected modes).
- `compat-gap/<program>.report` schema for reporting mismatches.

### Acceptance (maps to RFC §13.9, §13.10)

- [ ] Every §13.9 MUST entry has a recorded golden PTY stream.
- [ ] Every entry has an expected grid snapshot, cursor state, mode state.
- [ ] Harness replays + diffs; any mismatch → `compat-gap/<program>.report` generated with diff details.
- [ ] `vim inside tmux` is a distinct entry (not same harness run as `vim` alone).
- [ ] Scripted interactive scenarios (vim basic edit, tmux split, htop mouse) run green.
- [ ] Fuzz + resize stress run alongside compat suite.

### Failure modes retired

All remaining §22 items not already retired — this epic is the catch-all validation layer.

### Test deliverables

- 13+ golden-stream fixtures.
- 13+ scripted scenarios.
- Harness + diff runner.
- `compat-gap/` report generation tool.

### Exit gate

- [ ] All ACR items checked.
- [ ] Every MUST compat entry green in scripted + 90-minute interactive dogfood.
- [ ] Zero `compat-gap/` reports with unresolved entries.

### Rollback

If a MUST entry consistently fails, it moves to "known gap" status and §19 removal gate remains FALSE. Epic is not done; xterm is not removed; canvas renderer ships as opt-in.

---

## Epic H — Block Overlay + Alt-screen UX + Side-by-side

**Goal**: Block chrome re-anchored to grid row ranges; alt-screen UX collapse; side-by-side `data-renderer` flag; degraded-mode contract implemented.

**Phase**: 5 · **Duration**: 1 week · **Dependencies**: D, E, F, G

### Scope

**Files (updated)**:
- `packages/ui/src/widgets/block-list/BlockList.tsx` — virtualize row ranges, not block entities. Use `cellToScreen` to anchor block chrome.
- `packages/ui/src/widgets/block-card/BlockCard.tsx` — chrome collapse / re-expand on alt-screen transitions.
- `packages/ui/src/pages/terminal-page/TerminalPage.tsx` — mount `TerminalCanvas`; wire `data-renderer="canvas"|"xterm"` flag; handle alt-screen mode transitions via `ModeChanged` events.
- `packages/ui/src/entities/tui/` — drive from `ModeChanged` events (not legacy `tuiActive`).

**Files (new)**:
- `packages/ui/src/features/compat/SideBySideHarness.tsx` — dev-mode overlay showing canvas vs xterm side-by-side with cell-diff overlay.
- `packages/ui/src/features/compat/__tests__/side-by-side.test.tsx` — harness tests.
- `packages/ui/src/features/degraded-mode/` — §20 contract implementation; read-only last snapshot + banner on engine death.

### Contracts frozen

- Side-by-side harness config (which renderer is default, how diffs are reported).
- Degraded-mode banner messages + recovery flow.

### Acceptance (maps to §7 alt-screen table, §20 degraded mode, §13.11 side-by-side)

**Alt-screen UX**:
- [ ] DECSET 1049 enter: block chrome collapses to thin status line, 160ms fade.
- [ ] DECSET 1049 exit: chrome re-expands, 160ms fade.
- [ ] Nested alt-screen (vim inside tmux): outermost transition only is UX-visible; depth counter.
- [ ] Alt-screen program crash (PTY closes mid-alt): status line shows error, 2s hold, then read-only ghost frame dismissed.
- [ ] `ModeChanged` arrives before first alt-buffer cell delta (§9 ordering guarantee).

**Side-by-side**:
- [ ] `data-renderer="canvas"` flag flips renderer.
- [ ] Both renderers consume the same PTY event stream.
- [ ] Cell diff, cursor diff, mode diff all surfaced in dev overlay.
- [ ] Input event diff: encoded bytes identical on both paths.

**Degraded mode (§20)**:
- [ ] Last consistent snapshot retained on engine death.
- [ ] Banner: "engine crashed; last frame preserved. Restart session to continue."
- [ ] Input disabled or redirected after capability check.
- [ ] No black-screen failure (test: `kill -9 quanta-core` → verify banner + frame).
- [ ] Recovery path observable + logged.

### Failure modes retired

- RFC §22 #8 (alt-screen enter race — verified here end-to-end)
- RFC §22 #17 (engine crash mid-alt-screen → black screen — degraded-mode here)

### Test deliverables

- Alt-screen transition tests (4 transitions per §7 table).
- Side-by-side harness tests.
- Degraded-mode integration test (`kill -9` sidecar).

### Exit gate

- [ ] All ACR items checked.
- [ ] Side-by-side diff zero across compat matrix.
- [ ] Degraded-mode integration test green.

### Rollback

If side-by-side reveals > 2 unrecoverable MUST compat gaps, canvas renderer stays experimental flag; xterm stays default. Epic H reported done with "gate FALSE" status; Epic I does not start.

---

## Epic I — xterm Removal + Cleanup

**Goal**: Remove xterm.js and the legacy xterm surface. Final cleanup.

**Phase**: 6 · **Duration**: 3 days · **Dependencies**: §19 gate ALL-TRUE

### Scope

**Files (deleted)**:
- `packages/ui/src/widgets/terminal-shell/` (entire directory)
- `packages/ui/src/widgets/terminal-shell/__tests__/`
- Any residual `useTerminalSurface.ts` hook

**Files (updated)**:
- `packages/ui/package.json` — remove `@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-webgl`, `@xterm/addon-web-links`.
- `packages/ui/src/pages/terminal-page/TerminalPage.tsx` — remove `tuiActive`, `needsAltScreen`, `altScreenVisible` branching; `TerminalCanvas` becomes unconditional.
- `packages/ui/src/entities/tui/` — remove if fully subsumed by `ModeChanged` events, or simplify.
- `docs/adr/0001-host-modes.md` — remove xterm fallback clause.
- `docs/terminal-benchmark-matrix.md` — update engine column.
- `docs/RELEASE.md` — release note for xterm removal.

### Acceptance

- [ ] §19 gate ALL-TRUE.
- [ ] `grep -ri "xterm" packages/` returns zero non-historical source hits.
- [ ] `pnpm install` after package.json change: no xterm deps.
- [ ] All existing tests green.
- [ ] Release note added.
- [ ] ADR 0001 updated.
- [ ] `docs/technical-architecture.md` reflects unified engine.

### Exit gate

- [ ] All ACR items checked.
- [ ] RFC 0001 status → Accepted.
- [ ] One-week post-removal dogfood shows zero xterm-related issues (because there is no xterm).

### Rollback

Hard rollback: revert the commit. Canvas renderer stays as default; xterm directory re-added from git history. This is a safety valve; once shipped in production, rollback requires a point release.

---

## Epic J — Telemetry + Perf Harness (cross-cutting)

**Goal**: Instrument every hot path with telemetry; perf harness fixtures + CI gating.

**Phases**: 0→5 (rolling) · **Duration**: ~1 week of total work spread across phases · **Dependencies**: each spec's target phase

### Scope

**Files (updated — rolling)**:
- Each epic's implementation files get instrumentation hooks.
- `crates/quanta-metrics/` already exists; extends with new counters per RFC §13.14.
- `crates/quanta-vt/benches/` — criterion benches.
- `packages/ui/src/shared/lib/perf-harness/` — frame-time instrumentation.
- `tests/perf/` — golden perf fixtures (`yes`, `cargo test`, `find /`) + expected budgets.

**Files (new)**:
- `.github/workflows/perf.yml` — perf-regression CI (runs on every PR touching hot paths).
- `docs/perf-baselines.md` — baseline numbers per platform; updated when budgets re-baseline.

### Contracts frozen

- Metric names + types (Counter / Gauge / Histogram) — versioned.
- Perf budget decomposition stages (§13.13): PTY parse / reducer / layout / raster / cursor / atlas-miss.

### Acceptance (maps to §13.12, §13.13, §13.14)

- [ ] Every counter in §13.14 is emitted somewhere in the codebase.
- [ ] Perf harness measures each stage in §13.13 independently.
- [ ] CI perf job compares against stored baseline; fails on >10% regression.
- [ ] `quanta-replay dump-grid` debug tool works (§14.2).

### Failure modes retired

- Indirectly: telemetry catches drift before it becomes user-visible (snapshot storm, IME abnormal termination, mode conflict).

### Exit gate

- [ ] All counters from §13.14 are live.
- [ ] Perf harness runs on every PR.
- [ ] Baseline committed; regression alarms configured.

### Rollback

Telemetry is additive — no rollback needed. Perf harness can be downgraded to manual-run-only if CI time budget blows up.

---

## Epic K — CI + Platform Matrix + Golden Infra (cross-cutting)

**Goal**: CI jobs, cross-platform test matrix (macOS arm/x86, Linux, Windows), golden-fixture scaffolding.

**Phases**: 0→6 (rolling) · **Duration**: ~1 week of total work · **Dependencies**: each spec's target phase

### Scope

**Files (new)**:
- `.github/workflows/vt-engine.yml` — runs `cargo test -p quanta-vt` + fuzz + compat.
- `.github/workflows/ui-renderer.yml` — runs vitest on renderer + selection + IME golden.
- `.github/workflows/compat-matrix.yml` — runs compat harness per-platform.
- `.github/workflows/parity.yml` — Rust↔TS width/grapheme parity.
- `tools/check-ui-no-ansi/` — CI grep rule: no `\x1b` ANSI parsing outside `crates/quanta-vt/`.
- `tools/check-paint-no-width-override/` — CI rule: renderer files may not import width logic.
- `docs/platform-matrix.md` — per-platform quirks + known-differences tracking.

**Files (updated)**:
- `.github/workflows/ci.yml` — calls the new sub-workflows.

### Contracts frozen

- CI job naming + shape.
- Fixture corpus layout (`crates/quanta-vt/tests/compat/<program>/`).
- Grep-rule patterns for I-2 (no ANSI parsing in UI), I-4 (paint no width override), I-6 (no direct PTY from KeyboardEvent).

### Acceptance

- [ ] All 4 grep rules from Invariants §2 active in CI.
- [ ] Compat matrix runs on macOS arm64, macOS x86_64, Linux x86_64, Windows x86_64.
- [ ] Platform-specific quirks documented in `platform-matrix.md`.
- [ ] Golden fixture corpus structured per compat program.

### Failure modes retired

- Indirectly: CI catches regressions before merge on all 4 platforms.

### Exit gate

- [ ] All 4 platforms green on full compat suite.
- [ ] Grep rules stable (no false positives in production code).
- [ ] Platform matrix document up to date.

### Rollback

If Windows compat blocks too long, Windows falls to "known partial" status; §19 gate can still green for macOS+Linux, Windows ships with canvas renderer as experimental flag.

---

# EXECUTION KICKOFF

## Day 1 — simultaneous starts

**Implementation (trunk)**:
- **EPIC-A** implementation agent spawned. Scope: quanta-vt-width + ADR 0015.

**Spec-ahead (Gear 3)**:
- **EPIC-B** spec agent: designs `quanta-vt` file layout, freezes `EventEnvelope` draft.
- **EPIC-C** spec agent: drafts protocol wire format + golden JSON templates.
- **EPIC-D** spec agent: ADR 0016 flesh-out + Canvas2D render model sketch.
- **EPIC-E** spec agent: ADR 0018 flesh-out + input matrix template.

**Cross-cutting (Gear 2)**:
- **EPIC-J**: metric schema + `quanta-metrics` counter additions.
- **EPIC-K**: CI grep rules + workflow stubs.

Spec-ahead agents converge their contracts as EPIC-A's implementation lands. Implementation for B/C/D/E kicks off on Day 8-10 (when A ships).

## Week-by-week

| Week | Active epics | Freezes |
|------|-------------|---------|
| 1 | A (impl) · B/C/D/E (spec) · J · K | EPIC-A contract (end of week) |
| 2 | A wraps · B (impl) · C/D/E (spec continues) · J · K | EPIC-B contract (end of week 3) |
| 3 | B continues · C (impl) · F (impl) · D/E (spec) · J · K | EPIC-C contract (end of week 4) |
| 4 | B wraps · C continues · D (impl) · E (impl) · F continues · J · K | — |
| 5 | C/D/E/F all converging · J · K | EPIC-D, E exit |
| 6 | G (impl) · J · K | Compat matrix forms |
| 7 | G wraps · H (impl) · J · K | §19 gate evaluated |
| 8 | H wraps · I (if §19 ALL-TRUE) | xterm removed |
| 9 | contingency / 1-week dogfood | — |

## Kickoff authorization

Before Day 1 implementation spawns:

- [ ] Sign-off on RFC 0001 §2 (invariants).
- [ ] Sign-off on RFC 0001 §3 (SSOT boundaries).
- [ ] Sign-off on RFC 0001 §8-§12 (authority contracts).
- [ ] Sign-off on RFC 0001 §19 (final removal gate).
- [ ] Sign-off on this epic plan.

---

## Appendix — Risk register

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|------------|--------|------------|-------|
| Korean IME edge case escapes CI recordings | Medium | High (user-facing) | ≥ 3 real-device recording sessions before sign-off | Epic E |
| `tmux` passthrough requires DECRQSS support | Medium | Medium | Scoped OUT of v1; document clearly | Epic G |
| Ambiguous-width default wrong for some Linux distro | Low | Medium | User-overrideable in Settings | Epic A |
| Canvas2D perf insufficient on low-end laptops | Medium | High | RFC 0002 WebGL in follow-up; canvas viable for baseline (M-series) | Epic D |
| Kitty keyboard levels 1-3 too broad for 2w | Medium | Low | Fall back to levels 1-2; 3 behind flag | Epic E |
| Side-by-side reveals >2 MUST gaps | Medium | High (blocks I) | Rollback plan in §14; canvas stays experimental | Epic H |
| Engine crash during dogfood reveals UX gap | Low | Medium | Degraded mode contract (§20); banner + read-only frame | Epic H |
| `vim inside tmux` compat slippage | High | High | Distinct test entry; tracked as its own compat row | Epic G |
| VT engine own ANSI emulator maintenance burden | Certain | Ongoing | Compat matrix + fuzz + public issue template | team |
| Windows ConPTY differences | Medium | Low (v1) | Platform matrix; Windows as "known partial" acceptable for v1.0 | Epic K |

## Appendix — Contract freeze checklist

Each contract that downstream epics block on:

**Freeze 1 — end of Phase 0 (EPIC-A)**:
- [ ] `CellWidth` enum finalized.
- [ ] `Grapheme` storage shape finalized.
- [ ] `AmbiguousWidthPolicy` finalized.
- [ ] `wrap_eligible` API finalized.
- [ ] Rust↔TS parity test green on golden corpus.

**Freeze 2 — ~Phase 1 week 1 (EPIC-B spec-freeze)**:
- [ ] `EventEnvelope` shape finalized.
- [ ] `TerminalEvent` variants enumerated.
- [ ] `Grid::feed` signature finalized.
- [ ] `TerminalModeState` snapshot shape finalized.

**Freeze 3 — ~Phase 1-2 boundary (EPIC-C spec-freeze)**:
- [ ] Wire protocol JSON shape per payload.
- [ ] Golden JSON templates committed.
- [ ] `GridMirror` apply/resync API.
- [ ] `ResyncRow` request shape.

**Freeze 4 — ~Phase 3 week 1 (EPIC-E spec-freeze)**:
- [ ] Input matrix golden format.
- [ ] IME recording format.
- [ ] `ModeSnapshot` read contract.

Each freeze is documented by a PR merging the finalized types; downstream epics reference the commit SHA.

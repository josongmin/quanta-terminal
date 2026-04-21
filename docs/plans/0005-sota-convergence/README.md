# Plan 0005 — SOTA++ Terminal Convergence

- **Status**: Draft v3 (2026-04-21) — reordered to P0/P1/P2; Run entity / Intent layer demoted to P2
- **Authors**: Engine team
- **Supersedes-in-part**: the implicit "block-mode uses linear AnsiParser, alt-screen uses VtEmulator" bifurcation
- **Reaffirms**: RFC 0001 invariants I-1 (one VT engine), I-6 (encoder layer non-optional)
- **Breaking changes**: YES in P0 (default render path + default input path rewritten)
- **ROI gate**: N/A (compliance-with-own-invariants work)

---

## 0. The one line that drives this plan

> **"xterm 대체 가능한 VT terminal 을 먼저 완성한다."**
>
> Block UX / Run 엔티티 / Intent 레이어 / AI 통합 전부 그 다음이다.

P0 가 통과하지 않은 상태에서 P1 / P2 에 손대는 것은 "가짜 터미널을 더 예쁘게 만드는 것" 이다. 모든 상위 기능은 **VT correctness → input correctness → render/perf correctness → compat correctness** 4축이 전부 초록불일 때 시작한다.

---

## 1. Minimum ship set (P0 compat matrix)

Ship criteria for "xterm 대체 가능한 terminal":

| Category | Must pass |
|----------|-----------|
| Shells | `bash`, `zsh`, `fish` |
| Editors | `vim`, `neovim` |
| Pagers | `less`, `man`, `more` |
| Monitors | `top`, `htop`, `watch -n 0.1 date` |
| Multiplexer | `tmux`, `tmux-in-ssh`, `tmux-in-ssh-in-tmux` |
| Network | `ssh`, `mosh` (best-effort), remote bash |
| REPLs | `python3`, `node`, `psql` |
| Combinators | `git log \| less`, `find / \| grep`, `yes \| head -c 1G` |
| UX basics | `clear`, resize, split pane, copy/paste, Korean 2-set IME, Japanese IME |
| Stress | `tail -f` at 50 MiB/s, 4K display, DPR change mid-session |

Ship gate: every row above is green on macOS + Linux in CI. Windows ConPTY remains known-partial (RFC 0001 Epic K).

**None of this requires shell integration.** Shell integration enhances UX (block boundaries, authoritative exit codes) but the terminal is usable without it.

---

## 2. Current state vs P0 target

### 2.1 What exists (full credit)

| Layer | Artifact | Notes |
|------|----------|-------|
| VT core (Rust) | `crates/quanta-vt/` | Grid, main+alt buffer, SGR, DECSET, DECSTBM, DECSC/DECRC, charset, OSC 7/10/11, DEC 1049/1047/1048, DCS 2026 |
| VT mirror (TS) | `shared/lib/vt-emulator/VtEmulator.ts` (1884 LOC) | Structure present; **1049/1047/47 NO-OP in TS** — comment: "Here we just swallow" |
| Grid mirror | `shared/lib/grid-mirror/` | Resync, ordering, storm-threshold snapshot fallback |
| Cell renderer | `shared/ui/cell-renderer/` | CellBuffer, FontAtlas (DPR), Canvas2DBackend, DamageSet, HitTest, Selection, Search |
| Input host | `features/input/input-host.ts` | KeyEncoder (legacy+kitty+MoK v1/v2), MouseEncoder, Paste (2004), Focus (1004), IME SM (KR/JP/CN/dead-key) |
| Alt-screen detector | `features/tui/detect.ts` | Byte-level DEC 1049/1047/47 FSM |
| TUI surface | `TuiRenderSurface` + `TuiInputSurface` | Full pipeline — **alt-screen-gated only** |
| Shell integration | `resources/shell-integration/{bash,zsh,fish}.sh` | OSC 133 A/B/C/D + OSC 7/1337. Wizard-only install |
| Write batcher | `shared/lib/write-batcher.ts` | rAF-coalesced, 1 MiB eager flush — **no priority, no frame-skip** |

### 2.2 What's wired for the default path (block mode)

```
PTY bytes ──► appendToActiveBlock            (legacy path)
              ├─ detector: null               (mock-only detector off)
              ├─ no OSC 133 parse
              ├─ 400 ms idle → completeBlock(exit=0)  ← fake
              └─ per-block outputChunks: Uint8Array[]
                          │
                          ▼
              BlockBody → AnsiParser span stream
                          │
                          ▼
              AnsiOutput (HTML spans)

User keystrokes:
  <textarea> value state
    └─ Enter → submitCommand → bridge.write(text + '\n')
```

This path fails every P0 axis:

- **VT**: cursor addressing inside output corrupts (`\x1b[K` renders as gibberish spans). No buffer model.
- **Input**: Ctrl+C/R/D/L dead. Tab completion dead. readline / ZLE dead. Mouse reporting dead in pre-TUI grid.
- **Render/perf**: per-event React render. Unbounded `outputChunks`. No damage redraw. No frame coalescing beyond batcher which itself isn't wired to block mode.
- **Compat**: vim enter/exit corrupts on return (alt-buffer NO-OP). less redraw corrupts. htop drops frames under load. tmux-in-tmux undefined.

### 2.3 What's wired for alt-screen

Works because the full engine pipeline mounts, but only for that mode.

### 2.4 Target default path (after P0)

```
PTY bytes ──► WriteBatcher (priority-aware) ──► VtEmulator.feed
                                                     │
                                                     ▼
                                              GridMirror (SSOT)
                                                     │
                                                     ▼
                                              CellBuffer / Canvas2DBackend
                                                     │ damage redraw
                                                     ▼
                                              Paint

User events ─► SessionInputSurface (always on, spans terminal chrome)
                └─ input-host (KeyEncoder / MouseEncoder / Paste / Focus / IME)
                   └─ bytes → bridge.write
```

No block UI, no Run entity, no Intent router in P0. Block UX is optional presentation landed in P1.

---

## 3. Design invariants (P0 scope)

RFC 0001 invariants I-1..I-10 apply. P0 adds exactly two new ones:

- **I-11 (P0)** — **One render path.** Every glyph on screen is painted by the cell renderer reading `GridMirror`. No React component renders character data. CI grep: `one-render-path`.
- **I-12 (P0)** — **One input path.** Every byte entering the PTY comes from `input-host`. CI grep: `one-input-path`.

Deferred invariants (moved to P1/P2):

- I-13 (P1) — Hybrid boundary confidence model. Relevant only once block UX is enabled.
- I-14 (P0 implicit) — Scrollback bounded & running-pinned. Covered by Epic α below.
- I-15..I-17 (P2) — Priority-classified output, Intent-before-bytes, Run-is-the-unit. Not P0.

---

## 4. P0 — "Real terminal" (the only must-ship scope)

Five epics. Strict order: α → {β, γ, δ} → ε.

### Epic α — Single VT engine (one feed, buffers, scrollback)

**Goal**: every PTY byte goes through one `VtEmulator` instance per session. Main + alt buffers + bounded scrollback ring.

**Work items**:
- α1. Session-level `VtEmulator` installed in `features/session/connect.ts`. Every `pty_data` feeds it before any other consumer touches bytes.
- α2. **Fix G-VT-01**: implement DEC 1049/1047/47 in `VtEmulator.ts`. Swap active buffer pointer; save/restore cursor for 1048/1049; clear alt buffer on enter-1047.
- α3. **Scrollback ring**: add a row-ring owned by `VtEmulator.mainBuffer`. Bounded by `settings.scrollbackRows` (default 10,000). Eviction policy: oldest row first, **except** any row marked as `pinned_by_running_block`.
- α4. Main/alt separation: scroll-up from main buffer appends to ring; scroll-up from alt buffer is discarded (alt has no scrollback, matches xterm).
- α5. Resize re-flow: rows re-wrap on cols change; alt buffer clears (xterm behavior); main buffer preserves content with reflow.
- α6. Remove `AnsiParser` usage from BlockBody and any production path. Span fallback allowed only for static log previews (history / AI explain — P1 concerns). CI grep rule rejects new imports.

**Exit gates**:
- E-α-01 vim enter/exit restores main buffer byte-exactly (100 transitions).
- E-α-02 less quit restores main buffer.
- E-α-03 `yes | head -c 1G` produces no OOM; scrollback ring evicts to cap.
- E-α-04 Resize from 200×50 → 80×24 → 200×50: main buffer content preserved with correct reflow; alt buffer clears per xterm spec.
- E-α-05 Grep rule `one-render-path` passes.

**Breaking**: `block.outputChunks` drops in P0 — every consumer needs to resolve through the grid. BlockCard body → grid row range. See §8 for migration.

---

### Epic β — Single input path (always-on SessionInputSurface)

**Goal**: `input-host` is session-scoped and always mounted. Every keystroke, every mouse event, every paste, every focus event goes through the encoder layer to the PTY.

**Work items**:
- β1. New `SessionInputSurface` replaces alt-screen-gated `TuiInputSurface`. Spans full terminal chrome; auto-focused on session-active; wraps `input-host`.
- β2. Composer (if present as a line-editor overlay) **does not write bytes directly**. Composer Enter issues bytes through the SAME encoder path as raw typing — `bracketPastePayload(text)` + `encodeKey(Enter)`.
- β3. Ctrl+C / Ctrl+D / Ctrl+R / Ctrl+Z / Ctrl+L / Ctrl+A / Ctrl+E pass through encoder native.
- β4. Tab completion: when user presses Tab, encoder sends `\t`; shell's readline / ZLE handles completion and echoes results; grid renders them.
- β5. Reverse-i-search (`Ctrl+R`): encoder sends `\x12`; shell enters its own search mode; user sees it in the grid; ESC exits.
- β6. Mouse reporting (1000/1002/1003/1006/1015): `MouseEncoder` always active; DECSET gates whether apps actually want it; encoder reads mode live from grid.
- β7. Focus in/out (1004): always-on; apps that request it get DSR bytes.
- β8. Bracketed paste (2004): encoder wraps paste text in `\x1b[200~...\x1b[201~` when mode is on; degrades gracefully when off.
- β9. IME (KR 2-set / JP / CN pinyin / dead-key / AltGr): state machine already tested with recorded corpora; wire to session surface.
- β10. `KeymapGuard` layer intercepts only UI-level shortcuts (Cmd+K palette, Cmd+T new tab, Cmd+\ pane focus, Cmd+= zoom). Everything else routes through.
- β11. Paste safety: move from composer to `input-host.onPasteGate` (prop already exists).

**Exit gates**:
- E-β-01 bash: `Ctrl+R` opens reverse-i-search; typing narrows; ESC exits.
- E-β-02 zsh: Tab completion lists files.
- E-β-03 `Ctrl+C` interrupts running command in < 50 ms.
- E-β-04 `Ctrl+Z` suspends; `fg` resumes.
- E-β-05 Korean 2-set IME: recorded corpus byte-identical on block vs alt-screen entry.
- E-β-06 Paste > 10 KB with newline triggers paste-safety dialog.
- E-β-07 Mouse click on pre-vim grid emits 1000/1006 report when app enables mouse tracking.
- E-β-08 CI grep rule `one-input-path` passes: no React component outside `SessionInputSurface` writes to `bridge.write`.

**Breaking**: `submitCommand`-owns-the-write goes away. Composer textarea is no longer the canonical test target — `fireEvent.change` migrations needed.

---

### Epic γ — Rendering + frame-skip backpressure (data-safe)

**Goal**: no OOM under flood; no UI-thread stall; **data loss only as last resort**. "표시 늦어짐은 허용, 데이터 손실은 최대한 금지."

**Work items**:
- γ1. `WriteBatcher` between PTY and `VtEmulator.feed`: rAF-coalesced; soft cap; preserves byte-frame completeness (never splits mid-CSI / mid-OSC).
- γ2. **Default policy is frame-skip, not drop.** If render budget exceeded, the batcher still feeds VtEmulator; the renderer skips paint frames and only damages what the next painted frame needs. Data stays, display lags.
- γ3. Damage-based redraw: `CellBuffer.damage` set drives paint region. Only changed rows repaint. Already implemented — wire to the default path.
- γ4. UI-thread stall cap: any single VT feed() that would exceed 8 ms of CPU budget is interrupted; remaining bytes stay in the batcher queue, flush next frame.
- γ5. Soft memory ceiling (default 128 MiB queued bytes). Below → flush normally. At threshold → slow the PTY (send SIGSTOP via sidecar for 1 frame; resume). If the sidecar flow-control hook isn't available, fall back to buffering above threshold with a banner warning.
- γ6. **Last-resort drop** (only if memory > 256 MiB and sidecar flow-control unavailable): drop OLDEST scrollback rows first, never current-viewport. Control sequences (OSC 133, OSC 7, mode changes) pinned to a separate lossless queue if/when block UX lands (P1 concern). In P0, the sidecar flow-control path is the primary defense — drop is emergency-only.
- γ7. Resize perf: resize does not re-parse from-PTY bytes; it re-reflows the existing grid. Measured < 16 ms for 200×50 → 80×24.
- γ8. DPR change: atlas invalidation already tested (FontAtlas test). Add prod verification via macOS hot-plug monitor test fixture.

**Exit gates**:
- E-γ-01 `watch -n 0.05 date` runs for 60 s at 4K: frame budget P99 < 16 ms, memory steady < 150 MB RSS, zero dropped bytes.
- E-γ-02 `yes` runs for 60 s: sidecar flow-control engages or emergency scrollback-oldest eviction observable; no OOM; viewport always shows latest.
- E-γ-03 `find / 2>/dev/null` completes without UI freeze > 100 ms.
- E-γ-04 Resize test: 200×50 → 80×24 → 200×50 → 80×24 (10 cycles) stays under 16 ms per resize.
- E-γ-05 No dropped bytes in happy-path + standard-load compat tests — measured by byte-counter on feed path vs sidecar emit counter.

**Rationale on drop-vs-skip**: a first-version terminal that silently drops log bytes is worse than one that shows them late. The user is explicit on this. Priority-classified drop (original v2 Epic H) is reserved for P2 when Run entity + tag system can distinguish "this is cosmetic progress spinner output" from "this is the error message I'm debugging." Until then: never drop unless OOM.

---

### Epic δ — Works without shell integration (heuristic baseline)

**Goal**: P0 terminal is complete and usable when shell integration is missing. Not "degraded" — just "no block boundaries." Everything else works.

**Work items**:
- δ1. **No shell integration auto-install in P0.** (Moved from original Epic A. Auto-install is a P1 enhancement once block UX is opt-in.)
- δ2. **No block boundary detection in P0.** The terminal runs as a single continuous grid; user types commands, sees output, scrolls back. No cards, no per-command exit codes, no pins. Session tabs + pane splits still work.
- δ3. In P0, the `useBlockStore` is disabled at the default path; the entire `features/command/route-output` block-boundary machinery is dormant. BlockList renders nothing in the default UI — it becomes an opt-in debug/experimental view.
- δ4. `features/session/connect.ts` stops calling `blockStore.startBlock`. PTY bytes flow PTY → batcher → VtEmulator → grid → renderer. No block side-effects.
- δ5. Preamble / greeting behavior: the initial `Last login:` + shell prompt simply appears in the grid. No preamble block special case.
- δ6. Alt-screen transitions: handled by VT engine's main↔alt buffer swap. `TuiInputSurface` no longer needed — `SessionInputSurface` handles all input regardless of buffer mode.
- δ7. Cwd tracking: heuristic parse of `cd` commands (already implemented — `predictCwdAfter`) + best-effort `process.cwd` query via sidecar periodically. OSC 7, if the user happens to install shell integration, overrides. No hard dependency.

**Exit gates**:
- E-δ-01 Fresh install with no rc file modifications: bash/zsh/fish all run cleanly in Quanta. All P0 compat matrix rows pass.
- E-δ-02 No "Install shell integration" banner visible at P0 (banner is P1 feature).
- E-δ-03 `cd Documents` + `pwd` prints `/Users/.../Documents`; header UI may be stale but the shell itself is authoritative.
- E-δ-04 Block-UX-related tests are either skipped in P0 mode or gated on `flag.blockUx === true` (P1 opt-in flag).

**Breaking**: the existing BlockCard / BlockList production UI disappears from the P0 default. It moves to a P1 flag-gated presentation layer (Epic ε2). Tests that assert "block card renders" are either moved to P1 or rewritten to assert grid state.

---

### Epic ε — Compat matrix + perf harness

**Goal**: prove P0 on the ship set. No green-all = no ship.

**Work items**:
- ε1. Compat fixtures (golden streams + expected grid snapshots):
  - `vim` open / edit / save / quit
  - `nvim` LSP-enabled edit
  - `vim :!bash` nested shell
  - `less /etc/passwd` + `/` search + `q`
  - `man ls` / `man git`
  - `top` / `htop` for 30 s
  - `watch -n 0.1 date` for 60 s
  - `tmux new`, `C-b "`, `C-b %`, `C-b c`, attach/detach
  - `tmux-in-ssh-in-tmux` depth 3 with mouse click reaching innermost
  - `ssh localhost` round-trip
  - `python3` multi-line def
  - `node` multi-line
  - `psql` (optional if local)
  - `git log | less | head`
  - `yes | head -c 1G`
  - `find / 2>/dev/null` (timeboxed)
  - `clear`, resize cycles
  - copy/paste within grid
  - Korean 2-set IME recorded corpus
  - Japanese IME recorded corpus
- ε2. Perf budgets in CI:
  - `top -d 0.1` 60 s: P99 frame < 16 ms, RSS < 150 MB
  - `watch -n 0.05 date` 60 s: same
  - Resize cycle: < 16 ms average
  - Keystroke → PTY byte latency: P99 < 2 ms
  - Memory cap: 1 GB output contained within 150 MB RSS
- ε3. Byte-accounting test: feed counter at `VtEmulator.feed` vs sidecar emit counter must match exactly in all non-emergency compat runs.
- ε4. Resize race: 100 resize operations under streaming load; grid remains consistent.
- ε5. DPR switch: simulated DPR change mid-session; atlas invalidates; no visual artifacts.

**Exit gates**:
- E-ε-01 All compat matrix rows green on macOS + Linux.
- E-ε-02 CI perf job enforces budgets on every PR.
- E-ε-03 Byte-accounting exact match on all non-emergency tests.

---

## 5. P0 rollout ordering

```
        ┌─────────────────────┐
        │ Epic α — VT engine  │  (ships first; buffers, scrollback)
        └──────────┬──────────┘
                   │
         ┌─────────┼─────────┬─────────────┐
         ▼         ▼         ▼
    ┌────────┐ ┌───────┐ ┌──────────┐
    │Epic β  │ │Epic γ │ │Epic δ    │
    │ Input  │ │Render │ │No-SI path│
    └────┬───┘ └───┬───┘ └────┬─────┘
         │         │          │
         └─────────┴────┬─────┘
                        ▼
                ┌───────────────┐
                │ Epic ε —      │
                │ Compat matrix │
                └───────────────┘
```

Strict sequence: α first. β, γ, δ parallel. ε last and gates ship.

No flag ramps for the P0 unification — P0 IS the default. Partial landing is not a ship state.

---

## 6. P1 — Block UX + integration authority (after P0 green)

Once P0 ships, block UX lands as an **opt-in presentation layer**. P1 is a separate rollout gate; nothing below starts until P0 `ε` passes.

### P1 epics (outline only — detailed spec when P0 passes)

- **P1-A. Hybrid boundary detector** — OSC 133 primary, heuristic (prompt-regex, cursor-home) secondary, idle tertiary. Confidence-stamped. Moved from v2 §4 Epic A.
- **P1-B. Shell integration auto-install** — opt-out, with failure banner. Moved from v2 §4 Epic A item A5.
- **P1-C. Block overlay chrome** — absolutely-positioned cards over grid row ranges. Moved from v2 §4 Epic B items B4-B6.
- **P1-D. Mode-stack polish** — pager hint, tmux depth-aware mouse, REPL continuation. Moved from v2 §4 Epic D.
- **P1-E. Session restore** — replay events journal on reload → GridSnapshot restore.
- **P1-F. Output search across scrollback** — grid-wide, not block-local.
- **P1-G. Pager / REPL ghost hints** — "press q to quit" affordance.

Each P1 epic is independently feature-flagged. Users can opt into block UX without opting into REPL hints, etc.

---

## 7. P2 — Execution surface (parked)

All of these were v2 content. Marked parked — referenced for continuity but not scheduled. Nothing here ships until P0 and a full P1 generation are on the ground.

- **P2-A. Run entity** (v2 Epic F) — `Run` as first-class lifecycle. Block becomes a projection. Enables agent / task / replay in the same surface.
- **P2-B. Intent layer** (v2 Epic G) — meaning-typed user + agent actions. AI / safety / rewriter hooks.
- **P2-C. Priority-classified output + priority backpressure** (v2 Epic H) — `control` / `visible` / `scrollback` / `verbose` classes. Only possible once `control` events (OSC 133) are actually being produced reliably (P1).
- **P2-D. Structured output types** (`table`, `progress`, `json-stream`, `binary`) — render hints on a Run.
- **P2-E. Agent tool-call surface** — agent invocations render as Runs with type-discriminated chrome.
- **P2-F. Per-run resource usage** — CPU / mem / net sampled from sidecar.
- **P2-G. Replay UX** — replay CLI mounts replay Runs into UI.

All P2 items are documented (§10) but not in the P0 ship path.

---

## 8. Breaking changes (P0 scope only)

- **`block.outputChunks` field is dead in the default path.** No reader should depend on it in P0. Any remaining consumer is either disabled (block UI hidden) or migrated to grid row-range queries.
- **BlockList / BlockCard are not in the default UI.** They move to a flag-gated experimental P1 view.
- **`submitCommand` is not the write path.** Composer Enter emits bytes through input-host. For P0 this may simply mean "remove the Composer widget" since there is no block boundary concept.
- **`AnsiParser` is not in the default render path.** The VT engine owns all terminal semantics. AnsiParser remains for static text rendering in non-terminal widgets (history preview, export dialogs).
- **400 ms idle heuristic is deleted from P0 code.** No fallback block-close exists because there is no block concept in P0.
- **Alt-screen binary store (`useAltScreenMode`) remains in P0** but collapses to a thin wrapper around `VtEmulator.isAltBuffer()` — single source of truth is the engine.
- **`TuiInputSurface` is deleted.** Replaced by always-on `SessionInputSurface`.
- **`TuiRenderSurface` is replaced by `TerminalSurface` — the default grid paint surface always active.** Alt-screen transitions are invisible at the surface level; they're just buffer swaps inside the engine.

---

## 9. Risk register (P0)

| Risk | Lik | Imp | Mitigation |
|------|-----|-----|-----------|
| R-1 Removing BlockList from default UI creates a regression for users relying on block copy/rerun | high | med | Ship P0 → P1 sequentially; users see "plain terminal" P0 only if on the dev channel; block UX lands in P1 before public release |
| R-2 Always-on SessionInputSurface breaks IME flows that relied on composer | high | high | IME state machine reused with recorded corpora; regression-gated |
| R-3 Scrollback eviction drops a row the user was reading | low | med | Eviction is append-side (oldest first); viewport rows never touched; pause-on-scroll-up eviction pause (1 s debounce) |
| R-4 Frame-skip under flood causes the user to see stale data | high | med | Banner "rendering delayed N ms" when behind; exact byte delivery remains |
| R-5 Sidecar flow-control not available on all platforms | med | med | Emergency drop path for platforms without SIGSTOP-on-master; documented; measured |
| R-6 Resize re-flow produces different wrap than xterm | med | high | Golden compat corpus with wrap edge cases; bit-compare |
| R-7 Compat matrix corpus incomplete; real users hit gap | high | high | Dogfood internal engineering team for 2 weeks before public; add every found break to corpus |
| R-8 tmux-in-tmux depth-3 mouse reaches wrong layer | med | med | Test fixture for depth 3; mouse DECSET mode arbitration; documented resolution rule |

---

## 10. Instrumentation (P0)

- `quanta.engine.feed_bytes_total` — raw PTY bytes into VtEmulator
- `quanta.engine.feed_latency_p99_us` — feed() duration
- `quanta.engine.alt_buffer_active{0|1}` — gauge
- `quanta.engine.resize_count`, `quanta.engine.resize_duration_p99_ms`
- `quanta.render.frame_budget_p99_ms`
- `quanta.render.damaged_rows_per_frame_p99`
- `quanta.render.skipped_frames_total` — frame-skip policy counter
- `quanta.input.keystroke_latency_p99_us`
- `quanta.input.mouse_report_total{mode=1000|1002|1003|1006}`
- `quanta.input.ime_commit_rate`
- `quanta.scrollback.ring_utilization_ratio`
- `quanta.scrollback.eviction_rows_s`
- `quanta.backpressure.queue_bytes` — gauge
- `quanta.backpressure.flow_control_engaged_total` — sidecar SIGSTOP counter
- `quanta.backpressure.emergency_drop_total` — last-resort drop counter (should be 0)

---

## 11. Spec deltas (P0, ADR-level)

- **ADR 0019 (new)** — Scrollback ring contract (was v2 ADR 0021 "scrollback"; promoted to P0 foundation).
  - Cap (default 10,000 rows), main-only, running-block row pinning, eviction policy.
- **ADR 0020 (new)** — Frame-skip backpressure policy (was v2 ADR 0024 "priority BP"; simplified for P0).
  - Frame-skip primary, sidecar SIGSTOP secondary, emergency drop tertiary. No per-class priority in P0 (deferred to P2).
- **Update ADR 0009 (Input routing policy)** — session-scoped always-on input-host; drop "alt-screen-gated" clause.
- **Update ADR 0002 (Execution boundary contract)** — explicit "no boundaries in P0 default"; boundaries are a P1 layer.
- **Update RFC 0001 §2.3 ("Interaction truth")** — note that selection / search / copy semantics in P0 are grid-scoped (no block concept).

Deferred to P1/P2:
- ADR 0021 Hybrid boundary
- ADR 0022 Auto-install
- ADR 0023 Run entity
- ADR 0024 Intent router
- ADR 0025 Priority classes
- ADR 0026 Mode Stack

---

## 12. Success definition (P0)

P0 is done when all of the following hold:

1. **Zero** `block.outputChunks` accesses in the default rendering path. CI grep rule `no-block-chunks-in-render` passes.
2. **Zero** paths from any React component other than `SessionInputSurface` to `bridge.write`. CI grep rule `one-input-path` passes.
3. **Zero** ANSI parsing outside the VT engine in production code paths. CI grep rule `one-render-path` passes.
4. DEC 1049/1047/47 are fully implemented and tested in `VtEmulator.ts` (G-VT-01 closed).
5. Scrollback ring is live with configurable cap, running-row pinning, and eviction telemetry.
6. Compat matrix §1 green on macOS + Linux.
7. Perf budgets (Epic ε2) green in CI.
8. `vim` round-trip: byte-exact main buffer restore across 100 transitions.
9. Korean 2-set IME byte-identical to recorded corpus.
10. `yes` + `tail -f` + `watch` run for 60 s without OOM and without data loss under standard load.
11. Sidecar flow-control engages before last-resort drop in load test.
12. The default UI after a fresh session spawn is a plain terminal grid — no block chrome, no cards, no +Tag pills, no "install shell integration" banner, no mode chip.

Only when all 12 are green does the plan move to P1.

---

## 13. Files (P0)

**Rewrite:**
```
packages/ui/src/features/session/connect.ts
  - Install single VtEmulator per session
  - Feed bytes through WriteBatcher → VtEmulator
  - Stop calling blockStore.startBlock in P0 default

packages/ui/src/shared/lib/vt-emulator/VtEmulator.ts
  - Implement 1049/1047/47 main↔alt buffer swap
  - Add scrollback ring with eviction policy

packages/ui/src/shared/lib/write-batcher.ts
  - Frame-skip policy
  - Sidecar flow-control hook
  - Byte-frame boundary preservation

packages/ui/src/features/command/route-output.ts
  - Disabled in P0 (block boundaries are P1)

packages/ui/src/features/command/execute.ts
  - submitCommand becomes a no-op in P0 default
  - Delete idle-heuristic + fake exit code path

packages/ui/src/pages/terminal-page/TerminalPage.tsx
  - Mount SessionInputSurface + TerminalSurface
  - Unmount BlockList / Composer in P0 default (flag-gated)
```

**Delete (or gate behind P1 flag):**
```
packages/ui/src/features/tui/TuiInputSurface.tsx      → replaced by SessionInputSurface
packages/ui/src/features/tui/TuiRenderSurface.tsx     → replaced by TerminalSurface
packages/ui/src/widgets/block-list/                    → P1 flag-gated
packages/ui/src/widgets/block-card/                    → P1 flag-gated
packages/ui/src/widgets/composer/                      → P1 flag-gated (not needed when grid is the primary surface)
packages/ui/src/features/preamble/                     → n/a, grid renders it natively
```

**New:**
```
packages/ui/src/features/session/SessionInputSurface.tsx
packages/ui/src/features/session/TerminalSurface.tsx
packages/ui/src/shared/lib/scrollback-ring.ts          (possibly embedded in VtEmulator)
packages/ui/src/shared/lib/frame-skip-batcher.ts
packages/host-tauri/src-tauri/src/flow_control.rs      (sidecar SIGSTOP hook)
docs/adr/0019-scrollback-ring.md
docs/adr/0020-frame-skip-backpressure.md
```

---

## 14. What this plan is NOT

- It is **not** a plan to build an execution-typed Agent OS surface. That exists in P2.
- It is **not** a plan to ship a Warp competitor. Block UX ships in P1 on top of a working terminal.
- It is **not** a ROI-optimized plan. The whole point is "do this right, then build on top."
- It is **not** an xterm.js feature-parity plan. We already have the RFC 0001 path for that. Plan 0005 P0 is the unification + productization gate for that work.

---

## 15. Architectural glossary

- **Grid** — the 2D cell model inside `VtEmulator` / `GridMirror`. The SSOT.
- **Scrollback ring** — bounded circular buffer of past rows owned by main buffer only.
- **SessionInputSurface** — the single always-mounted DOM sink for keyboard / mouse / paste / focus / IME.
- **TerminalSurface** — the single always-mounted canvas surface painting the grid.
- **Alt buffer / main buffer** — xterm convention; engine swaps between them on DECSET 1049/1047.
- **Frame-skip** — backpressure policy that delays paint, never drops bytes (default).
- **Emergency drop** — last-resort eviction when memory > 256 MiB AND sidecar flow-control unavailable.
- **P1 opt-in** — block UX flag (`flag.blockUx`). When off, P0 plain terminal. When on, chrome overlays over grid.

---

## 16. Why v3 demotes Run / Intent / Priority classes to P2

v2 of this plan fused **"unify the engine"** with **"build an execution surface on top"**. The feedback is correct: those are two different products.

v3 says: **ship the terminal first**. A terminal that is xterm-replaceable at the compat matrix level (§1). Without blocks, without Runs, without Intents. Just a correct VT implementation with a correct input path and a correct render path.

After that ships, P1 adds the block presentation on top (now trivially — chrome overlays over row ranges; one more React layer with zero byte-path risk).

After that, P2 lifts block into Run, keyboard into Intent, and the terminal becomes an execution surface. But that sits on top of a *working terminal*, not instead of one.

The one-line summary: **P0 makes xterm replaceable. P1 makes Warp replaceable. P2 makes terminals themselves replaceable.** Each layer assumes the previous is done.

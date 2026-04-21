# Plan 0005 — Gap Tracking Matrix

- **Status**: Live (updated per epic landing)
- **Reads**: Gap ledger from [README.md §3](./README.md#3-gap-ledger-expanded)

---

## Status legend

- `todo` — not started
- `wip` — agent / dev assigned; code in flight
- `review` — PR open, tests green
- `landed` — merged into main, tests enforce
- `deferred` — moved to P1 / P2

---

## P0 gaps (ship-blocking)

| Gap | Epic | Sev | Status | Owner | Notes |
|-----|------|-----|--------|-------|-------|
| G-VT-01 | α | crit | review | Agent-A ✓ | `VtEmulator.ts` 1049/1047/47 full impl + 12 altbuffer tests; 143/143 + 394 adjacent pass. Staged. Main/alt buffer + savedState1048 distinct from DECSC; mode event ordering preserved; resize clears alt per xterm; dynamic `buffer_kind` in envelopes |
| G-VT-02 | α | crit | review | Agent-D ✓ | `Scrollback` ring (default 10,000 rows) main-buffer only; pin hook for P1 block boundaries; 10 tests; 153/153 total vt-emulator green. Staged |
| G-IN-01 | β | crit | review | Agent-G ✓ | Always-on `SessionInputSurface` replaces `TuiInputSurface`; KeymapGuard isolates UI shortcuts |
| G-IN-02 | β | crit | review | Agent-G ✓ | Ctrl+C/D/L/R now native through encoder |
| G-IN-03 | β | crit | review | Agent-G ✓ | readline/ZLE passthrough active — all shell keystrokes reach PTY |
| G-IN-04 | β | high | review | Agent-G ✓ | MouseEncoder now mounted session-scoped (always-on) |
| G-IN-05 | β | high | review | Agent-G ✓ | Focus events 1004 always-on |
| G-IN-06 | β | med | review | Agent-G ✓ | Paste safety moved to `input-host.onPasteGate` |
| G-IN-07 | β | med | review | Agent-G ✓ | IME overlay anchors from engine cursor when available |
| G-RD-01 | γ/δ | crit | todo | — | Block body uses cell renderer (deferred via P1 gate in P0) |
| G-RD-02 | γ | high | review | Agent-B ✓ | `write-batcher-frame-skip.ts` + 13 tests; 29/29 pass. Staged, awaiting merge commit |
| G-RD-03 | γ | high | review | Agent-B ✓ | Data-safe policy: frame-skip → flow-control → emergency drop (boundary-aligned). Byte-frame FSM handles CSI/OSC/DCS/APC/PM |
| G-RD-05 | ε | med | todo | — | DPR mid-session test |

## P0 "ship with graceful behavior" gaps

| Gap | Epic | Sev | Status | Notes |
|-----|------|-----|--------|-------|
| G-SI-01 | δ/P1 | crit | deferred-P1 | Auto-install shell integration is a P1 enhancement (heuristic boundary first) |
| G-SI-02 | δ/P1 | crit | deferred-P1 | OSC 133 to boundary detector is a P1 item |
| G-SI-03..06 | P1 | — | deferred-P1 | All shell-integration enhancements are P1 |
| G-VT-03 | δ | high | landed (simplified) | P0 removes idle heuristic + fake exit; no block boundaries in P0 default |
| G-VT-04..06 | P1 | — | deferred-P1 | OSC 133 wiring, OSC 7 subscription, OSC 8 hyperlink (P1 when block chrome lands) |
| G-MS-01..06 | P1 | — | deferred-P1 | Mode Stack is P1 polish |

## P2 (execution surface) gaps

| Gap | Epic | Sev | Status | Notes |
|-----|------|-----|--------|-------|
| G-EX-01..09 | P2 | — | parked | Run entity work; unscheduled |
| G-IT-01..07 | P2 | — | parked | Intent layer; unscheduled |
| G-BP-01..06 | P2 | — | parked | Priority classes; P0 uses frame-skip + emergency drop |
| G-VT-08 | P2 | med | parked | DCS passthrough for plugin system |

## Compat matrix gaps

| Gap | Epic | Status | Notes |
|-----|------|--------|-------|
| G-CO-01..08 | ε | review | Agents C/H/K ✓ — 6 fixtures shipped: C-ED-01 vim, C-ED-02 nvim+LSP, C-PG-01 less, C-MON-01 top (scrollback zero-leak), C-MUX-01 tmux basic, C-IME-01 KR 2-set render. 24/24 compat tests green. Coverage of required vim/less/top/tmux/IME rows + nvim SGR digest + tmux status-line + wide-cell rendering |

---

## Invariants tracking

| Invariant | CI rule | Status |
|-----------|---------|--------|
| I-11 one render path | `tools/check-one-render-path/` | rule live (warn-report, 9 violations to migrate) |
| I-12 one input path | `tools/check-one-input-path/` | rule live (warn-report, 7 violations to migrate) |
| I-14 scrollback bounded | Scrollback ring in VtEmulator | landed (10,000 default, pin hook reserved for P1) |
| I-13 hybrid boundary | deferred P1 | deferred |
| I-15..17 priority / intent / run | deferred P2 | deferred |

---

## Agent assignments (live)

| Agent | Worktree | Scope | Status |
|-------|----------|-------|--------|
| Agent-A | (merged) | Epic α item α2: VtEmulator alt-buffer + 12 tests | ✓ landed staged |
| Agent-B | (merged) | Epic γ: frame-skip write batcher + 13 tests | ✓ landed staged |
| Agent-C | (merged) | Epic ε: compat harness + C-ED-01 vim round-trip (green post α) | ✓ landed staged |
| Agent-D | (merged) | Epic α3 scrollback ring — main-buffer only, 10,000 cap, pin hook | ✓ landed staged |
| Agent-E | (merged) | CI grep rules × 3 + 30 self-tests | ✓ landed staged |
| Agent-F | (merged) | Epic α1 session-level VtEmulator feed wiring — `engine.ts` + connect.ts + 13 tests | ✓ landed staged |
| Agent-G | (merged) | Epic β — always-on `SessionInputSurface` + KeymapGuard + paste-safety relocation + TuiInputSurface deletion; 1588/1588 session+tui+composer+input green | ✓ landed staged |
| Agent-H | (merged) | Compat fixtures C-PG-01 (less) + C-MON-01 (top) + scrollback assertion harness ext | ✓ landed staged (trailing-space projection fix applied) |

Main thread (this session) is writing planning docs and holding off any VtEmulator / write-batcher / session edits to avoid worktree collision.

---

## Next steps after agent completions

1. Review Agent-A worktree → merge into main (Epic α2 landed). Unblocks: session-level `VtEmulator` wiring (α1), scrollback ring (α3).
2. Review Agent-B worktree → merge into main (Epic γ1–γ6 landed). Unblocks: session ↔ batcher ↔ engine wiring in `features/session/connect.ts`.
3. Review Agent-C worktree → merge into main (compat harness live). C-ED-01 flips from `test.fails` to `test.ok` once α2 is merged.
4. Kick off next parallel batch:
   - Agent-D: Epic α1 (session-level VtEmulator wiring in `features/session/connect.ts`).
   - Agent-E: Epic α3 (scrollback ring inside VtEmulator).
   - Agent-F: Epic β draft (SessionInputSurface rename + mount in TerminalPage).
5. Compat fixture authoring: author C-MON-01 (top), C-PG-01 (less), C-UX-02 (resize) fixtures.
6. CI grep rules (`tools/check-one-render-path/`, `tools/check-one-input-path/`).
7. Epic δ (P0 default gating) — only after α + β + γ are stable.

---

## Risk signals

- If Agent-A's alt-buffer impl breaks an existing AnsiParser / GridMirror test outside VtEmulator, escalate: might need a deeper refactor of mode-event ordering.
- If Agent-B's frame-skip policy degrades perf on small writes (single-byte-enqueue case), revisit: may need a fast-path for queue < 1 KiB.
- If Agent-C's compat harness can't deterministically replay because of `VtEmulator` nondeterminism (e.g. timer-based behaviors), refactor the engine to accept an injected `clock()` source.

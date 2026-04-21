# CLI App Coverage Improvement Plan

Audit date: 2026-04-21  
Scope: quanta-terminal — full coverage of TUI apps (top, htop, aws cli, less, man, vim, docker stats, fzf, tmux, netstat)

---

## 1. Scenario Matrix

| App | Mode | Alt-screen | Mouse | Tested today | Gap |
|-----|------|-----------|-------|-------------|-----|
| `top` / `htop` | TUI | Yes (1049h) | any_event + SGR | ✅ `top-htop-realtime.e2e` | High-refresh SGR stress (not yet) |
| `aws configure` | Readline | No | None | ✅ `aws-cli-interactive.e2e` (Tab, Ctrl+D, Ctrl+Z, PgUp/Dn, Shift+Tab, Alt+.) | Multi-round prompt flow |
| `aws sso login` | TUI | Yes (picker) | button_event | ✅ `tui-full-flow.e2e` indirectly | Picker arrow navigation |
| `less` / `man` | TUI pager | Yes (1049h) | off → arrow fallback | ✅ `less-pagination.e2e` | Mouse wheel tracking-on path |
| `vim` | TUI editor | Yes (1049h) | button_event | Partial via `tui-full-flow` | DECSCUSR cursor shapes, `:!` subshell |
| `docker stats` | TUI | Yes (1049h) | off | ✅ `top-htop-realtime.e2e` (same path) | ANSI color reset on clear |
| `fzf` | TUI picker | Yes (1049h) | any_event | ✅ `tui-full-flow.e2e` + mouse | Kitty keyboard level 3 |
| `tmux` | TUI mux | Yes (nested) | button_event | `tui-full-flow` (nested depth) | Charset/line-drawing |
| `netstat` / `ss` | Block | No | None | Block pipeline tests | Wide Unicode alignment |
| PTY crash recovery | Any | Yes | — | ✅ `tui-crash-recovery.e2e` | Auto-wire `reportCrash` in TerminalPage |

---

## 2. Newly Added E2E Tests (2026-04-21)

Four test files added to `packages/ui/src/__tests__/e2e/`:

| File | Scenarios | Tests |
|------|-----------|-------|
| `top-htop-realtime.e2e.test.tsx` | 100-frame burst, keyboard mid-burst, ArrowDown/Ctrl+C under load, re-entry, SGR 1006 click | 7 |
| `aws-cli-interactive.e2e.test.tsx` | Tab, Ctrl+D, Ctrl+Z, PgUp/Dn, Shift+Tab, Alt+., bracketed-paste invariant, sequential tabs | 9 |
| `less-pagination.e2e.test.tsx` | Space/b/g/G///n/N/q/Home/End encoding, wheel→arrow fallback, 'q' full teardown | 12 |
| `tui-crash-recovery.e2e.test.tsx` | reportCrash + exit, clearCrashed, stray-exit clamp, recovery re-enter, nested unwind, page integration | 8 |

Total new tests: **36** (400 passing across all 24 E2E files)

---

## 3. Remediation Plan

### Priority 1 — Critical correctness gaps

#### P1-A: Wire `reportCrash` on PTY crash during alt-screen

**What:** `useTuiStore.reportCrash()` API exists but has zero production call sites. When `pty_exit { signal: 'sidecar_crash_recovered' }` arrives while alt-screen is active, the TerminalPage should call `reportCrash(reason)` and schedule `clearCrashed()` after 2 seconds.

**Where:** `packages/ui/src/pages/terminal-page/TerminalPage.tsx` — the effect that handles the `pty_exit` event (near line 692 where `sidecar_crash_recovered` is mentioned).

**Contract:**
```ts
// On sidecar crash while TUI is active:
useTuiStore.getState().reportCrash('sidecar_crash_recovered');
setTimeout(() => {
  useTuiStore.getState().clearCrashed();
}, ALT_SCREEN_GHOST_FRAME_MS);
```

**Risk:** Low — store API is already correct; only the caller is missing.

---

#### P1-B: IME overlay in TuiInputSurface

**What:** `TuiInputSurface` mounts an input-host but does not wire `onOverlayUpdate`. CJK users composing characters while in a TUI app (vim insert-mode, fzf search) see no preedit overlay, breaking the ime flow that works in the Composer.

**Where:** `packages/ui/src/features/tui/TuiInputSurface.tsx`

**Fix:** Add an `onOverlayUpdate` callback to the input-host `mount()` call that positions the IME overlay relative to the TUI cursor cell. The GridMirror's `getCursor()` supplies the cell coords; `cellToScreen` from the TerminalCanvas handle converts them to pixels.

**Risk:** Medium — requires a prop channel from TuiRenderSurface to TuiInputSurface for the cursor position.

---

#### P1-C: Ghost-frame timeout is unspecified

**What:** The `reportCrash` → `clearCrashed` delay (the "ghost frame" that freezes the TUI surface briefly after a crash) has no canonical constant. Tests assume 2 s but the implementation has no `ALT_SCREEN_GHOST_FRAME_MS` export.

**Fix:** Export `const ALT_SCREEN_GHOST_FRAME_MS = 2000` from `entities/tui/model.ts` and use it in both `TerminalPage` and tests.

**Risk:** None.

---

### Priority 2 — Medium-term improvements

#### P2-A: DECSCUSR soft cursor shapes

**What:** The VtEmulator and GridMirror carry a `cursor.shape` field (`block` | `bar` | `underline`). The TerminalCanvas does not yet render anything other than block. Vim changes cursor shape between normal/insert/replace modes via `\e[1q`..`\e[6q`.

**Where:** `packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx` — canvas cursor draw path.

**Fix:** Read `mirror.getCursor().shape` in the canvas repaint loop and draw a bar (2 px wide) or underline (2 px tall) instead of the full cell block.

**Risk:** Low visual-only change; no impact on byte routing.

---

#### P2-B: Mode-sync from VtEmulator to stub mirror in TuiInputSurface

**What:** `TuiInputSurface` creates a `createStubMirror()` with static defaults. When the TUI app sends DECSET 1000 (button tracking) or DECSET 7727 (DECCKM), the stub mirror never updates. This means:
- Mouse clicks in `htop` are sent as button-tracking SGR only if the stub was pre-initialized correctly.
- Arrow keys in `vim` use DECCKM-off sequences even after `vim` enables DECCKM.

**Fix:** Wire the `GridMirror.applyMode` (from `ModeChanged` envelopes) to update the live `ModeSnapshot` used by `TuiInputSurface`'s input-host. The TuiRenderSurface already receives `ModeChanged` via the `GridEventEnvelope` stream — forward mode changes to a shared `createStubMirror` that TuiInputSurface also reads.

**Risk:** Medium — requires a shared state object between the two surfaces.

---

#### P2-C: Double-click word selection in TUI

**What:** The TerminalCanvas `SelectionManager` supports character/word/line selection modes (`begin(anchor, 'word')`), but `TuiRenderSurface` does not wire `dblclick` → word selection. Users expect double-click to select a process name in `htop` or a path in `vim`.

**Fix:** Add a `dblclick` handler in `TuiRenderSurface` that calls `selection.begin(cell, 'word')` and fires `selection.extend(cell)`.

**Risk:** Low.

---

#### P2-D: Scrollback restore on alt-screen exit

**What:** When `less` or `vim` exits (EXIT_1049), the TerminalCanvas scrollback position is not restored to where the user was before the pager launched. Standard terminals (xterm, iTerm2) restore the pre-TUI scroll position on 1049l.

**Fix:** Before mounting TuiRenderSurface, snapshot the scrollback offset from the main-buffer GridMirror. On EXIT_1049, restore it via an imperative call on the TerminalCanvas ref.

**Risk:** Medium — requires the scrollback model (currently unimplemented per RFC §12 note).

---

### Priority 3 — Low priority / future

#### P3-A: VT100 charset switching (line-drawing for tmux/netstat)

**What:** `tmux` and `netstat` use VT100 G0/G1 charset switching (DEC special graphics: `\x0f`/`\x0e` + `\x1b(0`/`\x1b(B`) to draw box-drawing characters. The VtEmulator does not implement charset translation — cells get literal `q`/`x`/`j` instead of `─`/`│`/`┘`.

**Fix:** Add G0/G1 charset slots to `VtEmulator` state. When `DEC_SPECIAL` is active (`\x1b(0`), map printable characters through the VT100 line-drawing table before storing in the grid.

**Risk:** Medium — isolated to the VtEmulator; no UI impact beyond rendering fidelity.

---

#### P3-B: Kitty Keyboard Protocol levels 4 and 5

**What:** The `KeyEncoder` supports Kitty levels 1–3. Levels 4 (report all key events) and 5 (associate text with key events) are not implemented. `fzf` with `TERM=xterm-kitty` can request level 4 for accurate modifier handling.

**Fix:** Extend `KeyEncoder.encode()` to emit `key_event_type` and `associated_text` fields in the Kitty response when `kittyKeyboard >= 4`.

**Risk:** Low — additive change; no existing tests would regress.

---

#### P3-C: OSC 52 clipboard write-through

**What:** The GridMirror correctly receives `clipboard_request` envelopes (see `osc-clipboard-title-marks.e2e.test.tsx`) but no consumer calls `navigator.clipboard.writeText()`. TUI apps that use OSC 52 to set the clipboard (e.g., `tmux` copy mode) silently succeed at the mirror layer but the system clipboard is never written.

**Fix:** Add a consumer in `TuiRenderSurface` that calls `navigator.clipboard.writeText()` after a policy prompt when it sees `clipboard_request` with operation `set`.

**Security note:** Require a user confirmation dialog before any remote write (compromised PTY → system clipboard hijack). Gate behind `capabilities.clipboardWrite`.

**Risk:** Medium — security-sensitive; must not auto-write without consent.

---

## 4. Known pre-existing test infrastructure gaps

| Area | Status |
|------|--------|
| `paste-ime-ordering.test.ts` line 150 — `exactOptionalPropertyTypes` error | Pre-existing, unrelated to CLI coverage |
| `Tooltip.test.tsx` line 134 — CSS module inline import | Pre-existing, unrelated |
| `embedded_shell.rs` Phase 1 PTY stub | Marked for removal; real PTY via `portable-pty` is production path |
| OSC 133 prompt marks (`prompt_mark` envelope) | No envelope kind exists; commented in `boundary-detector.ts` as Phase 2 |

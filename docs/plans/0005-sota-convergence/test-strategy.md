# Plan 0005 — Test Strategy & Compat Matrix

- **Status**: Draft v1 (2026-04-21)
- **Applies to**: P0 epics α / β / γ / δ / ε
- **Ship gate**: all tables here green on macOS + Linux in CI

---

## 0. Philosophy

Three-tier test strategy, no shortcuts:

1. **Unit** — pure-function tests on the VT engine, encoders, scrollback ring, write-batcher. Fast (< 5 s per file).
2. **Integration** — component tests that mount `SessionInputSurface` + `TerminalSurface` against a mock bridge. jsdom + React Testing Library.
3. **E2E / Compat** — golden-stream fixture tests. Feed a recorded PTY byte stream into the real engine pipeline, compare the resulting `GridSnapshot` to a committed expected snapshot. Also perf-budget enforced.

Every P0 exit gate has at least one test on each tier it spans.

---

## 1. Compat Matrix (the north star)

Every row below ships with:
- A recorded PTY byte stream (`fixtures/compat/<name>.bytes`).
- An expected `GridSnapshot` at key checkpoints (`fixtures/compat/<name>.checkpoints.json`).
- A golden `Run` outline where applicable (exit code, duration-within-tolerance).

Tests live at `packages/ui/src/__tests__/compat/<name>.test.ts`.

| ID | Category | Scenario | Checkpoints |
|-----|----------|----------|-------------|
| C-SH-01 | shell | bash: `ls`, `cd /tmp`, `pwd`, `echo $?` | cwd reports `/tmp`; prompt boundaries present |
| C-SH-02 | shell | zsh: default prompt + 100-char hostname | wrap behavior matches xterm |
| C-SH-03 | shell | fish: autosuggest visible | ghost text renders as bright-black; Tab accepts |
| C-ED-01 | editor | vim: open 1000-line file, navigate, save, quit | alt-buffer enter, scroll, exit → main buffer restore byte-exact |
| C-ED-02 | editor | nvim: LSP-enabled edit with diagnostics overlay | alt buffer + status line re-render |
| C-ED-03 | editor | `vim :!bash` nested shell | modestack push/pop; inner bash prompt renders |
| C-PG-01 | pager | `less /etc/passwd` + `j j j` + `/` search + `q` | alt-buffer enter, scroll, search highlight, exit → restore |
| C-PG-02 | pager | `man git-log` | same as C-PG-01 plus long-line wrap |
| C-PG-03 | pager | `more /etc/hosts` | single-screen pager; space to continue |
| C-MON-01 | monitor | `top` for 30 s | 60 Hz paint, < 16 ms P99, < 150 MB RSS |
| C-MON-02 | monitor | `htop` 30 s + `q` | same + alt-buffer exit restores |
| C-MON-03 | monitor | `watch -n 0.1 date` 60 s | steady 10 Hz repaint, no layout jitter |
| C-MUX-01 | mux | `tmux new`, split horizontal, split vertical, attach/detach | prefix C-b passes through outermost; inner tmux renders |
| C-MUX-02 | mux | `tmux-in-ssh` depth 2 | mouse click reaches inner tmux via DECSET 1006 |
| C-MUX-03 | mux | `tmux-in-ssh-in-tmux` depth 3 | mouse click reaches innermost; prefix reaches outermost |
| C-NET-01 | network | `ssh localhost echo hi` | round-trip renders; no corruption |
| C-NET-02 | network | remote bash over ssh with `cd /etc; ls` | cwd tracked via OSC 7 if integration injected, else heuristic |
| C-RP-01 | repl | `python3`: `def foo():` → indented block → `foo()` | continuation prompt tagged; single run |
| C-RP-02 | repl | `node`: multi-line paste | bracketed paste wraps; shell accepts |
| C-RP-03 | repl | `psql -l` (skipped if no local psql) | table render |
| C-COMB-01 | combinator | `git log \| less \| head -20` | pipe + pager; less exits via head closing stdin |
| C-COMB-02 | combinator | `find / 2>/dev/null` | sustained output; no UI freeze > 100 ms |
| C-COMB-03 | combinator | `yes \| head -c 1G` | 1 GB output; scrollback ring evicts; < 150 MB RSS |
| C-UX-01 | ux | `clear` | grid clears to viewport; scrollback retained |
| C-UX-02 | ux | resize 200×50 → 80×24 → 200×50 (10x) | each resize < 16 ms; main buffer reflows; alt clears per xterm |
| C-UX-03 | ux | copy/paste: select rows, Cmd+C, Cmd+V | grid selection → clipboard → bracketed paste → rendered |
| C-UX-04 | ux | split pane: Cmd+D, Cmd+Shift+D, Cmd+\ | two independent grids; focus cycles |
| C-IME-01 | ime | Korean 2-set: "안녕하세요" | recorded corpus byte-identical |
| C-IME-02 | ime | Japanese IME: "こんにちは" via romaji | recorded corpus byte-identical |
| C-IME-03 | ime | Chinese pinyin: "你好" | recorded corpus byte-identical |
| C-IME-04 | ime | dead-key (European): `é` via `'` + `e` | recorded corpus byte-identical |
| C-STRESS-01 | stress | `tail -f /dev/urandom \| base64` 30 s | frame-skip engages; no OOM; no dropped bytes |
| C-STRESS-02 | stress | `cat 100mb.log` | scrollback eviction; 150 MB cap |
| C-STRESS-03 | stress | DPR change mid-session (1x → 2x → 1x) | atlas invalidates; no artifacts |

### Acceptance

- **P0 ship = 100% green**, no skips, no "expected failure" stamps (unless explicitly platform-gated, e.g. psql).
- Windows: known-partial per RFC 0001 Epic K. Separate gate.

---

## 2. Unit test surfaces

### 2.1 VtEmulator

New test files / expansions for Epic α:

- `__tests__/altbuffer.test.ts` — 1049/1047/47 entry/exit correctness (new)
  - vim fixture: enter-1049 saves main buffer; write to alt; exit-1049 restores main byte-exact.
  - Cursor position saved/restored on 1049 / 1048.
  - Alt-buffer cleared on 1047 entry.
  - Mode emit order: `ModeChanged{altScreen=true}` fires BEFORE first alt-buffer `GridDelta`.
- `__tests__/scrollback.test.ts` — new
  - Ring cap (10,000 rows default) honored.
  - Eviction policy: oldest row first.
  - Running-block pin: eviction refuses to cross pinned row.
  - Alt-buffer writes NEVER enter scrollback.
  - Scroll-up from main buffer appends to ring.
  - Resize reflow preserves scrollback content.
- `__tests__/resize.test.ts` — expand existing
  - 200×50 → 80×24 main buffer reflow: all text preserved, wrap re-computed.
  - Same resize on alt buffer: alt clears (xterm behavior).

### 2.2 Write-batcher (Epic γ)

- `__tests__/frame-skip.test.ts` — new
  - Frame-skip engages when render budget > 16 ms: verify paint deferred while bytes still flow into engine.
  - Byte-frame boundary preservation: CSI split across chunks never drops; OSC split never drops.
  - Sidecar flow-control hook invoked at soft cap (128 MiB).
  - Emergency drop ONLY at hard cap (256 MiB) AND flow-control unavailable.
  - Byte-accounting: bytes-in equals bytes-out (unless emergency drop, counted).

### 2.3 Input host (Epic β)

- `__tests__/always-on.test.ts` — new
  - `SessionInputSurface` mounted outside alt-screen: Ctrl+C encodes `\x03`, delivered to bridge.
  - Tab completion: Tab emits `\t` in non-alt-screen mode.
  - Focus: blur emits DSR 1004 focus-out when mode is on.
  - Paste large payload: `onPasteGate` fires with full text.

### 2.4 IME (Epic β carry-over)

Existing corpora (`kr-2set`, `jp-ime`, `cn-pinyin`, `deadkey`) must pass unchanged after session-scoped input-host migration. No new tests; regression gate only.

---

## 3. Integration tests (jsdom + RTL)

Covered tests (new or rewritten):

| Test | Epic | Purpose |
|------|------|---------|
| `__tests__/integration/terminal-surface.test.tsx` | α + β | Mount `<TerminalSurface />` + `<SessionInputSurface />` against mock bridge; feed bytes; verify grid state. |
| `__tests__/integration/no-block-ui-p0.test.tsx` | δ | P0 default renders plain grid; no BlockCard / Composer / ShellIntegrationBanner in DOM. |
| `__tests__/integration/alt-screen-transition.test.tsx` | α | Rewrite existing: DEC 1049h / 1049l swap buffers; `SessionInputSurface` stays mounted; chrome opacity unchanged. |
| `__tests__/integration/resize-streaming.test.tsx` | γ | Resize under live byte stream: no dropped bytes; reflow completes < 16 ms. |
| `__tests__/integration/frame-skip-under-load.test.tsx` | γ | Synthetic 50 MiB/s; paint frames skipped; grid ultimately consistent. |

---

## 4. E2E / Compat fixtures (recorded streams)

### 4.1 Fixture format

Each compat entry produces two files:

```
fixtures/compat/<id>/
  input.bytes              # raw PTY bytes as emitted by real shell session
  checkpoints.json         # array of { at_byte_offset, expected_snapshot }
  meta.json                # { shell, cols, rows, env, description }
```

Where `expected_snapshot` is a structural `GridSnapshot` projected to a stable hashable form (grapheme per cell + SGR tuple + cursor row/col). NOT pixel snapshots — those diverge on font anti-aliasing.

### 4.2 Recording tool

A new CLI `tools/compat-record`:

```
$ tools/compat-record --shell zsh --cols 80 --rows 24 \
    --out fixtures/compat/C-ED-01 \
    -- vim /tmp/sample.txt
```

Runs the command in a real PTY, records bytes + key checkpoints (every 1 s + on mode-change events), writes the fixture bundle. Idempotent — running twice with the same seed produces byte-identical output modulo timestamps, which are stripped at capture time.

### 4.3 Replay harness

`tools/compat-replay`:

```
$ tools/compat-replay fixtures/compat/C-ED-01
✓ 100/100 checkpoints match
  feed rate: 42 MiB/s
  paint P99: 11.3 ms
```

Integrated into CI as `pnpm --filter @quanta/ui test:compat`.

### 4.4 Updating a fixture

Fixture divergence is a test failure by default. To update:

```
$ tools/compat-replay fixtures/compat/C-ED-01 --update
```

Produces a diff the reviewer must sign off on. No auto-update in CI.

---

## 5. Perf harness (Epic ε / γ)

### 5.1 Budgets

| Metric | Budget | How measured |
|--------|--------|--------------|
| Frame paint P99 | 16 ms | `performance.measure` wrapping `Renderer.paint()` |
| Keystroke → PTY byte P99 | 2 ms | Test-only timestamp bracket around `encodeKey → write` |
| Resize duration | 16 ms avg, 32 ms P99 | `performance.measure` on `VtEmulator.resize()` |
| Memory steady-state | 150 MB RSS | `process.memoryUsage()` sampled every 1 s during 60 s monitor fixture |
| VtEmulator.feed() CPU per 1 KiB | 0.5 ms P99 | Microbenchmark |

### 5.2 CI enforcement

`pnpm test:perf` runs per PR against a fixed fixture set:

- `top -d 0.1` 60 s: C-MON-01 budget
- `watch -n 0.1 date` 60 s: C-MON-03 budget
- `yes \| head -c 1G`: C-STRESS-02 budget
- Resize cycle: C-UX-02 budget

Budget violations block the PR. Regressions within 10% of budget emit a warning but pass.

### 5.3 Flake policy

Perf budgets assumed on a 4-core Linux runner (GitHub Actions `ubuntu-latest`). macOS runner budgets are +20% (hardware variance). Tests run 3 times; median is the judgement metric. Two-of-three below budget = pass.

---

## 6. Byte-accounting (invariant enforcement)

Every compat test instruments:

- `input_bytes_total` at the PTY → batcher boundary.
- `feed_bytes_total` at `VtEmulator.feed()`.
- `dropped_bytes_total` (emergency only).

Assertion: `input = feed + dropped`. Any mismatch = critical failure. In P0 happy path, `dropped = 0`.

---

## 7. Golden corpus authoring policy

- Each compat fixture authored by recording a REAL shell session. No synthetic bytes.
- Recordings committed under `fixtures/compat/<id>/input.bytes`.
- Any change to an existing fixture requires an ADR update if it changes terminal semantics, or an explicit comment + reviewer signoff if it's recording noise (e.g. timestamp drift).
- New shell versions may re-record; the expected snapshots are recomputed deterministically.

---

## 8. Test debt we carry in

Existing tests in `packages/ui/src/__tests__/e2e/` (see §0 survey) mostly assert the LEGACY path (BlockCard rendering, Composer submit semantics). P0 breaks that path.

Migration policy:
- Tests that assert terminal behavior (keystroke → byte, alt-screen, resize, IME, paste) are MIGRATED to new `__tests__/integration/` or `__tests__/compat/` directories with rewrites.
- Tests that assert block-UX behavior (BlockCard render, Composer autosuggest, path completion popup) are MOVED to `__tests__/p1-block-ux/` and gated on `flag.blockUx === true`. They remain passing under P1 flag.
- Tests that assert degraded / crash-recovery flows: keep, update mocks for new input-host entry point.
- Pure unit tests (encoders, VtEmulator, GridMirror): keep, extend.

Inventory of moved-to-P1 tests will be tracked in a migration checklist during Epic δ.

---

## 9. Ship checklist (Plan 0005 P0)

- [ ] All 32 compat matrix rows green on macOS + Linux.
- [ ] All perf budgets green in CI.
- [ ] `input_bytes_total == feed_bytes_total` across all non-emergency compat tests.
- [ ] Vim round-trip 100 iterations byte-exact main buffer.
- [ ] IME corpora unchanged after session-scoped migration.
- [ ] CI grep rules pass: `one-render-path`, `one-input-path`.
- [ ] `BlockCard.outputChunks` grep returns zero in default render path.
- [ ] Scrollback ring: eviction observable, pinned rows survive.
- [ ] Frame-skip engaged in stress test; zero non-emergency dropped bytes.
- [ ] DPR change mid-session: atlas invalidates, no artifacts.
- [ ] Default UI after fresh session spawn: plain grid, no block chrome.

Until all twelve hold, P0 does not ship.

# Quanta Terminal Benchmark Protocol

## 0. Purpose

Specify how Quanta is measured against reference terminals (primarily Warp, with Ghostty/WezTerm/VS Code integrated terminal as secondary checks). The goal is a repeatable experiment that produces honest numbers, not marketing screenshots.

## 1. Why This Document Exists

The benchmark-matrix and Warp notes define what to measure and the general posture. They do not specify how to run the experiment. Without that, "we beat Warp" claims rest on vibes. This document defines task corpus, fixtures, environment, user segmentation, and metric definitions.

Opinion: subjective metrics matter for adoption, but objective metrics are what the team can optimize against. Lead with objective, corroborate with subjective.

## 2. Task Corpus

Ten canonical tasks, drawn from the real recovery loops Quanta is built for. Each task specifies the starting state, the action, and the outcome to measure.

### 2.1 Rust compile failure — small

- Start: clean clone of `tokio-rs/mini-redis` (pinned commit).
- Action: introduce a type error in `src/cmd/mod.rs`, run `cargo build`.
- Measure: time from build start to the user landing in the right file/line in the editor.

### 2.2 Rust compile failure — large

- Start: clone of a mid-size Rust repo (candidate: `rust-lang/book` exercises, or an internal fixture).
- Action: trigger 10+ compile errors across 5+ files.
- Measure: time to identify the first actionable failure; time to navigate through all failures.

### 2.3 TypeScript test failure — vitest

- Start: fixture repo with an intentional logic bug.
- Action: `pnpm test`, observe failure.
- Measure: time to editor-open the failing assertion; time to rerun after one-line fix.

### 2.4 Python traceback — multi-frame

- Start: fixture repo with a three-frame stack leading to an exception.
- Action: run the script.
- Measure: time to open the frame the user's own code is in (not the library frame).

### 2.5 Node stack trace — async

- Start: fixture with an unhandled promise rejection.
- Action: run the script.
- Measure: time to the correct source line given async stack complexity.

### 2.6 Long dev server log

- Start: fixture with a dev server producing 5 MB of noisy logs over 10 minutes.
- Action: scroll, search, and find a specific error string.
- Measure: input latency under continuous log ingest; time to search hit.

### 2.7 TUI round trip

- Start: fresh session.
- Action: open `vim`, edit a file, save, quit; then run the edited script.
- Measure: session integrity after TUI exit; time from TUI exit to next command completion.

### 2.8 Rerun and compare

- Start: a failed `cargo test` block.
- Action: edit the offending line, rerun, open compare with the prior run.
- Measure: time from edit save to compare view being readable.

### 2.9 Structured history search

- Start: a profile with 200 pre-seeded historical blocks.
- Action: find the last `cargo clean` in this workspace, then find a log line containing `EADDRINUSE` across any past dev-server block.
- Measure: time to each hit; result ordering quality.

### 2.10 AI suggestion approval

- Start: a natural-language prompt that would generate a destructive command (e.g. "delete all the logs").
- Action: review the suggestion, read the risk label, approve or cancel.
- Measure: time to decision; whether the destructive class was surfaced before the user scrolled.

## 3. Repo Fixtures

All fixtures are public repos pinned at specific commits, or purpose-built fixture repos committed into `benchmarks/fixtures/` in the Quanta repo. Each fixture:

- Has a `SETUP.md` describing the starting state and any seeding (pre-seeded history for task 2.9).
- Is self-contained: no network access required at measurement time beyond what the task inherently needs.
- Is reproducible on macOS arm64, macOS x64, Linux x64.

## 4. Environment

- Hardware profiles: `laptop-a` (M-series MacBook, 16GB), `laptop-b` (Linux x64, 16GB). Both documented in the results file.
- Shells: bash and zsh. fish runs are informational only.
- Terminal-under-test versions pinned and recorded.
- Reference terminals: Warp at the latest stable at benchmark run time; Ghostty, WezTerm, and VS Code integrated terminal as secondary.
- Local network disabled during tasks unless the task requires it (task 2.10's AI flow uses a fixed test endpoint that returns canned suggestions, so the AI provider's own latency is not the variable under test).

## 5. User Segmentation

Two user profiles per run:

- **Novice**: < 1 year of terminal-driven development, unfamiliar with Warp and Quanta. Receives a 10-minute onboarding for both.
- **Experienced**: ≥ 5 years of terminal-driven development, regular terminal user, no prior Quanta exposure.

Minimum cohort size per segment for statistical usefulness: eight. Tasks are randomized in order. Terminal-under-test is counterbalanced across participants to avoid order bias.

## 6. Metrics

### 6.1 Objective

Wall-clock metrics, recorded from instrumented session telemetry where available, observer stopwatch otherwise:

- `failure_identification_time_ms` — from command completion to user verbalizing or clicking the primary failure.
- `error_to_code_time_ms` — from command completion to editor cursor on the correct line.
- `rerun_time_ms` — from edit-save to rerun completion rendered.
- `search_hit_time_ms` — from query entry to correct result selection.
- `input_latency_p95_ms` — keystroke to rendered echo under ongoing output load.
- `session_recovery_time_ms` — from sidecar crash to next usable prompt (Quanta-specific; N/A for reference terminals without comparable feature).

### 6.2 Subjective

Post-task, 1–5 Likert:

- `trust_in_output` — "I believed what the terminal showed me."
- `readability` — "It was easy to find the important information."
- `cognitive_load` — inverse; "I had to think hard to follow what was happening."
- `recovery_confidence` — "I was confident I could recover from errors."

Plus one open text field per task: "What slowed you down?"

### 6.3 Derived

- `error_to_code_delta_vs_warp` — Quanta minus Warp, negative is better for Quanta.
- `rerun_friction_ratio` — Quanta rerun_time / Warp rerun_time.
- `misroute_rate` for AI tasks (see ADR 0009).

## 7. Target Bands

### 7.1 Parity Targets

Quanta must not regress vs Warp on:

- `input_latency_p95_ms` under task 2.6 load.
- Subjective `trust_in_output` on task 2.7 (TUI round trip).
- Subjective `readability` on task 2.1 (small compile failure).

Parity means the Quanta mean is within 10% of Warp's mean in the same cohort, or better.

### 7.2 Superiority Targets

Quanta must clearly beat Warp on:

- `error_to_code_time_ms` — Quanta ≤ 60% of Warp's mean on tasks 2.1, 2.3, 2.4, 2.5.
- `search_hit_time_ms` — Quanta ≤ 50% of Warp's mean on task 2.9.
- Subjective `recovery_confidence` on tasks 2.2, 2.8 — Quanta mean ≥ 1.0 point above Warp.
- AI approval flow: Quanta must surface the risk class before user interaction in 100% of trials on task 2.10; no parallel requirement for Warp's flow.

### 7.3 Explicit Non-Competition

Quanta is not measured on:

- Visual theming or ornament.
- Collaboration or sharing features.
- Any metric that can be gamed without benefiting the recovery loop.

## 8. Protocol Discipline

- Each run produces a signed JSON results file committed to `benchmarks/results/<date>-<cohort>.json`.
- No cherry-picking tasks. A run includes all 10 or it is not a run.
- Warp version and Quanta version are stamped into the results file.
- Participants are debriefed only after the full session to avoid cross-task contamination.
- Every claim that "Quanta beats Warp on X" in external communication must link to a results file.

## 9. Cadence

- Milestone-gated. Each major milestone (Phase 1, Phase 2, etc.) runs the full protocol with both cohorts.
- Between milestones, the team may run subsets locally for regression tracking. Those are not external claims.

## 10. Open Items

- Whether to include a third terminal (Ghostty or WezTerm) as a ceiling-check on pure terminal responsiveness. Opinion: yes, at least for tasks 2.6 and 2.7, since Warp is not the fastest raw terminal.
- Whether to pay external participants for the experienced cohort. Depends on budget and research ethics posture.
- Automated headless variants of the objective-only tasks, for CI regression. Opinion: worth building for tasks 2.1, 2.3, 2.6, 2.9.

## 11. Terminal Protocol Conformance Corpus

Quanta sells terminal trust. Recovery-loop tasks measure the IDE-connected differentiation; they do not, on their own, prove raw terminal correctness. A power user who hits a width bug or a mouse-reporting bug once will not return. This section defines the conformance axis that runs in parallel with the tasks in §2.

### 11.1 Goal

A fixture bank that gives pass/fail signals for protocol and rendering correctness, independent of the user-study tasks. CI runs this bank on every release candidate. Regressions block release.

### 11.2 Fixture Categories

Each category ships with byte-level input fixtures and expected observable state.

- **Unicode and grapheme** — NFC vs NFD, combining marks, flag sequences, family ZWJ sequences, variation selectors, East Asian Width, Hangul syllables.
- **Emoji width** — single-codepoint emoji, ZWJ emoji, skin-tone modifiers, flag pairs. Expected width matches Unicode TR #51 current-year data.
- **Color** — 16-color, 256-color, truecolor, palette shifts, default background handling.
- **Cursor and selection** — cursor save/restore, bracketed paste round-trip, shift-selection in block mode, selection across wrapped lines.
- **OSC 8 hyperlinks** — opening and closing sequences, nested, ID-based grouping.
- **OSC 133 shell integration** — A/B/C/D markers, mixed-shell fixtures, integrations that emit stray markers inside TUIs (ADR 0008 requires these to be ignored).
- **OSC 633** — VS Code shell integration path; compat validation when that host is present.
- **Alternate screen** — `?1049`, `?1047`, `?47` enter/exit, including unclean exit from a killed TUI (ADR 0008).
- **Mouse reporting** — SGR encoding, X10, button encoding, drag, wheel, focus events.
- **Bracketed paste** — paste through `?2004`, paste with embedded ESC, paste inside TUI.
- **Focus reporting** — `?1004` enter/leave events.
- **Scrolling regions** — DECSTBM, scroll up/down, interaction with block rendering boundaries.
- **DECCOLM and resizing** — live resize fidelity under sustained output.
- **ANSI stream parsing** — truncated sequences across chunk boundaries, invalid sequences, CSI parameter limits.
- **Graphics protocol direction** — non-breaking passthrough for kitty graphics (Phase 1 does not render them, but must not corrupt the stream for users piping to another viewer). Full support is a later-phase item.

### 11.3 Fixture Location

`benchmarks/protocol/<category>/` with one subdirectory per test case:

- `input.bin` — raw PTY stream.
- `expected.json` — expected state (grid cells, cursor position, title, OSC link map, mode flags).
- `notes.md` — optional context, upstream spec reference, known quirks.

### 11.4 Pass/Fail Criteria

- Each fixture asserts a concrete observable via the core's debug-snapshot endpoint.
- A fixture passes if the snapshot matches the expected state exactly. Partial credit is not a thing on protocol conformance; either we parse correctly or we do not.
- Fixtures that assert rendering (width, emoji) run through the UI's terminal surface in a headless mode with deterministic font metrics.

### 11.5 Conformance Reference Bar

Quanta's conformance bar, by category:

- Unicode, grapheme, emoji width: meet the same fixtures Ghostty passes. Ghostty is the reference in this space; there is no reason to be worse.
- OSC 8 and OSC 133: meet WezTerm's and Ghostty's behavior; VS Code's OSC 633 path is an additive compat, not a substitute.
- Mouse, bracketed paste, alt-screen, focus: meet xterm reference behavior.
- Graphics protocol: Phase 1 bar is "do no harm" (stream passthrough), not full support.

### 11.6 Cadence and Reporting

- Fixture bank runs in CI on every PR that touches `quanta-pty`, `quanta-output`, or the terminal rendering surface.
- Full bank runs nightly regardless.
- Results emitted to `benchmarks/results/protocol/<date>.json` with per-fixture pass/fail. This is separate from the user-study results in §3–§8.
- A regression on any fixture blocks release.

### 11.7 Maintenance

- Each bug report that describes a protocol or rendering defect yields a new fixture in the same PR as its fix.
- A fixture can be marked `xfail: true` with a linked issue when a defect is known and the fix is scheduled. Xfails are a finite resource; the release review inspects the xfail list every cycle.

Opinion: protocol conformance is the boring part and the part that separates a terminal users trust from one they replace. Keep the corpus dense, keep it green, keep it honest about xfails.

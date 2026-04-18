# Quanta Terminal Benchmark Matrix

> **Protocol:** the operational experiment definition lives in [benchmark-protocol.md](./benchmark-protocol.md). This matrix describes *where* Quanta must compete and against *whom*; the protocol describes *how* runs are executed and measured.

## 0. Purpose

Do not benchmark Quanta against a single fashionable product.

Quanta's evaluation draws from several modern terminal systems and adjacent protocol ecosystems. The goal is a defensible multi-axis comparison, not a single marketing claim.

## 1. Reference Set

Primary references:

- Ghostty for native-feeling performance, GPU-forward rendering direction, shell integration expectations, and Unicode correctness posture
- WezTerm for breadth of terminal features, multiplexing expectations, graphics/protocol ambition, and power-user ergonomics
- VS Code integrated terminal for IDE-linked shell integration, command boundary tracking, and error-to-code workflows
- Warp for structured execution review and command-block readability
- kitty graphics protocol ecosystem for forward-looking graphics interoperability

Official references:

- Ghostty features: <https://ghostty.org/docs/features>
- Ghostty shell integration: <https://ghostty.org/docs/features/shell-integration>
- WezTerm features: <https://wezterm.org/features.html>
- VS Code terminal shell integration: <https://code.visualstudio.com/docs/terminal/shell-integration>
- kitty graphics protocol: <https://sw.kovidgoyal.net/kitty/graphics-protocol/>
- xterm.js docs: <https://xtermjs.org/docs/>

## 2. Terminal-First Evaluation Areas

Quanta must be judged first on terminal quality, not AI ornamentation.

### 2.1 PTY and Shell Trust

- interactive shell behavior remains correct
- shell startup and environment propagation are predictable
- command boundaries and cwd tracking are reliable
- TUI applications behave correctly in raw mode

### 2.2 Protocol Surface

- bracketed paste
- alternate screen
- SGR mouse reporting
- focus reporting
- OSC 8 hyperlinks
- OSC 133 shell integration markers
- OSC 633 compatibility path where beneficial for IDE integration
- graphics protocol direction that does not dead-end future kitty support

### 2.3 Text and Rendering Correctness

- grapheme cluster correctness
- emoji width correctness
- font fallback and color emoji quality
- high scrollback responsiveness
- stable selection, copy, and hyperlink interaction

### 2.4 Developer Workflow Superiority

- compiler, linter, and stack-trace outputs become navigable faster
- users can jump to code and back to the originating block
- prior runs are easier to search, rerun, compare, and pin
- failure review is faster without hiding raw output

## 3. Deliberate Non-Primary Area

AI is not a benchmark-defining area for Quanta Phase 1.

Acceptable bar:

- optional
- preview-only
- explicit approval before execution
- no interference with primary terminal workflows

## 4. Benchmark Tasks

High-level task families. Concrete scripted tasks with fixture repos, measurement rules, and user segmentation live in [benchmark-protocol.md §2](./benchmark-protocol.md).

1. Large build with compiler errors — measure time-to-primary-error identification.
2. Diagnostic-to-source navigation — measure error-to-code latency.
3. Long-lived dev server — verify scrollback responsiveness under sustained output.
4. Full-screen TUI round trip — no corruption or state loss on entry and exit (see ADR 0008).
5. Structured history search and rerun.
6. Shell integration correctness for cwd and command boundaries (see ADR 0002, ADR 0003).
7. Protocol behavior for OSC 8, OSC 133, mouse reporting, bracketed paste, and alternate screen.
8. Assist flow with destructive-class suggestion — approval gate surfaced, no terminal-trust compromise.

## 5. Decision Rule

If a design improves AI affordances but risks PTY fidelity, protocol support, TUI trust, or raw terminal responsiveness, reject that design.

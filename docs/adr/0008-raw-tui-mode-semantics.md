# ADR 0008 — Raw / TUI Mode Semantics

## Status

Accepted for Phase 1. Turns "Phase 1 runs full-screen TUIs in raw mode" into a concrete state contract.

## Context

Full-screen TUIs (vim, less, htop, k9s, lazygit, tmux, fzf as alt-screen, ranger) own the terminal screen and bypass the structured block overlay. The spec correctly says they run in raw mode. What the spec does not say is what happens to block history before, during, and after a TUI runs, how a TUI session is represented in the projection, and what a rerun of a TUI-producing command even means.

Opinion: representing a TUI session as a distinct block type is cleaner than trying to shoehorn it into the normal block schema and suppress half the fields.

## Decision

### Detection

TUI entry is detected via:

- `ESC[?1049h` alternate screen enter as the authoritative signal.
- `ESC[?1047h` and `ESC[?47h` legacy alt-screen variants, treated the same.
- Fallback: large bursts of cursor-absolute and clear-screen sequences over a short window may mark a soft-TUI, but do not on their own transition the block to TUI mode.

TUI exit is detected via:

- `ESC[?1049l` / `ESC[?1047l` / `ESC[?47l` alternate screen exit.
- Child process exit while still in alt-screen (unclean TUI exit) — handled as exit with an `uncleanly_exited` flag.

### Block Typing

Introduce a block `kind` field:

- `command` — normal command block.
- `tui_session` — alternate-screen session.
- `detached` — background child.

TUI handling by cases:

1. **Command enters alternate screen**. The original `command` block transitions to `tui_mixed` sub-state and owns the session until exit. It stays one block. On exit, its transcript contains the command's pre-TUI output, a marker, the opaque TUI span, another marker, and any post-TUI output.

2. **User manually launches a TUI with no preceding non-TUI output** (e.g. types `vim file.py` and the shell immediately enters alt-screen). Still one `command` block with `tui_mixed` sub-state. The distinction from case 1 is recorded as a field but does not split the block.

Opinion: resist the urge to create a separate block type on every TUI. One block per submission is the invariant; the `tui_mixed` sub-state lets the UI render it distinctly without breaking the invariant.

### Transcript Retention

During TUI ownership, normal span accumulation is suspended for the enriched projection. Two retention paths run in parallel:

- **Raw byte log**: the full PTY byte stream (including all cursor movement, alt-screen updates) is streamed to a dedicated `tui_raw_blob` stored as a zstd-compressed blob referenced by the block.
- **Summary marker**: the block projection records `tui_entered_at`, `tui_exited_at`, `tui_duration_ms`, `tui_bytes_written`, and an `unclean_exit` flag.

The raw byte log is retained at a fixed cap (default 10 MiB per block) to prevent hour-long TUI sessions from filling the disk. Overflow truncates with a flag.

### Enrichment Suspension

While a block is in `tui_mixed` sub-state:

- Diagnostic pipeline is paused for that block's output.
- OSC 8 hyperlink emission and clickability are rendered but not analyzed.
- OSC 133 markers inside the TUI are ignored (some TUIs emit stray markers).
- Block search excludes the TUI raw blob by default; an explicit "search TUI transcripts" toggle opts in.

### Rerun Semantics

- Rerun of a block that contains a TUI session re-issues the same command. It does not attempt to replay the TUI interactions.
- The UI labels a rerun affordance on a TUI-bearing block with "Relaunch TUI session," not "Rerun," to set expectations.

### Compare Semantics

- Compare across two TUI-bearing blocks compares the summary metadata only (duration, unclean exit) and any non-TUI output before and after.
- No attempt to diff TUI byte streams.

### UI Presentation

- A TUI-bearing block header shows a TUI badge, duration, and a "replay as raw bytes" action that streams the blob through a disposable terminal surface.
- The block body collapses the TUI span by default; expand reveals a one-line note ("10.4 MiB of TUI interaction — replay or download").
- The pre-TUI and post-TUI output segments render normally.

### Keyboard and Focus

- While a block is in `tui_mixed` sub-state and the user's cursor is inside the Quanta UI, keystrokes route to the PTY, not the structured UI.
- Escape out of TUI focus is defined by the TUI itself (the user must exit the TUI normally). No Quanta-level "force exit" keystroke in Phase 1.

### Nested TUIs

- TUIs that enter a second alt-screen while in alt-screen are treated as the same session; nesting level is tracked but not surfaced.
- If a TUI enters alt-screen twice without an intervening exit, only the outermost enter/exit count for boundary purposes.

### Edge Cases

- **Background TUI**: a TUI backgrounded via job control is an abuse case; the block completes when the shell returns to prompt, and the TUI output captured afterward is attributed to a `detached` child block. Rare enough to accept degraded UX.
- **Partial TUI**: programs that emit cursor-up sequences without entering alt-screen (progress bars, spinners) stay in the normal block pipeline. They are not TUI sessions.
- **Shell-builtin pagers**: `less` on stdout is a TUI; `| less` pipelines are a TUI.

## Consequences

- Block schema adds: `kind`, `sub_state`, `tui_entered_at`, `tui_exited_at`, `tui_bytes_written`, `tui_blob_id`, `unclean_exit`.
- Enrichment scheduler must honor sub-state.
- Replay reconstruction of a TUI block is "load metadata and optionally stream blob"; the normal span rebuild path applies only to pre-TUI and post-TUI output.
- Testing requires an automation harness that drives real TUIs (vim, less, htop) and asserts boundary accuracy. Fixture corpus under `crates/quanta-pty/fixtures/tui/`.

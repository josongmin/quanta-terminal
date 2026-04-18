# ADR 0002 — Execution Boundary Contract

## Status

Accepted for Phase 1. Block state machine in the product spec references this ADR for the "when does a block end" question.

## Context

The product spec requires that "each run maps to exactly one command block." In a real interactive shell this is harder than it sounds. Process exit does not equal command completion. Compound commands, subshells, heredocs, background jobs, Ctrl+C, prompt customization, and shell startup noise all complicate boundary detection. Without a written contract, each implementer will invent their own heuristic and the block UX will fracture.

Opinion: OSC 133 shell integration is the only boundary signal that scales. Regex on prompts is a fallback, not a strategy. If the shell integration is not installed, the block model should degrade loudly, not silently guess.

## Decision

### Signals, in priority order

1. **OSC 133 markers** — `133;A` prompt start, `133;B` command start, `133;C` output start, `133;D;exit` command done. This is the authoritative primary signal.
2. **Child process exit for non-shell spawns** — when the sidecar spawned a direct child (not a shell), process exit is authoritative.
3. **Prompt regex fallback** — only when OSC 133 is not configured for the user's shell. Confidence penalty applied to every block produced this way. UI shows a "shell integration not installed" affordance.

### One block per user submission

A user "submission" is the payload of one `input.submitted` event. Compound commands entered on a single line stay as one block.

- `foo && bar` → one block.
- `for x in a b c; do …; done` → one block.
- Heredoc payload → one block.
- Subshell `(a; b)` → one block.

Rationale: users think in terms of what they typed and pressed enter on. Splitting compound commands would make rerun and history nonsense ("rerun only the `bar` half") and forces the core to parse shell grammar, which is a losing fight across shells.

### Background jobs

- The foreground block reaches `completed` when the shell returns its prompt (OSC 133 D).
- Any backgrounded child produces a separate `detached` block, linked to the parent by `parent_block_id`.
- Detached blocks close on child exit, or on session end with a `terminated_at_session_end` flag if the shell killed them.

Opinion: trying to keep a single block "alive" until background jobs finish is worse UX. Users want the foreground prompt back in the block list immediately.

### Cancellation

- `Ctrl+C` during execution → terminal state `canceled`. Signal delivery is best-effort.
- Ctrl+C at an empty prompt → no block is created. The submission event is never emitted.
- Ctrl+C mid-composition in the shared composer → handled at the UI layer, not the core.

### Interactive applications and TUIs

See ADR 0008 — Raw/TUI Mode Semantics. Summary: entering alternate screen produces a `tui_session` block that closes on alternate screen exit. Regular block enrichment is suspended.

### Multi-line commands

Multi-line input submitted in a single enter is one block. Continuation via shell's line continuation (`\` at end of line) that lands in the shell's own buffer across multiple submissions is collapsed by the composer before `input.submitted` fires.

### Shell startup noise

Shell initialization output (motd, sourced rc files echoing to stdout) is not a block. Core ignores output prior to the first OSC 133 A after session start.

## Degraded Mode

When OSC 133 is not present:

- Core falls back to prompt regex, parameterized by shell type.
- Every block produced under degraded mode sets `boundary_confidence = "degraded"` in the block projection.
- UI surfaces a one-time inline prompt to install shell integration, with a copy-pasteable command.
- Exit code is captured via the fallback regex on the prompt line that follows the command (zsh, bash, fish all expose it with a shell-specific pattern).

Opinion: do not silently paper over missing shell integration with ever-more-elaborate regex. The product is worse if users never find out they could have a better experience.

## Block Schema Additions

Add to the block schema:

- `boundary_signal: osc133 | child_exit | prompt_regex`
- `boundary_confidence: authoritative | degraded`
- `is_compound: boolean`
- `is_background: boolean`
- `background_children: block_id[]`

## Consequences

- Shell integration install is a first-class onboarding step, not an afterthought.
- Compound command rerun always re-runs the full compound. Users asking for partial rerun are told to edit and resubmit.
- Background-job rerun re-issues the original command; it does not try to rebuild the child's state.
- Fixture corpus for boundary tests must include: compound, heredoc, subshell, background, Ctrl+C, TUI entry, shell rc echoing.

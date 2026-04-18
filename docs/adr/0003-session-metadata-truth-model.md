# ADR 0003 — Session Metadata Truth Model

## Status

Accepted for Phase 1. Narrows the session and block schema from "tracks cwd, env, env delta" to an explicit confidence model.

## Context

The product spec lists `cwd`, `env snapshot`, and `env delta` as session and block fields. In practice, a Rust sidecar observing a shell through a PTY cannot directly see the shell's internal state. `cd`, `export`, `unset`, shell functions, and aliases all mutate state that is invisible from outside the shell unless the shell is instrumented. Prompt scraping is brittle. Shell wrappers are intrusive. Full env diffing exposes secrets.

Opinion: most of this burden vanishes once you accept that you have three distinct tiers of truth and label every field with its tier. The mistake is pretending one number means the same thing whether it came from a kernel call or a regex.

## Decision

Every session-metadata field is classified into one of three tiers. The schema carries the tier explicitly so downstream consumers know what they are reading.

### Tier 1 — Authoritative

Sourced directly from the kernel, the sidecar's own records, or explicit user action.

- `launch_cwd` — the cwd the sidecar used when spawning the shell.
- `launch_env` — the env the sidecar passed into the shell at spawn (filtered per ADR 0006).
- `shell_pid`, `shell_exit_code`, `child_pids`, `child_exit_codes`.
- `explicit_cwd_override` — when the user issues a cwd change via a Quanta UI action rather than a shell `cd`, the core knows the new cwd with certainty.

### Tier 2 — Shell-Integrated

Sourced from OSC emitters the shell integration script exposes. High confidence but only while integration is installed.

- `current_cwd` via OSC 7 (`file://host/path`). Captured on every prompt.
- `command_boundaries` via OSC 133 A/B/C/D (see ADR 0002).
- `exit_code_per_block` via OSC 133 D.

### Tier 3 — Estimated

Derived by scraping PTY output when Tier 2 signals are absent. Marked as estimated so the UI can soften claims.

- Prompt-derived cwd when OSC 7 is not installed. Matches known shell prompt patterns; falls back to "unknown" when the pattern fails.
- Exit code when OSC 133 D is missing; derived from fallback prompt regex.

### Unavailable in Phase 1

- **Live env delta.** Observing every `export`, `unset`, `set -a`, subshell env mutation, and function-local env assignment from outside the shell is intrusive and fragile. Phase 1 does not ship live env delta tracking.
- **Shell function and alias inventory.** Out of scope.
- **Shell variable introspection** beyond what the prompt emits.

## Schema Changes

Replace the current block field `env_delta_redacted` with:

- `launch_env_redacted: object`
- `env_delta_status: unavailable | partial_explicit | unavailable_phase_1`
- `env_delta_entries: object | null` — populated only when the core itself applied an override via a UI action, never by scraping the shell.

Add to the session record:

- `shell_integration_status: installed | missing | partial`
- `cwd_source: launch | osc7 | prompt_estimate | unknown`

## Degradation Behavior

- When shell integration is missing, UI hides features that depend on per-block cwd (for example, "rerun in original directory" shows "current session cwd" instead).
- When cwd is `prompt_estimate`, UI labels the cwd chip with a hover explanation.
- The sidecar never silently upgrades an estimated value to authoritative.

## Why Drop Env Delta in Phase 1

Three reasons, all operational.

1. **Implementation cost** scales far beyond the user-visible value. A well-behaved dev almost always cares about cwd plus a handful of tool-specific env vars, not the full diff.
2. **Secret exposure** grows with each tracked var. Keeping a running delta is a persistent leak source.
3. **Shell diversity** means bash/zsh/fish/nushell each need a bespoke integration to capture env reliably. The ROI is bad for Phase 1.

Phase 3+ may revisit this as an opt-in "instrumented shell mode" with explicit redaction rules and a clear user signal that extra data is being captured.

## Consequences

- Every UI element displaying cwd must read `cwd_source` and handle the three cases.
- The block schema is smaller, which simplifies persistence and replay.
- Users asking "what env did this command see" in Phase 1 get `launch_env_redacted` plus any explicit overrides, and a note that shell-internal changes are not tracked. This is a worse answer than the current spec implies, and it is the honest answer.

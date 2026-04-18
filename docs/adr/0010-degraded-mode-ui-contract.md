# ADR 0010 — Degraded Mode UI Contract

## Status

Accepted for Phase 1. Closes the open decision "how does the product communicate when structured enrichment is partial or unavailable." Quanta sells terminal trust; the UI has to show what it knows and what it is guessing, and it has to do that the same way every time.

## Context

ADRs 0002, 0003, 0004, and 0007 all specify that certain data are estimated, degraded, or unavailable under specific conditions. Without a UI contract, each surface invents its own visual language for the same condition: a parser miss looks different from a missing cwd, which looks different from a sidecar-crash recovery, and the user ends up not trusting any of them. A SOTA terminal that hides its uncertainty will be caught lying eventually. A SOTA terminal that shows its uncertainty well becomes the one users trust under pressure.

Opinion: the badge is a contract, not decoration. Two identical conditions must render identically across blocks, sessions, and host modes. If a feature disables, the reason is always reachable in one click.

## Decision

### Truth-State Taxonomy

Every piece of data that can be uncertain carries one of these states. The state is the input to every visual affordance.

- `authoritative` — kernel-observed or core-generated. No visual adornment.
- `shell_integrated` — OSC 7 / OSC 133 sourced. No visual adornment; a session-level chip shows shell integration is active.
- `estimated` — prompt-regex cwd, heuristic exit code, best-effort parse. Visible adornment.
- `unknown` — the value could not be derived. The affordance is not shown, or shown in a disabled state with explanation on hover.
- `parser_low_confidence` — diagnostic with confidence in the 0.6–0.85 band (see ADR 0007). Emitted in the "possible locations" overlay, not the primary link.
- `detached_after_crash` — block whose process tree was lost to a sidecar crash (see ADR 0004). Terminal state; cannot be rerun in place, can be relaunched as a new block.
- `redacted` — span content replaced per ADR 0006. Visible marker; reveal action available with confirmation.
- `quota_truncated` — output truncated due to ADR 0005 quota. Visible marker; no reveal (the data was never retained).

### Visual Primitives

Three reusable primitives; every feature composes with these.

1. **Badge** — small inline chip attached to the data it qualifies. One word, one tooltip.
2. **Tooltip** — hover/keyboard-focus reveal with a one-sentence explanation and an action link to either fix the cause or read more.
3. **Banner** — session- or block-level strip when a condition affects multiple affordances. Fires once per session per condition, dismissible; dismissal persists for that session only.

No other visual primitive is introduced for degraded states. If a new condition needs display, it uses these.

### Per-State Presentation

| State | Badge label | Where | Action on click |
|---|---|---|---|
| `authoritative` | (none) | — | — |
| `shell_integrated` | `SI` chip in session header | session header | Open shell integration panel |
| `estimated` | `est` | next to the value (cwd chip, exit code) | Open tooltip with "Install shell integration" link |
| `unknown` | (hidden or "—") | in place of the value | Tooltip "Not available in this session. Install shell integration to enable." |
| `parser_low_confidence` | `?` in diagnostic popover | inside "possible locations" overlay | Expand alternatives; primary link stays suppressed |
| `detached_after_crash` | `detached` | block header | Show crash-recovery explainer and "Relaunch as new block" action |
| `redacted` | `redacted:<class>` | inline within span | Reveal confirmation dialog |
| `quota_truncated` | `truncated` | at the end of the span | Tooltip with byte count and link to quota settings |

Badge typography: monospaced, border-only (no fill), same color as body text, smaller than body text. No state uses color as the only differentiator; the label carries the information.

### Banner Triggers

Banners fire only on conditions that affect multiple affordances:

- Shell integration missing for this shell on first session after install.
- Sidecar crashed and reconnected within the last 60 seconds (see ADR 0004).
- Workspace storage above soft quota (see ADR 0005).
- Secret ruleset updated; rescan offered (see ADR 0006).

A banner never exceeds one line. A banner always has a primary action and a dismiss action. Dismissal is per-session; the next session re-surfaces if the condition persists.

Opinion: do not stack banners. If two conditions fire at once, show the higher-precedence one and queue the other. A page of yellow banners trains users to close everything reflexively, including the one that mattered.

Banner precedence: crash > quota > secret rescan > shell integration.

### Action Availability Gating

Certain features require specific truth states. Gating rules:

- "Rerun in original cwd" requires per-block cwd at `authoritative` or `shell_integrated`. With `estimated`, the button remains but warns on hover; with `unknown` or `detached_after_crash`, the button is replaced with "Rerun in current cwd."
- "Compare to previous run" requires both blocks to have non-`unknown` exit codes. With one side missing, compare shows the available side and labels the other "unknown."
- "Open file at line" (diagnostic click) requires confidence ≥ 0.85 and a resolvable path. Lower confidence renders in the overlay only; unresolvable path disables the link with a tooltip explaining why.
- "Ask about this block" (optional assist) is available for all block states, including `detached_after_crash` and `quota_truncated`, but the context assembler labels the input quality so the assistant can answer accordingly.

### Copy Discipline

Tooltip and banner copy follows three rules:

1. State what is missing, not how clever the system is. "cwd is estimated from prompt text" beats "heuristic detection active."
2. Offer the concrete next action. "Install shell integration" with a link beats "Enable shell integration."
3. No hedging. "Quanta cannot detect cwd without shell integration" is better than "cwd may not be accurate."

Copy strings live in a single localization table owned by the UI package. Adding a new degraded state adds a row. If a surface needs a string not in the table, the state is not in the taxonomy and the PR is rejected.

### Accessibility

- All badges carry an aria-label identical to the tooltip's first sentence.
- All banners are announced via polite live region on first display.
- Truth-state differentiation never relies on color alone. Screen readers get the same information as sighted users.

### Telemetry (local)

Counters per state fire locally:

- `badge_rendered{state}`
- `tooltip_opened{state}`
- `banner_shown{kind}`, `banner_dismissed{kind}`, `banner_action_clicked{kind}`
- `action_gated{feature, reason_state}`

These feed the debug panel. Aggregate reporting is opt-in per ADR 0006. Sudden increases in estimated/unknown badges are a regression signal; the release process watches these.

## Consequences

- The badge and banner primitives are Phase 1 UI building blocks, not Phase 2 polish.
- Every new feature that introduces a truth condition must land with its row in the taxonomy, its copy, and its telemetry in the same PR.
- Support bundles include the last N banner events, so "I dismissed a banner and then something broke" becomes reproducible.

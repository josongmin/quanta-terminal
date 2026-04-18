# ADR 0009 — Input Routing Operational Policy

## Status

Accepted for Phase 1. Operationalizes the shell-vs-intent classifier so "ambiguous" does not swallow the product.

## Context

The spec defines three routing outcomes — `shell_command`, `natural_language_intent`, `ambiguous_requires_user_choice` — and requires that ambiguous inputs present a chooser UI. That is the correct shape. The spec does not say how often "ambiguous" is too often, what explicit overrides look like, or how the classifier learns from the local user.

Opinion: the chooser UI is the release valve, not the feature. A product whose chooser fires on 20% of submissions will be perceived as slow and indecisive even if every decision is technically correct.

## Decision

### Explicit Prefixes (highest priority)

Before classification runs, the composer inspects the first token:

- `/cmd ` — the remainder is treated as `shell_command`, no classification.
- `/ask ` — the remainder is treated as `natural_language_intent`, no classification.
- `#` followed by space at start of line — treated as `natural_language_intent`. This matches how some users already use `#` as a "please interpret this" prefix.
- No prefix — classifier runs.

Prefixes are visible in the composer UI with tab-completion on empty input. Users who prefer one mode default to prefixing.

### Default Mode per User

- Workspace setting: `input_default_mode: shell | intent | auto`.
- `auto` (default) uses the classifier.
- `shell` treats unprefixed input as shell unless the classifier returns very high intent confidence.
- `intent` treats unprefixed input as intent unless very high shell confidence.

Users who identify as shell power users set `shell`. Users who want the AI-forward experience set `intent`. The `auto` default aims for the middle.

### Classifier Confidence Bands

Classifier returns:

- `p_shell: 0.0 — 1.0`
- `p_intent: 0.0 — 1.0`

Policy for deciding route from `p_shell` and `p_intent` (where `p_other = 1 - max`):

- `p_shell ≥ 0.85` → `shell_command`.
- `p_intent ≥ 0.85` → `natural_language_intent`.
- Otherwise → `ambiguous_requires_user_choice`.

Thresholds tuned per user-default mode:

- `auto` uses the thresholds above.
- `shell` lowers the shell threshold to 0.70 and raises the intent threshold to 0.93.
- `intent` is the symmetric inverse.

### Ambiguity Budget

Targets measured across sessions:

- `chooser_fire_rate` — fraction of unprefixed submissions that hit the chooser.
  - Target: ≤ 5%.
  - Alert: > 10% for a week rolling.
- `misroute_rate` — fraction of routed submissions the user immediately corrected (opened chooser after-the-fact, or re-submitted with the opposite prefix within 60 seconds).
  - Target: ≤ 2%.
  - Alert: > 5%.

Both are tracked locally and reported only if telemetry opt-in is active. Otherwise the debug panel shows them to the user for self-tuning.

### Obvious Shell Patterns

The classifier short-circuits to `shell_command` with confidence 1.0 on:

- Input starting with a known command in `$PATH` whose first-token match is exact.
- Input containing operator characters that imply shell: `|`, `>`, `>>`, `<`, `&&`, `||`, `;`, backticks, `$(`.
- Input starting with `./`, `../`, `~/`, or an absolute path.
- Input that is a single token matching an alias or a shell builtin.

### Obvious Intent Patterns

Short-circuits to `natural_language_intent` with high confidence on:

- Interrogative starts: "how do I", "why does", "what is", "can you", "please".
- Inputs ending in a question mark.
- Inputs longer than a threshold (default 80 chars) containing no shell operators and including natural-language connectors.

### Recency-Based Local Adaptation

- If a user submits the same unprefixed string more than twice as a shell command, a local adapter records it; subsequent identical submissions short-circuit to `shell_command`.
- The adapter is workspace-scoped, bounded in size (default 1024 entries LRU), and clearable from settings.
- No cross-user or global learning.

### Chooser UI

When `ambiguous_requires_user_choice` fires:

- Composer stays focused.
- A non-modal choice row appears inline: "Run as shell" / "Ask as intent" / "Cancel".
- Default focus on the option with higher probability.
- Enter key accepts the default; up/down switches.
- User's choice is recorded as a training pair for the local adapter.

### Correction Path

- If a command was routed to intent but the user meant shell, they press the dedicated "Run as shell instead" keybinding on the resulting suggestion card. No re-typing required.
- If a command was routed to shell but the user meant intent, the block provides an "Ask about this" action that sends the composed text to the intent flow. The shell execution is not retroactively canceled; the user stops it themselves if necessary.

### Never-Auto-Execute Intent

Absolute: even when the router picks `natural_language_intent` with confidence 1.0, the resulting command suggestion goes through the risk gate (ADR 0006 provider policy, spec §19.8). No classifier confidence ever bypasses approval.

### Classifier Implementation

Phase 1 uses a deterministic rule-based classifier plus a compact scoring model. No round-trip to a remote LLM for routing decisions. Latency budget: p95 ≤ 5 ms on a warm session.

Opinion: routing must be local and fast. A provider-dependent classifier turns every keystroke submission into a network wait and makes offline mode unusable.

## Consequences

- The composer has a visible mode chip (shell/intent/auto) so users always know what the default is.
- Telemetry captures chooser fire rate and misroute rate per release; regressions block rollout.
- New operator patterns added to the shell short-circuit list are a monthly maintenance activity.
- The classifier is shared between extension and desktop hosts; no host re-implements the logic.

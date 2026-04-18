# ADR 0006 — Secret and Sensitive Data Policy

## Status

Accepted for Phase 1. Turns the spec's "redact secrets" principle into an enforceable contract.

## Context

The product spec and technical architecture both say "redact secrets" without defining what counts as a secret, where the redaction runs, what happens when users disagree with the redactor, and how export/share/AI paths see the data. Every one of these gaps becomes a bug or a privacy incident if left to implementer taste.

Opinion: false positives are as harmful as false negatives here. Over-redaction trains users to disable the feature, at which point the policy buys you nothing.

## Decision

### Scope

Redaction applies to **persisted** and **exported** representations. The live PTY stream and the raw buffer in memory are not redacted; they are user-observable truth. Redaction happens on the boundary between streaming and persistence, and at export/share time.

### Secret Classes

Tracked distinct classes so detection, UI, and audit can reason about them:

- `env_key_secret` — env var whose name matches a denylist pattern.
- `env_value_highentropy` — env var value with entropy above threshold and length above threshold.
- `command_arg_flag_secret` — argument positioned after a flag like `--token`, `--password`, `--api-key`, `--secret`, `-p` (when preceding a password-shaped value).
- `well_known_token` — pattern match: AWS access keys, AWS secret keys, GitHub PAT, OpenAI keys, Stripe keys, Google API keys, private key PEM headers, JWT-shaped tokens.
- `output_well_known_token` — well-known tokens appearing in stdout or stderr (for example, a CI log accidentally echoing a token).
- `manual_user_marked` — user explicitly flagged a span as sensitive.

### Env Key Denylist Patterns

Case-insensitive, applied to env var names:

- exact/suffix match: `PASSWORD`, `SECRET`, `TOKEN`, `API_KEY`, `PRIVATE_KEY`, `ACCESS_KEY`, `CREDENTIALS`
- vendor patterns: `AWS_*`, `GITHUB_TOKEN`, `GH_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_*`, `TWILIO_*`, `SLACK_*_TOKEN`

The list is data-driven, not hard-coded in parser logic, and is loaded from a versioned ruleset file shipped with the sidecar.

### Detection Placement

- **Launch env** (Tier 1 in ADR 0003): filtered against denylist before `launch_env_redacted` is written.
- **Command argument**: parsed on `input.submitted`; redacted representation stored as `resolved_command_redacted` alongside raw `input_text`. Raw input is stored only when the user disables redaction for that block.
- **Output chunks**: scanned for `well_known_token` patterns at persistence time. Matches replaced with `[REDACTED:well_known_token:<class>]` in the persisted span, with offset metadata so a manual reveal can recover the original from the in-memory buffer while it exists.

### False-Positive Control

- Patterns and entropy thresholds are tunable via config, with a default ruleset corpus-validated on a fixture bank of real command lines and logs.
- Each redaction emits an audit record: which rule fired, at what offset, in which class.
- A power-user setting "show redaction markers" makes the inline `[REDACTED:…]` visible so users can verify the system is not over-redacting silently.

### Manual Reveal

- Per block or per span, a user can request a reveal.
- Reveal requires a confirmation dialog that lists the classes involved.
- Reveal is logged as an audit event.
- Reveal applies only to that span, not globally. The next persisted version remains redacted.

### Export, Share, Copy

- **Copy-to-clipboard**: redacted by default if the span contained any redaction class. A modifier-key override copies raw.
- **Export session** and **support bundle**: redacted always; an additional "include raw" option requires typed confirmation and is off by default.
- **Share block URL** (if ever implemented): redacted always; raw sharing not offered.

### AI Provider Modes

Three modes for AI context assembly, selected per workspace and overridable per request:

1. `no_ai` — AI features disabled.
2. `redacted` (default) — AI receives redacted representation only.
3. `raw_per_block_optin` — user explicitly opts a single block in to send raw; opt-in expires on block close and is never persisted as a default.

Absolute constraints:

- No provider ever receives `launch_env` raw in Phase 1. Env is omitted from prompts unless the user pastes it into a message.
- No provider ever receives a span whose redaction class is `well_known_token` in raw form.
- A prompt assembly that would exceed the workspace's provider mode is refused at the host, not filtered at the provider.

### Persisted Raw Transcript Incidents

If a user disables redaction, writes a raw transcript, and then re-enables redaction, the historical data is already on disk unredacted. The policy:

- UI surfaces a "scan historical data" action that re-runs detectors over the existing store and rewrites spans.
- The scan is additive: it can convert unredacted to redacted, never the reverse.
- Audit record notes the retroactive scan.

### Detector Ruleset Versioning

- Ruleset is versioned. Each redaction is tagged with the ruleset version that produced it.
- Ruleset updates can trigger a "rescan" prompt in the UI. Rescan is opt-in per update.

### Audit

- Every redaction event recorded: block id, span id, rule id, class, offset range, ruleset version.
- Every reveal recorded: block id, span id, timestamp, reason (free text, optional).
- Audit log is itself workspace-scoped and retained on the same schedule as blocks.

## Consequences

- Phase 1 ships with an authored default ruleset; ruleset changes are a separate review surface from general code changes.
- UI must render redaction markers distinctly from normal text, or the feature becomes invisible and distrusted.
- Implementation agents must not add a "quick regex scan" that bypasses the central detector pipeline. All redaction flows through one module.
- If the policy blocks something the user legitimately needs (say, debugging why a token is malformed), the reveal path is the escape hatch. It is not meant to be fast; it is meant to be auditable.

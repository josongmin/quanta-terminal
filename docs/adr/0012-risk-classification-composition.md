# ADR 0012 — Risk Classification Composition Rules

## Status

Accepted for Phase 1. Makes the risk classifier deterministic for shell composition rather than a case-by-case judgment call. Builds on the risk labels declared in the product spec §19.8 and the signals listed in technical architecture §13.3.

## Context

The spec names six risk labels: `safe_readonly`, `workspace_write`, `system_mutation`, `network_external`, `destructive`, `credential_sensitive`. The signals are listed. What is missing is *composition*. Shell commands combine: pipes, redirections, `sudo`, `xargs`, globs, subshells, command substitution, backgrounding. A harmless command plus `| sudo bash` is not harmless. A recursive glob plus `rm` is not ordinary workspace write. Without composition rules, the review UX will wobble from case to case and users will learn to ignore it.

Opinion: deterministic, additive, monotonically non-decreasing composition. If it looks scarier after you add a modifier, it never looks less scary.

## Decision

### Classification Stage Order

Every AI-originated command runs through the classifier in this order. No stage may *lower* the risk level produced by a prior stage.

1. **Parse** — tokenize and parse the shell command into a structured AST. If parse fails or returns ambiguous structures, the command is classified `system_mutation` at minimum and flagged `parse_unknown`. Unknown structure escalates, never downgrades.
2. **Per-component classification** — each leaf command, redirection, and substitution gets a base label from the signal table below.
3. **Pipeline composition** — within a single pipeline, the overall risk is `max(component risks)`.
4. **Escalation modifiers** — additive modifiers bump the composite risk by one tier when they fire.
5. **Final clamp** — the result is the highest label reached. `destructive` and `credential_sensitive` are flag bits in addition to a level, not replacements for it.

### Risk Tiers

Ordered low to high:

1. `safe_readonly`
2. `workspace_write`
3. `system_mutation`
4. `network_external`
5. `destructive`

`credential_sensitive` is an orthogonal flag that may combine with any tier.

### Per-Component Signals

Base labels derive from signal matching. Multiple matches on one component take the highest.

- `safe_readonly`: known read-only commands (`ls`, `cat`, `grep`, `rg`, `head`, `tail`, `wc`, `find` without `-delete`, `git status`, `git log`, `git diff`, `tree`, `stat`, `echo`, `printf`, `pwd`, `which`, `type`).
- `workspace_write`: writes restricted to the current workspace (`git commit`, `git add`, `git stash`, `touch` within workspace, writes via `>` or `>>` to workspace paths, formatters, linters with `--fix`, package manager *install* limited to workspace manifests).
- `system_mutation`: mutations outside the workspace or to runtime state (`cd` outside workspace, `chmod`/`chown`, `launchctl`, `systemctl`, `brew install`, writes to home config dirs not owned by a dev tool).
- `network_external`: outbound network activity (`curl`, `wget`, `nc`, `ssh`, `scp`, `rsync` to remote, package manager *publish*, `docker push`, `git push` to remote, `npm publish`).
- `destructive`: irreversible mutation (`rm`, `rm -rf`, `git reset --hard`, `git clean -f`, `dd`, `mkfs`, database `DROP`/`TRUNCATE`, `kubectl delete`, force pushes to protected refs).
- `credential_sensitive`: commands that read, write, or transmit credentials (`aws configure`, `gcloud auth`, writes to `.env`, `.netrc`, `id_rsa`, `gpg --import`, tokens in argv positions).

### Pipeline Composition Rule

For a pipeline of components `c1 | c2 | … | cn`:

- Risk level = `max(level(ci))`.
- `destructive` or `credential_sensitive` bits propagate if any component has them.
- A pipeline whose last component is `safe_readonly` does *not* demote the pipeline. `curl URL | bash` is not read-only because of the trailing `bash`; nor is `list-files | rm` read-only because of the leading list.

### Escalation Modifiers

Each fires independently. Each bumps the composite risk by exactly one tier, capped at `destructive`. Modifier effects are additive in the sense that two modifiers bump twice.

- `sudo` or `doas` prefix → +1 tier, and sets `system_mutation` floor.
- `--force`, `-f`, `--yes`, `-y` flags on commands that support them → +1 tier.
- Recursive flags on mutating commands (`rm -r`, `chmod -R`, `find … -delete`) → +1 tier.
- Globs in the argument list of a mutating command → +1 tier. `rm file.txt` is not the same as `rm *`.
- Writes targeting paths outside workspace → +1 tier.
- Redirections targeting `/etc`, `/usr`, `/var`, `/System`, `/Library`, or home-config directories → +1 tier.
- Backgrounding (`&`, `nohup`, `disown`) on a mutating command → +1 tier. A mutation the user cannot see finish is worse than one they can.
- Command substitution in an argument to a mutating command (`rm $(…)`) → +1 tier and sets `parse_unknown` unless the substitution resolves to a known-literal set.
- `eval`, `exec`, `source` of dynamic content → +1 tier and `destructive` floor.

### Credential-Sensitive Flag Rules

The `credential_sensitive` flag sets independently whenever:

- Known-credential paths appear in argv or targets (`.env`, `id_rsa`, `~/.aws/credentials`, `~/.ssh/config`, `~/.docker/config.json`, `~/.netrc`).
- A token-shaped argv value sits after a credential-style flag (`--token`, `--password`, `--api-key`, `-p password`).
- An env assignment in the command sets a known-credential env var name.
- Output is piped to a file shaped like a credential path.

The flag combines multiplicatively with the level: a `workspace_write` + `credential_sensitive` prompts with a stronger confirmation than `workspace_write` alone.

### Parse-Unknown Handling

If the parser cannot structure a command with confidence:

- Minimum level is `system_mutation`.
- The command is annotated `parse_unknown: true`.
- The review UI shows a specific banner: "We could not fully parse this command. Review carefully before approving."
- No automatic downgrade is ever allowed based on heuristic recognition of a familiar-looking substring.

### Approval Gate Mapping

The spec's §19.8 approval policy applies, keyed on final level plus flags:

- `safe_readonly` → single approval.
- `workspace_write` → approval with preview of the diff or target paths.
- `system_mutation` or `network_external` → elevated warning, approval, show affected scope.
- `destructive` → elevated warning, approval, typed confirmation.
- `credential_sensitive` flag — elevated warning regardless of level, plus typed confirmation if the level is `system_mutation` or higher.

The review UI presents both the level and the modifiers that produced it ("system_mutation because: sudo prefix; recursive glob"). Opacity is a failure mode here; users need to see why.

### Non-AI Commands

This classifier runs on AI-originated commands only. Commands that the user typed directly are not routed through it. An advisory tier may surface hints on destructive patterns in user-typed input (ADR 0009 does not gate user input), but the command executes when the user presses enter.

### Determinism and Testing

- Classifier is a pure function of the AST and the ruleset version.
- Fixtures under `crates/quanta-risk/fixtures/` pair input commands with expected `{level, flags, modifiers}`.
- CI blocks on regression for any fixture. New shell patterns that require a rule update add a fixture in the same PR.
- A periodic corpus run (monthly) replays all fixtures to catch drift after parser changes.

### Ruleset Versioning

- Ruleset is versioned.
- Each classification records the ruleset version used.
- Rule changes are a review surface distinct from general code changes. Loosening a rule requires explicit justification and a migration note.

## Consequences

- The classifier is boring by design. Boring is the feature.
- Review UX always shows both the final level and the reasons. Users learn to trust the system because the reasoning is visible.
- Adding support for a new command family is additive: new fixtures, new rules, no changes to composition logic.
- The floor-only rule means an unknown parse cannot be labeled `safe_readonly` by any path. This is the single most important property of the classifier.

## Verification

- `crates/quanta-proto/src/events.rs` — `RiskLevel` derives `PartialOrd`/`Ord` so composition "take the max" is the built-in ordering.
- `tools/check-adr-compliance` ADR-0012 row — confirms the derive is still present.

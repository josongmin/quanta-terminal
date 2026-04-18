# Contributing

Thank you for your interest in Quanta Terminal. Before you open a PR, please read the Architecture Decision Records (ADRs) under [`docs/adr/`](docs/adr/). They are the binding contracts for this repo; the review bar is not "does it work" but "does it match the decisions we have already made."

## The ADRs are the contract

- [ADR 0014 — Repository Structure (hexagonal backend + FSD frontend)](docs/adr/0014-repository-structure.md) defines the crate and package layout, the layer order, and the import rules. CI enforces it via [`tools/check-hex-imports`](tools/check-hex-imports/) and [`tools/check-fsd-layers.mjs`](tools/check-fsd-layers.mjs). A PR that adds a new domain adds a crate and an FSD slice under the same domain name.
- [ADR 0010 — Degraded Mode UI Contract](docs/adr/0010-degraded-mode-ui-contract.md) defines the UI primitives for truth-state badges. New degraded states add a row to the taxonomy, a variant on the existing `Badge` / `Tooltip` / `Banner`, and a copy string — never a new primitive.
- Other ADRs (0001 through 0013) cover hosts, parsers, events, secrets, and quotas. If your change touches any of those topics, re-read the relevant ADR before writing code.

If a change cannot be expressed within the existing ADRs, that is a signal the ADR is wrong for the change. Open a new ADR (copy the numbering) rather than working around the existing one in code.

## Local workflow

We use [`just`](https://just.systems) for shortcuts. All of these run locally:

- `just dev` — start the Tauri host in dev mode.
- `just test` — run the full Rust and TypeScript test suite.
- `just lint` — run clippy, prettier, and eslint.
- `just check-layers` — run both layering enforcers (hexagonal + FSD).
- `just proto-check` — check the generated schema types against `quanta-proto` (wired in Phase 2).

For the full picture of the three-layer test story (per-crate Rust unit → workspace-spanning integration harness over the real socket → vitest + schema parity), see [`TESTING.md`](./TESTING.md). Key touchpoints when making cross-surface changes:

- A Rust-side proto change must pass the TS schema-parity test at `packages/host-common/src/__tests__/schema-parity.test.ts`. That test catches silent renames of event variants, `kind` discriminators, or enum values.
- A sidecar protocol change must keep `tests/integration/tests/end_to_end.rs` green. That test drives the real `quanta-core` binary over its Unix socket.
- `cargo run -p check-adr-compliance` is a one-line-per-ADR audit; new ADRs or new mechanically-checkable rules land a new check there.

The CI workflow in [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs the same checks on every PR. Do not rely on a green CI to find problems a local `just lint` would have caught.

## Style

- Rust: `cargo fmt` and `cargo clippy -- -D warnings` are the gate. The workspace sets `unsafe_code = "deny"`; do not add `#[allow]` without a comment explaining why.
- TypeScript: Prettier (`.prettierrc.json`) and the package-local ESLint config are the gate. We use `verbatimModuleSyntax` and `exactOptionalPropertyTypes`; imports and types are strict on purpose.
- Commits: imperative mood in the subject line ("add X", "fix Y"), one concept per commit when practical.

## Adding a new feature

Follow the checklist in ADR 0014 §Feature Checklist. In short:

1. Domain types in the matching `quanta-<domain>/src/domain/`.
2. A port method if a new IO shape is needed.
3. An adapter implementation if the port needs infrastructure.
4. Composition wiring in `quanta-core`.
5. Schema bump in `quanta-proto` (versioned per ADR 0012).
6. FSD entity + feature slice under the same domain name.
7. Widgets and page wiring if user-visible.
8. Tests at every layer the change touches.

If you skip a step, say so in the PR description and tag it with the follow-up issue.

## Reporting issues

Open a GitHub issue with the reproduction, the platform, the ADR number the issue touches (if any), and the git SHA you built. Diagnostic bundles live under `~/.quanta-dev-profile/` in dev builds — attach one if the behavior is a crash or a flicker.

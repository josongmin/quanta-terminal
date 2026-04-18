# Testing

Quanta Terminal ships three layers of automated tests. Each layer catches a different class of bug; each runs locally and on CI.

## The three layers

### 1. Rust unit tests (per crate)

Each `crates/quanta-*` crate carries in-tree unit tests for its own domain logic. Run the whole set with:

```sh
cargo test --workspace
```

Per crate:

```sh
cargo test -p quanta-proto
cargo test -p quanta-protocol
cargo test -p quanta-block
```

Unit tests are hermetic — no file system, no network, no subprocess. If a test needs those, it belongs in Layer 2.

### 2. Rust integration tests

Two kinds:

**Per-crate integration tests** under `crates/<crate>/tests/` drive a single crate's public API with realistic inputs. For example:

- `crates/quanta-core/tests/walking_skeleton.rs` boots the `Engine` **in process** and drives it through a full session lifecycle.
- `crates/quanta-events/tests/replay_determinism.rs` writes a segmented log and replays it to prove determinism (ADR 0011).
- `crates/quanta-protocol/tests/handshake.rs` exercises the `Hello`/`Ready`/`Incompatible` handshake (ADR 0004).
- `crates/quanta-block/tests/boundary_corpus.rs` pins the execution-boundary detector (ADR 0002).

**Workspace-spanning integration tests** live in `tests/integration/`. This crate spawns the real `quanta-core` binary, connects to its Unix socket as a mock host, and drives the wire protocol end-to-end. It is the only test layer that exercises the real binary + real socket + real framing together.

```sh
cargo test -p quanta-integration-tests
# or:
cargo test --workspace
```

Every integration test uses `tempfile::TempDir` for the socket and profile; nothing touches `~`. The child is spawned with `kill_on_drop(true)` so a panicking test cannot leak stray `quanta-core` processes.

Scenarios in `tests/integration/tests/end_to_end.rs`:

- `socket_handshake_and_create_session` — the minimum viable sidecar handshake + first RPC.
- `submit_to_missing_session_returns_clean_error` — error code `no_such_session` on bad input.
- `cancel_block_for_missing_session_is_noop_ok` — cancel on an unknown session is tolerated.
- `list_sessions_reflects_create_close` — session registry round-trip through RPC.
- `socket_event_flow_echo_integration_ok` — full `SessionCreated → BlockCompleted(0)` chain on the event plane. **Currently `#[ignore]`d** — see "Known gaps" below.
- `socket_cancel_long_running_emits_block_canceled` — cancel path observed through events. **Currently `#[ignore]`d.**

Run ignored tests explicitly with `cargo test -p quanta-integration-tests -- --ignored`.

### 3. TypeScript tests (vitest)

Per-package:

```sh
pnpm -r test
# or:
pnpm --filter @quanta/host-common test
pnpm --filter @quanta/ui test
```

The `host-common` package owns the **schema parity test** (`packages/host-common/src/__tests__/schema-parity.test.ts`). It reads `crates/quanta-proto/src/*.rs` as plain text, scrapes every enum variant, and asserts each TS mirror carries a matching `snake_case` literal. A Rust-side rename without the TS counterpart breaks this test before the PR lands — that's the whole point.

No Rust toolchain is required to run the schema-parity test; vitest alone is enough.

## What the import-graph tools enforce

Two mechanical checks run on every PR. They are fast (<500 ms each) and must both pass before integration tests even run.

### `tools/check-hex-imports`

Reads every `crates/*/src/**/*.rs`, parses `use` statements with `syn`, and fails if:

- a file under `domain/` imports `adapters::*`
- a file under `domain/` imports a runtime crate (`tokio`, `nix`, `portable_pty`, `rusqlite`, etc.)
- a file under `ports/` imports `adapters::*`
- any crate imports another crate's `adapters::*` directly

```sh
cargo run -q -p check-hex-imports -- --root .
```

Rules come from ADR 0014. An intentional violation must carry a comment explaining why.

### `tools/check-fsd-layers.mjs`

Walks `packages/ui/src/**/*.{ts,tsx}` and enforces the Feature-Sliced Design layer order (`shared < entities < features < widgets < pages < processes < app`). Cross-slice imports within the same non-shared layer are forbidden. The UI package may never import from `@quanta/host-tauri` or `@quanta/host-vscode` — that contract preserves the Host Bridge Split (ADR 0014).

```sh
node tools/check-fsd-layers.mjs
# or:
pnpm run check:layering
```

Zero npm deps; Node built-ins only, so CI does not need `pnpm install` before running it.

### `tools/check-adr-compliance`

One-line-per-ADR mechanical audit: file existence, symbol presence, derive checks. Does not try to reason about ADR semantics — just catches the "the file the ADR promises doesn't exist" class of regression.

```sh
cargo run -p check-adr-compliance
```

Exit code 0 if no ADR reports `fail`; exit 1 otherwise. `skip` lines are intentional Phase-1 non-goals (history search, secret filtering) and do NOT fail the build.

## Known gaps (Phase-1 intentional non-goals)

- **Socket event pump not fed by engine.** `ControlRegistry::next_event()` pops from an in-memory queue that is never populated by `Engine::create_session` or the session actor's event log sink. Until that wiring lands, the socket event-plane scenarios in `tests/integration/` are `#[ignore]`d. Walking-skeleton coverage for the same events lives in `crates/quanta-core/tests/walking_skeleton.rs` using the in-process replay path.
- **Secret redaction (ADR 0006)** is a Phase-1 placeholder. The compliance tool emits `skip` for ADR-0006. The integration suite does not yet carry a secret-leak regression (logged as TODO).
- **Diagnostic parsers (ADR 0007)** ship zero adapters in Phase 1. The `quanta-diagnostic` crate is expected to exist as a stub (`Cargo.toml` + `src/lib.rs`); the compliance tool reports `fail` if it does not.
- **Classifier (ADR 0009)** is a Phase-1 non-goal; `InputKind::Shell` and `InputKind::Intent` variants are the only mechanical guarantee.
- **History search (ADR 0013)** is a Phase-1 non-goal; the compliance tool emits `skip`.

## Running everything locally

```sh
# Rust
cargo test --workspace
cargo run -q -p check-hex-imports -- --root .
cargo run -p check-adr-compliance

# TypeScript
pnpm -r test

# Layering
node tools/check-fsd-layers.mjs
```

Expect the whole local run to finish in under a minute on a warm machine. If it takes longer, a test has drifted from the "hermetic + bounded" bar — open a bug.

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
- `socket_event_flow_echo_integration_ok` — full `SessionCreated → BlockCompleted(0)` chain on the event plane.
- `socket_cancel_long_running_emits_block_canceled` — cancel path observed through events.
- `socket_event_flow_emits_diagnostic_for_rustc_error` — a canned rustc error crosses the socket and arrives at the host as a `DiagnosticDetected` envelope (Phase-3 diagnostic pipeline; the in-process pipeline itself is pinned separately in `crates/quanta-session/tests/diagnostics.rs`).

A companion test lives in `tests/integration/tests/resume_cursor.rs`: two hosts share a `quanta-core` lifetime; the second connects carrying `resume_cursors` and verifies only events above the mid-stream seq are replayed (ADR 0011).

The socket-plane event flow scenarios (`socket_event_flow_echo_integration_ok`, `socket_cancel_long_running_emits_block_canceled`) were previously `#[ignore]`d pending the fanout between the session actor's event feed and the socket adapter's broadcast channel. Phase 2 landed `FanoutSink` (`crates/quanta-core/src/adapters/fanout.rs`), so these scenarios are no longer ignored.

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

- **Secret redaction (ADR 0006)** is a Phase-1 placeholder. The compliance tool emits `skip` for ADR-0006. The integration suite does not yet carry a secret-leak regression (logged as TODO).
- **Diagnostic parsers (ADR 0007)** ship zero adapters in Phase 1. The `quanta-diagnostic` crate is expected to exist as a stub (`Cargo.toml` + `src/lib.rs`); the compliance tool reports `fail` if it does not.
- **Classifier (ADR 0009)** is a Phase-1 non-goal; `InputKind::Shell` and `InputKind::Intent` variants are the only mechanical guarantee.
- **History search (ADR 0013)** is a Phase-1 non-goal; the compliance tool emits `skip`. Phase 4 ships a front-end-only, in-memory history surface (`packages/ui/src/widgets/history-search`) over the multi-session block collection; this is deliberately NOT the sidecar-backed, persisted-and-ranked store the ADR describes. ADR 0013 remains `skip` until that store lands.

## End-to-end smoke walkthroughs

Two manual smoke paths exercise the full UI → bridge → shell stack end-to-end. Both are expected to complete in well under a minute; they are the "does the app actually boot" checks a reviewer runs on a release candidate. Each step names the file that owns the behavior so a failure is triaged without `grep`.

### Path A — Mock bridge (browser dev, no Tauri)

Use case: UI work against a browser. No Rust toolchain needed.

1. **Start the Vite dev server in isolation.** `pnpm --filter @quanta/host-tauri dev:vite` boots Vite on `http://localhost:1420`. Open it in a regular browser (Chrome, Safari). The `hasTauriRuntime()` probe in `packages/host-tauri/src/mock-bridge.ts` returns `false`, so `createHostBridge()` returns the mock.
2. **The mock greets the user.** A banner line `"▌ Quanta Terminal — browser dev mode"` + prompt `$ ` appears in the first block. The banner text is authored in `packages/host-tauri/src/mock-bridge.ts`; the prompt glyph is the shared `MOCK_PROMPT_STRING` from `@quanta/host-common/mock-protocol`.
3. **Type a command and press Enter.** The mock echoes it back and emits a fresh `$` prompt. The block router in `packages/ui/src/features/command` closes the active block on prompt detection and stages the next one.
4. **Click a path that looks like a diagnostic.** The mock has no diagnostic parser (that's a Rust-only surface), so to exercise `openInEditor` type `echo src/main.rs:3:5` — the renderer (`packages/ui/src/shared/lib/path-detect`) finds the path and makes it clickable. A click dispatches `features/navigation/open-in-editor`, which calls `bridge.openInEditor`. The mock implementation `console.info`s `[mock] would open src/main.rs 3 5` — check the devtools console for that line. The UI does not surface a visible toast for the success path in the mock.

### Path B — Tauri real-bridge (`embedded-shell` feature)

Use case: end-to-end validation on the full desktop stack.

1. **Launch the app.** `pnpm dev` (alias for `pnpm --filter @quanta/host-tauri dev`) starts Vite AND `tauri dev`. The Tauri runtime is built with the default feature set `["embedded-shell"]` (`packages/host-tauri/src-tauri/Cargo.toml`), so a real PTY-backed shell is available.
2. **The Tauri webview loads, runtime is detected.** `hasTauriRuntime()` sees `window.__TAURI_INTERNALS__`; `createHostBridge()` returns the Tauri bridge. The bridge calls `invoke('quanta_ready')` then `invoke('quanta_spawn_session', …)` — see `packages/host-tauri/src/bridge.ts`. The Rust command `quanta_spawn_session` (in `packages/host-tauri/src-tauri/src/ipc.rs`) hands off to `EmbeddedShell::spawn`, which opens a PTY pair and spawns `$SHELL` / `/bin/zsh` / `/bin/bash` as appropriate.
3. **Output flows over `quanta://pty-data`.** The Rust data-pump thread base64-encodes chunks and emits them via `AppHandle::emit(EVENT_PTY_DATA, …)`. The TS bridge's `listen<QuantaDataEventPayload>('quanta://pty-data', …)` translates them to `HostEvent { kind: 'pty_data' }` and fans out to subscribers. **Topic names use hyphens, not dots** — Tauri 2 warns (and in some setups rejects) `.` in event names. Both sides are pinned on `quanta://pty-data` / `quanta://pty-exit`.
4. **Type a command.** The composer widget writes it via `bridge.write` → `invoke('quanta_write', …)` → `SpawnedSession::write` → the PTY's stdin. The shell runs the command and emits output over the data channel.
5. **Run something that prints a path.** e.g. `cargo build` in a Rust repo, or `printf 'err src/main.rs:3:5\n'`. The renderer detects `src/main.rs:3:5` and underlines it.
6. **Click the path.** The UI calls `bridge.openInEditor({ path, line, column })`. The TS wrapper `invoke('quanta_open_in_editor', { args })` reaches the Rust `quanta_open_in_editor` (see `packages/host-tauri/src-tauri/src/ipc.rs`), which:
   - runs `validate_editor_path` (rejects NUL, newlines, control chars — defense in depth over the TS-side filter),
   - rejects relative paths (the TS layer is supposed to resolve them against the session cwd first),
   - resolves an editor from `resolve_editor()`: `code` → `cursor` → `subl` → `$VISUAL` → `$EDITOR`,
   - spawns the editor with `Command::new(editor).arg("-g").arg(format!("{path}:{line}:{column}"))`. **No `sh -c`, ever.** User strings never reach a shell interpreter.
7. **VS Code (or whichever editor resolved) opens at the right line/column.** If no editor is found on `PATH`, the Tauri command rejects; the TS bridge converts the rejection to an `Error`; the UI surfaces the reason.

Security invariants for Path B are pinned in unit tests: `validate_editor_path` tests live in `packages/host-tauri/src-tauri/src/ipc.rs` (`mod tests`), and TS-side path validation + cwd resolution in `packages/ui/src/features/navigation/__tests__/open-in-editor.test.ts`.

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

## Building a production Tauri bundle (with the `quanta-core` sidecar)

End users of the shipped `.app` / `.msi` / `.deb` must NOT be required to have `quanta-core` on their `PATH`. The Tauri bundler ships the binary inside the app package via its `externalBin` mechanism (ADR 0004), and the sidecar resolver in `packages/host-tauri/src-tauri/src/sidecar.rs` picks it up from `BaseDirectory::Resource` at runtime.

One-liner release build on the current host:

```sh
pnpm package-sidecar && pnpm --filter @quanta/host-tauri tauri build
```

What each step does:

1. **`pnpm package-sidecar`** (alias: `just package-sidecar`, direct: `./scripts/package-sidecar.sh`).
   - Detects the host triple from `rustc -vV` (e.g. `aarch64-apple-darwin`).
   - Runs `cargo build --release --bin quanta-core` (scoped — no full-workspace release build).
   - Copies `target/release/quanta-core` into `packages/host-tauri/src-tauri/binaries/quanta-core-<triple>` (with `.exe` on Windows). Tauri 2 requires the triple suffix on disk; the app calls the binary by its short name, and the bundler maps the two.
2. **`pnpm --filter @quanta/host-tauri tauri build`** invokes `cargo tauri build`, which reads `"bundle.externalBin": ["binaries/quanta-core"]` from `tauri.conf.json` and embeds the triple-suffixed binary into the final bundle.

The `binaries/` directory is gitignored — we ship the packaging script, never the compiled artifact. Each target you want to distribute needs a matching run on a builder for that target triple (macOS arm64, macOS x86_64, Linux x86_64, Windows x86_64, etc.). CI matrix jobs are the expected mechanism.

Resolver priority at runtime (same source of truth in `sidecar.rs::resolve_core_binary`):

1. `QUANTA_CORE_BIN` env var — developer override, highest priority; a missing path errors loudly rather than silently falling back.
2. `AppHandle::path().resolve("quanta-core", BaseDirectory::Resource)` — the bundled-sidecar path used by shipped app packages.
3. `which quanta-core` — historic PATH lookup, kept so `cargo install quanta-core` still works for contributors.

The resolver arms are unit-tested in `packages/host-tauri/src-tauri/src/sidecar.rs` under `mod tests` (env-var priority, missing-env-path loud failure, `None` AppHandle safety, bundled-resource fall-through). The full bundled-path behavior is validated by building an actual Tauri bundle — that is the only honest end-to-end check, because Tauri's resource resolver requires a real packaged app context.

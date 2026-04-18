# ADR 0014 — Repository Structure: Domain Slicing + Hexagonal (Backend) + FSD (Frontend)

## Status

Accepted for Phase 1. Pins the repo layout so two implementers do not build two different codebases while claiming to follow the architecture doc. Supersedes the flat recommendations in technical architecture §4.1 and §4.2.

## Context

The architecture doc lists Rust crates (`quanta-pty`, `quanta-events`, etc.) and TypeScript packages (`host/bridge`, `ui/blocks`, etc.) without naming the organizing principle. Without one, the codebase will drift into either a tech-layer split (everything-domain mixed inside `controllers/`, `services/`, `repositories/`) or a feature-blob split (each feature duplicates its own PTY, its own event code, its own storage). Both are paths to a codebase that resists change.

The user has specified:

- Backend / engine: domain-based slicing + hexagonal architecture (ports and adapters).
- Frontend: domain-based slicing + Feature-Sliced Design (FSD).

This ADR makes that binding.

Opinion: domain-first is right for a product where the domain vocabulary (session, block, diagnostic, suggestion) is stable and the technology surface (PTY kind, storage engine, host) is what changes. Hexagonal + FSD are compatible mental models: in both, the domain is inside, the world is outside, and adapters translate.

## Decision

### Backend (Rust) — Domain Slicing + Hexagonal

#### Domains

Each domain owns its aggregate, its rules, its ports. Domains are first-class and named consistently across crates, folders, and event types.

- `pty` — PTY and process lifecycle.
- `session` — terminal session actor, lifecycle, metadata tiers.
- `block` — command block aggregate and state machine.
- `output` — span storage, ANSI retention, truncation rules.
- `diagnostic` — parser pipeline and normalized emissions.
- `suggestion` — AI-originated command proposals and risk classification.
- `history` — persistence, retrieval, relevance.
- `events` — append-only event log and replay.
- `security` — secret policy, redaction, audit.
- `protocol` — IPC schema and versioning.
- `lifecycle` — sidecar boot, handshake, heartbeat, crash recovery.

#### Hexagonal Split Inside Each Domain

Every domain crate has three sub-layers:

- `domain/` — pure types, invariants, reducers. No IO. No `tokio`. Deterministic.
- `ports/` — trait definitions the domain calls out to (e.g. `PtyPort`, `EventSink`, `DiagnosticAdapter`). Ports are expressed in domain terms, not infrastructure terms.
- `adapters/` — concrete implementations of the ports (e.g. `adapters/nix_pty.rs`, `adapters/sqlite_event_sink.rs`). Adapters are the only layer that depends on infrastructure crates.

Domain types never import from `adapters/`. Adapters may import from `domain/` and `ports/`. Ports are the boundary; they depend on nothing from either side other than primitive types and the domain's own aggregates.

#### Crate Layout

```
crates/
  quanta-proto/               # shared schema, versioned
  quanta-events/              # domain=events (log, replay, reducer trait)
    src/domain/
    src/ports/
    src/adapters/             # segmented log, zstd writer, dedupe
  quanta-pty/                 # domain=pty
    src/domain/
    src/ports/
    src/adapters/             # nix/portable-pty
  quanta-session/             # domain=session
    src/domain/
    src/ports/
    src/adapters/
  quanta-block/               # domain=block
    src/domain/               # state machine, boundary rules
    src/ports/
    src/adapters/
  quanta-output/              # domain=output
  quanta-diagnostic/          # domain=diagnostic
    src/domain/
    src/ports/                # ParserAdapter trait
    src/adapters/
      rustc/
      tsc/
      python_traceback/
      node_stack/
      pytest/
      vitest/
      eslint/
  quanta-suggestion/          # domain=suggestion (includes risk classifier)
    src/domain/
    src/ports/
    src/adapters/
  quanta-history/              # domain=history (storage, retrieval)
    src/domain/
    src/ports/
    src/adapters/
      sqlite_store/
      fts5_index/
      blob_spill/
  quanta-security/             # domain=security
  quanta-protocol/             # domain=protocol (JSON-RPC, MsgPack)
  quanta-lifecycle/            # domain=lifecycle (handshake, heartbeat)
  quanta-core/                 # composition root; wires ports to adapters
  quanta-cli-dev/              # developer harness
```

#### Composition Root

`quanta-core` is the only crate that sees every adapter. It constructs the graph:

- Picks the adapter implementation per port from config.
- Wires sessions and their actors.
- Owns the top-level `tokio` runtime.

No other crate picks adapters. If a crate needs cross-domain logic, it does so through ports published by other domains, never by importing the other domain's adapters.

#### Dependency Rules (enforced)

- `domain/` depends on: std, serde, domain-local types.
- `ports/` depends on: its own `domain/`, std, async traits.
- `adapters/` depends on: its own `domain/`, its own `ports/`, infrastructure crates.
- Cross-domain: one domain may depend on another domain's `domain/` and `ports/`, never on its `adapters/`.
- Nothing depends on `quanta-core` except binaries.

CI enforces with a lightweight script that greps forbidden imports. Drift is a merge blocker.

#### Testing Layers

- Per-domain unit tests in `domain/` — pure, fast, deterministic.
- Port contract tests — given any adapter implementation, run a shared contract suite.
- Integration tests in `quanta-core` — end-to-end flows (session create → block run → event → projection).
- Replay-determinism harness lives in `quanta-events`, consumed by CI.

### Frontend (TypeScript / React) — Domain Slicing + FSD

FSD layers (top to bottom):

- `app` — bootstrap, providers, routing.
- `processes` — cross-page multi-step flows (for example, onboarding).
- `pages` — route-level compositions. Small.
- `widgets` — independent UI blocks composed from features/entities (for example, `BlockList`, `Composer`).
- `features` — user-triggerable actions (for example, `rerun-block`, `pin-block`, `approve-suggestion`).
- `entities` — domain nouns (for example, `Block`, `Session`, `Diagnostic`, `Suggestion`).
- `shared` — reusable primitives (UI kit, API client, utils, types).

Inside each FSD layer, code is sliced by domain — the same domain names as the backend.

```
packages/ui/
  src/
    app/
    processes/
      onboard-shell-integration/
    pages/
      main-terminal/
      history/
    widgets/
      block-list/
      block-detail/
      composer/
      diagnostic-panel/
      suggestion-review/
      sidecar-status/
    features/
      block/
        rerun/
        pin/
        label/
        compare/
      composer/
        submit/
        switch-mode/
        reveal-redaction/
      suggestion/
        approve/
        reject/
        edit-before-run/
      diagnostic/
        open-in-editor/
        pivot-to-search/
      history/
        search/
        filter-by-workspace/
    entities/
      block/
      session/
      diagnostic/
      suggestion/
      output-span/
      event/
    shared/
      api/              # host bridge client
      ui/               # primitives, Badge, Banner, Tooltip (see ADR 0010)
      lib/
      config/
      types/            # generated from quanta-proto
```

#### Host Bridge Split

The React UI is host-agnostic. Host-specific code lives in parallel host packages:

```
packages/host-vscode/       # Mode A adapter (ADR 0001)
packages/host-tauri/        # Mode B adapter (ADR 0001)
packages/host-common/       # shared host interfaces and utilities
```

`packages/ui/` depends only on `packages/host-common/`'s interface. Host-specific imports in `packages/ui/` are forbidden and CI-enforced. This is what keeps ADR 0001's "one canonical core" contract honest at the TypeScript boundary.

#### FSD Dependency Rules

The canonical FSD rule: a layer may only import from layers *below* it. `features` may import `entities` and `shared`, but not `widgets`. Enforced with a lint rule.

Cross-slice imports within the same layer are forbidden. Domain isolation inside a layer is deliberate; if two features need shared logic, it lives in `entities` or `shared`.

#### UI Primitives

`shared/ui/` holds the primitives specified in ADR 0010 (Badge, Banner, Tooltip, plus the design-system primitives). No other place defines these. Adding a new degraded-state badge adds a variant on the existing `Badge`, not a new file in a different location.

### Schema Sharing

Generated schema types from `quanta-proto` land in `packages/ui/src/shared/types/generated/`. The TypeScript host imports from there, never from a hand-authored schema file. A schema change triggers codegen; a drift check in CI compares hand-authored references, if any, against generated.

### Naming Consistency

Domain names are the same string everywhere: crate name, folder name, event `source` field, telemetry category, directory in FSD slices. A block-domain event is `block.*`, lives in `quanta-block`, surfaces through `packages/ui/src/entities/block/`, and is acted on by `packages/ui/src/features/block/...`.

### Feature Checklist

A new feature adds:

1. Domain types in `quanta-<domain>/src/domain/` if new.
2. A port method in `quanta-<domain>/src/ports/` if new.
3. An adapter impl in `quanta-<domain>/src/adapters/` if the feature needs IO.
4. Wiring in `quanta-core`.
5. Schema updates in `quanta-proto` (versioned).
6. Entity and feature slices in the FSD tree under the matching domain name.
7. Widgets and page wiring if the feature is user-visible.
8. Tests at every layer the change touches.

A feature that cannot be added this way is a signal that the layout is wrong for that feature; reopen the ADR rather than working around it.

## Consequences

- The crate and package graph is predictable. New hires find things by asking "which domain?" not "which technology?"
- Swapping a storage backend, a PTY backend, or a host is a matter of adding an adapter. The domain does not move.
- Test organization mirrors the dependency graph, which makes CI partitioning easy.
- The layout is enforceable. Lint rules and a tiny import-graph script are Phase 1 deliverables, not wishes.
- This ADR supersedes the crate/package lists in [technical-architecture.md](../technical-architecture.md) §4.1 and §4.2; that document points here.

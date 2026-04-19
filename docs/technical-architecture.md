# Quanta Terminal Technical Architecture

## 0. Purpose

This document turns the product spec into a concrete build architecture and reference technology stack.

If implementation agents need to choose between many possible stacks, use this document as the default reference unless a later ADR explicitly overrides it.

## 0.1 Related ADRs

The ADRs under [`docs/adr/`](./adr/) own the parts of the system where this architecture is deliberately non-prescriptive. When a section here cross-references an ADR, the ADR is the binding contract; this document is the overview.

- [ADR 0001 — Host Modes and Deployment Targets](./adr/0001-host-modes.md)
- [ADR 0002 — Execution Boundary Contract](./adr/0002-execution-boundary-contract.md)
- [ADR 0003 — Session Metadata Truth Model](./adr/0003-session-metadata-truth-model.md)
- [ADR 0004 — Sidecar Lifecycle Contract](./adr/0004-sidecar-lifecycle-contract.md)
- [ADR 0005 — Storage and Retention](./adr/0005-storage-and-retention.md)
- [ADR 0006 — Secret and Sensitive Data Policy](./adr/0006-secret-and-sensitive-data-policy.md)
- [ADR 0007 — Diagnostic Parser Rollout Plan](./adr/0007-parser-rollout-plan.md)
- [ADR 0008 — Raw / TUI Mode Semantics](./adr/0008-raw-tui-mode-semantics.md)
- [ADR 0009 — Input Routing Operational Policy](./adr/0009-input-routing-policy.md)
- [ADR 0010 — Degraded Mode UI Contract](./adr/0010-degraded-mode-ui-contract.md)
- [ADR 0011 — Event Replay, Reducer Determinism, and Resume](./adr/0011-event-replay-and-reducer-semantics.md)
- [ADR 0012 — Risk Classification Composition Rules](./adr/0012-risk-classification-composition.md)
- [ADR 0013 — History Search and Relevance](./adr/0013-history-search-and-relevance.md)
- [ADR 0014 — Repository Structure](./adr/0014-repository-structure.md)

## 1. Architectural Position

Quanta Terminal is not a frontend widget that decorates an existing terminal emulator after the fact.

It is a split architecture:

- Rust sidecar core owns PTY truth, event sourcing, block construction, diagnostics, persistence, and replay
- TypeScript host owns IDE integration, optional assist orchestration, command review UX, and editor navigation
- React UI owns terminal surfaces, block presentation, search flows, compare views, and safety affordances

This separation is intentional:

- PTY and stream-heavy work should not compete with the IDE extension host event loop
- terminal truth must survive UI reloads and renderer crashes
- history, replay, and parsing need stable backend ownership

## 2. Reference Stack

### 2.1 Rust Core

- Language: Rust stable
- Edition: 2024 if toolchain availability is acceptable, otherwise 2021
- Async runtime: `tokio`
- Serialization: `serde`, `serde_json`, `rmp-serde`
- Error handling: `thiserror`, `anyhow`
- Tracing: `tracing`, `tracing-subscriber`
- PTY/process control on Unix: `nix` as the primary low-level dependency
- Optional interop crates where they materially reduce risk: `portable-pty` only if direct `nix` ownership proves insufficient
- ANSI and terminal parsing: `vte`
- Storage: `rusqlite` with SQLite, FTS5 enabled
- Compression for large append-only logs: `zstd`
- Path and glob handling: `camino`, `globset`
- Fast text search and ranking helpers: SQLite FTS5 first, Tantivy only if FTS5 fails benchmark targets

### 2.2 TypeScript Host and UI

- Language: TypeScript strict mode
- UI framework: React
- State management: Zustand or Redux Toolkit, with event-log-derived state as the primary model
- Data fetching and command/query cache: TanStack Query where asynchronous host interactions benefit
- Virtualized rendering: TanStack Virtual
- Terminal rendering: custom Rust VT engine (`quanta-vt` + `quanta-block`) emits a
  `GridMirror` that the TypeScript `TerminalCanvas` widget renders via a
  Canvas2D backend (see RFC 0001, EPIC-D / EPIC-I). `xterm.js` was used as a
  Phase-1 bootstrap and retired in EPIC-I after the custom engine cleared the
  CJK / IME / alt-screen / resize / compat / telemetry / perf gates.
- Multi-line command composer: CodeMirror 6
- Schema validation: `zod`
- Testing: Vitest for unit/component tests, Playwright for end-to-end

### 2.3 IDE Integration

Quanta runs in two explicit host modes. See [ADR 0001](./adr/0001-host-modes.md) for the full contract.

- Mode A (Phase 1 first): VS Code-compatible extension host.
- Mode B: Tauri desktop host with an embedded React UI.

Both modes share the same Rust core and React UI. Host-specific concerns are confined to adapter interfaces; the core never calls the host directly.

Host abstraction boundary:

- `EditorBridge` interface for open/reveal/focus/highlight/back-navigation
- `WorkspaceBridge` interface for cwd, file context, root detection, task metadata, and terminal permissions
- `SidecarSupervisor` interface for spawn/kill/restart and crash event surfacing (see [ADR 0004](./adr/0004-sidecar-lifecycle-contract.md))
- `HostCapabilities` flags for features that make sense only on one host
- future JetBrains or custom IDE adapters must implement these interfaces without changing core domain contracts

### 2.4 IPC and Protocol

Reference choice:

- control plane: JSON-RPC 2.0
- event/data plane: framed MessagePack stream
- local transport: Unix domain socket in production, stdio fallback in development/tests

Rationale:

- JSON-RPC keeps command/query operations inspectable
- MessagePack avoids JSON overhead for high-frequency output events
- sidecar transport isolates the Rust core from extension host stalls and crashes

### 2.5 Persistence

Reference choice:

- append-only event log on disk
- SQLite materialized store for sessions, blocks, diagnostics, suggestions, and lineage
- FTS5 virtual tables for block/output/diagnostic search

Reference storage layout:

- `events/` for append-only segmented event logs
- `quanta.db` for queryable state
- `blobs/` for optional large-output spill files if output exceeds configured inline storage thresholds

Concrete paths, workspace scoping, retention defaults, delete semantics, corruption recovery, quotas, and migration policy are specified in [ADR 0005 — Storage and Retention](./adr/0005-storage-and-retention.md).

### 2.6 Optional Assist Integration

Reference choice:

- provider-agnostic assist orchestration in TypeScript host
- deterministic policy and risk gating shared through versioned schemas
- prompts grounded on persisted block artifacts, diagnostics, and explicit workspace context selections

Assist integration is not allowed to own execution or terminal truth.

## 3. Why This Stack

This stack is the default because it optimizes for the actual hard parts:

- `tokio` and Rust sidecar isolation preserve responsiveness under sustained stream load
- direct Unix PTY ownership via `nix` avoids opaque abstraction limits when session semantics get tricky
- SQLite + FTS5 gives durable local-first search, strong debuggability, and simple packaging
- renderer abstraction prevents the frontend renderer from becoming the semantic source of terminal truth
- React plus virtualization can render block-heavy history without rebuilding terminal semantics in the browser
- CodeMirror 6 is materially better than a textarea for multi-line shell/intention composition

## 4. Terminal Excellence Contract

Quanta must target a 2026 top-tier terminal bar before any assistive layer is considered complete.

### 4.1 Protocol and Interaction Surface

Phase-1 or near-Phase-1 terminal capability target:

- true color and modern ANSI attribute coverage
- bracketed paste
- alternate screen support
- focus in and focus out reporting
- SGR mouse reporting
- OSC 8 hyperlinks
- OSC 133 shell integration markers
- VS Code-style OSC 633 shell integration compatibility where applicable
- correct cwd and command boundary tracking via shell integration
- Kitty graphics protocol as a target compatibility direction, even if initial support is partial

### 4.2 Text and Rendering Correctness

Quanta should explicitly target:

- Unicode grapheme cluster correctness
- emoji and multi-codepoint width correctness
- font fallback and color emoji handling
- large scrollback responsiveness under sustained output
- deterministic raw mode behavior for TUIs and interactive shells

### 4.3 Benchmark Matrix

Use these references intentionally:

- Ghostty for GPU-forward native terminal quality and shell integration expectations
- WezTerm for terminal power-user breadth, panes, protocol ambition, and graphics compatibility
- VS Code integrated terminal for IDE-linked shell integration and recovery loops
- Warp for structured command review ergonomics
- kitty graphics protocol ecosystem for forward-looking graphics support

## 5. System Components

The repository layout — backend domain slicing with hexagonal ports/adapters, frontend domain slicing with Feature-Sliced Design — is specified in [ADR 0014 — Repository Structure](./adr/0014-repository-structure.md). This section sketches the shape; the ADR owns the enforceable details, including the dependency rules CI enforces.

### 5.1 Rust Workspace Layout (overview)

Each crate is one domain. Inside every domain crate:

- `src/domain/` — pure types, invariants, reducers. No IO.
- `src/ports/` — traits the domain calls out through.
- `src/adapters/` — concrete implementations of the ports.

Domain crates:

- `quanta-proto` — shared schema types and versioned protocol definitions.
- `quanta-pty` — PTY and process lifecycle. Adapters wrap `nix` / `portable-pty`.
- `quanta-session` — terminal session actor and tiered metadata (see [ADR 0003](./adr/0003-session-metadata-truth-model.md)).
- `quanta-block` — block aggregate and state machine (see [ADR 0002](./adr/0002-execution-boundary-contract.md), [ADR 0008](./adr/0008-raw-tui-mode-semantics.md)).
- `quanta-output` — span storage with ANSI retention and truncation rules.
- `quanta-events` — append-only log and replay (see [ADR 0011](./adr/0011-event-replay-and-reducer-semantics.md)).
- `quanta-diagnostic` — parser adapter trait in `ports/`, one adapter per tool in `adapters/` (see [ADR 0007](./adr/0007-parser-rollout-plan.md)).
- `quanta-suggestion` — optional-assist proposal aggregate and risk classifier (see [ADR 0012](./adr/0012-risk-classification-composition.md)).
- `quanta-history` — SQLite store, FTS index, blob spill, relevance (see [ADR 0005](./adr/0005-storage-and-retention.md), [ADR 0013](./adr/0013-history-search-and-relevance.md)).
- `quanta-security` — secret taxonomy, detectors, redaction (see [ADR 0006](./adr/0006-secret-and-sensitive-data-policy.md)).
- `quanta-protocol` — IPC control plane (JSON-RPC) and event plane (MessagePack).
- `quanta-lifecycle` — sidecar handshake, heartbeat, crash recovery (see [ADR 0004](./adr/0004-sidecar-lifecycle-contract.md)).
- `quanta-core` — composition root. Only crate that imports every adapter; wires ports at boot.
- `quanta-cli-dev` — developer harness and fixture runners.

Cross-crate rule: one domain may depend on another domain's `domain/` and `ports/`, never on its `adapters/`. CI enforces. See ADR 0014 for the full rule set and the enforcement script.

### 5.2 TypeScript Package Layout (overview)

Frontend uses Feature-Sliced Design with the same domain vocabulary as the backend. FSD layers (top → bottom): `app`, `processes`, `pages`, `widgets`, `features`, `entities`, `shared`.

Packages:

- `packages/ui/` — host-agnostic React UI.
  - `src/app/` bootstrap and providers.
  - `src/processes/` multi-step flows (onboarding, shell-integration install).
  - `src/pages/` route-level compositions.
  - `src/widgets/` composed UI (BlockList, Composer, DiagnosticPanel, SuggestionReview, SidecarStatus).
  - `src/features/<domain>/<action>/` user-triggerable actions; domain names match backend (`block`, `composer`, `suggestion`, `diagnostic`, `history`).
  - `src/entities/<domain>/` domain nouns (`block`, `session`, `diagnostic`, `suggestion`, `output-span`, `event`).
  - `src/shared/ui/` primitives, including Badge / Banner / Tooltip per [ADR 0010](./adr/0010-degraded-mode-ui-contract.md).
  - `src/shared/api/` host-bridge client.
  - `src/shared/types/generated/` TypeScript types generated from `quanta-proto`.
- `packages/host-common/` — shared host interfaces.
- `packages/host-vscode/` — Mode A adapter (see [ADR 0001](./adr/0001-host-modes.md)).
- `packages/host-tauri/` — Mode B adapter.

FSD rule: a layer may only import from layers below it; cross-slice imports within the same layer are forbidden. The UI package may import only from `host-common`; host-specific imports are CI-rejected.

## 6. Runtime Data Flow

### 6.1 Command Execution Path

1. User submits shell input from the shared composer.
2. TypeScript host sends `input.submit` RPC to Rust.
3. Rust creates a block, appends `block.created`, and starts the PTY write/spawn path.
4. Rust streams `output.chunk` and lifecycle events over the event channel.
5. Rust block reducer materializes state and persists both events and queryable projections.
6. Diagnostics pipeline consumes output spans incrementally and emits `diagnostic.detected`.
7. UI updates from replayable events, not from ad hoc DOM inspection.

### 6.2 Optional Natural Language Suggestion Path

1. User submits natural language input.
2. Host classifier returns `natural_language_intent` or `ambiguous_requires_user_choice`.
3. Host optional assist orchestration generates one or more suggestions grounded on block/workspace context.
4. Risk classifier labels each suggestion.
5. UI shows preview, explanation, warnings, and explicit approval steps.
6. Only approved suggestions are sent back as executable shell input, creating a normal block.

### 6.3 Error-to-Code Path

1. Diagnostics pipeline emits normalized file and line locations.
2. UI renders clickable diagnostics attached to output spans and block headers.
3. `EditorBridge.openLocation` opens the file and highlights the relevant range.
4. Host records a jump-back handle to the originating block.
5. User returns to the originating block and reruns or compares against the new result.

## 7. Event-Sourced Core

Quanta should use event sourcing for terminal truth and derived projections for fast UX.

### 7.1 Append-Only Event Log

Required properties:

- every session has a monotonic event sequence
- events are immutable after commit
- replay can rebuild block state exactly
- replay output is deterministic for a fixed schema version

### 7.2 Materialized Projections

Required projections:

- session summary projection
- block summary projection
- block detail projection
- diagnostic projection
- rerun lineage projection
- search projection
- suggestion review projection

Projection rebuild must be possible from the event log without hidden external state.

## 8. PTY Architecture

### 8.1 Session Model

Each terminal tab owns one Rust session actor with:

- PTY master handle
- shell child process metadata
- current cwd snapshot (see [ADR 0003](./adr/0003-session-metadata-truth-model.md) for the confidence tiers that cover cwd, env, and shell state)
- launch env (Phase 1); live env delta is explicitly out of scope
- process group and signal routing info
- active block reducer (see [ADR 0002](./adr/0002-execution-boundary-contract.md) for boundary semantics)

### 8.2 Actor Model

Recommended backend concurrency shape:

- one session actor per live terminal session
- one diagnostics worker pool for parser execution
- one persistence worker for batched event/store writes
- one indexer worker for search updates

This avoids lock-heavy global coordination in the hot path.

### 8.3 TUI Handling

Full-screen TUI apps prioritize raw mode over structured enrichment. The concrete contract — detection, transcript retention, enrichment suspension scope, block typing, replay behavior — is specified in [ADR 0008 — Raw / TUI Mode Semantics](./adr/0008-raw-tui-mode-semantics.md).

Requirements carried forward:

- maintain byte-perfect PTY flow
- continue coarse event capture
- defer expensive enrichment until TUI exit
- preserve entry and exit boundaries in the block/event model
- retain a bounded TUI raw blob for replay

### 8.4 Sidecar Lifecycle

Sidecar boot, versioning handshake, heartbeat, crash recovery, orphaned session handling, and upgrade migration are specified in [ADR 0004 — Sidecar Lifecycle Contract](./adr/0004-sidecar-lifecycle-contract.md). Every long-running operation in the sidecar must be crash-safe via the event log.

## 9. Diagnostic Pipeline

### 9.1 Design

The pipeline must be adapter-driven and confidence-scored.

Stages:

1. output chunk normalization
2. parser adapter matching
3. structured parse extraction
4. location normalization
5. duplicate merge and confidence scoring
6. projection update and UI emission

### 9.2 Parser Adapter Contract

Each adapter should declare:

- `adapter_id`
- supported tool families
- input assumptions
- parse function returning structured candidates
- confidence priors
- normalization rules
- fixture corpus

### 9.3 Non-Negotiable Rule

Regex-only global scraping is not an acceptable system design. Regex can exist inside a parser adapter, but the system must remain multi-parser, provenance-aware, and confidence-ranked.

### 9.4 Rollout and Accuracy Targets

Which parsers ship when, accuracy bars, latency targets, and fixture corpus expectations are specified in [ADR 0007 — Diagnostic Parser Rollout Plan](./adr/0007-parser-rollout-plan.md). Precision > recall is the operating principle; a wrong file jump is worse than a missing one.

## 10. Search and History Architecture

### 10.1 Canonical Store

SQLite is the canonical query store for local history because it is:

- embeddable
- durable
- easy to inspect
- strong for metadata filtering
- sufficient for FTS-backed search at the target scale

### 10.2 Indexing Strategy

Index the following fields:

- command text
- normalized output text
- diagnostic message
- file path
- labels
- cwd
- session id
- exit status
- parser category

### 10.3 Retention

Default policy:

- recent sessions remain fully queryable
- large raw outputs may spill to compressed blobs while preserving block summaries and searchability
- deletion removes both projection rows and search index rows

Concrete defaults (retention windows, blob spill threshold, delete semantics, corruption recovery, quotas) are specified in [ADR 0005 — Storage and Retention](./adr/0005-storage-and-retention.md). History is workspace-scoped by default; cross-workspace search is an opt-in surface.

## 11. Frontend Architecture

### 11.1 Rendering Split

The UI has two primary rendering systems:

- raw terminal surface for PTY-faithful interaction and TUI mode
- block surface for structured execution review, compare, search, and optional assist actions

Neither surface is allowed to invent backend truth.

### 11.2 State Model

Recommended pattern:

- backend events feed a normalized client store
- UI selectors derive views from canonical event-backed entities
- ephemeral UI state stays separate from persisted execution state

Persist locally in the frontend only:

- panel layout
- collapse state
- sort order
- open compare panes
- non-sensitive draft input

### 11.3 Performance Rules

- virtualize block lists and long output views
- batch UI updates from high-frequency output events
- do not trigger React re-render per output byte or per ANSI token
- preserve input responsiveness above all non-essential enrichment

## 12. IDE Bridge Architecture

### 12.1 Required Host Capabilities

- open file at line and column
- reveal range
- focus terminal view
- capture current file and selection context
- resolve workspace roots
- manage sidecar lifecycle

### 12.2 Navigation Contract

Every terminal-to-editor jump should create a reversible navigation record:

- originating `session_id`
- originating `block_id`
- target file/range
- jump timestamp
- return affordance metadata

## 13. Optional Assist Architecture

### 13.1 Responsibility Boundaries

Assist may:

- classify intent vs shell input
- explain commands
- summarize a block
- answer follow-up questions grounded to block data
- propose commands with risk labels

Assist may not:

- mutate canonical terminal truth
- silently execute commands
- bypass risk review gates
- persist secrets into summaries or telemetry

### 13.2 Context Assembly

Prompt context should be explicitly assembled from:

- current block artifact
- selected prior blocks
- diagnostics
- current file/workspace metadata approved for use
- saved actions if relevant

Never dump arbitrary repo contents by default.

### 13.3 Risk Classifier

Use a deterministic policy layer before or alongside LLM judgment.

Signals include:

- file writes
- package manager mutations
- shell redirection
- process kill or privilege escalation
- network egress
- recursive deletion patterns
- credential-like tokens in arguments

### 13.4 Input Routing

The shared input surface uses an explicit classifier, not ad hoc host heuristics. Explicit prefixes (`/cmd`, `/ask`), confidence thresholds, the ambiguity budget, chooser-UI rules, and correction paths are specified in [ADR 0009 — Input Routing Operational Policy](./adr/0009-input-routing-policy.md). Routing is local and fast; no provider round-trip is on the submit path.

## 14. Security and Privacy

Secret classes, detection ruleset, placement of redaction, manual reveal flow, export and share sanitization, and AI provider data handling modes are specified in [ADR 0006 — Secret and Sensitive Data Policy](./adr/0006-secret-and-sensitive-data-policy.md). This section is an overview.

### 14.1 Secret Handling

- redact env and command arguments that match secret policies before persistence
- keep raw in-memory access bounded to active session needs
- never place raw secrets into assist prompts unless explicitly approved
- surface redaction markers so users can verify the policy is not over-redacting

### 14.2 Local-First Principle

- execution artifacts stay local by default
- assist calls send the minimum required grounded context
- telemetry, if any, must be opt-in and redact-sensitive

## 15. Observability

Use structured tracing across host and core.

Required categories:

- PTY lifecycle
- session lifecycle
- parser timings
- event transport latency
- projection lag
- UI render latency
- assist request/response timing and policy outcomes

Observability is for debugging and benchmark enforcement, not for replacing product metrics.

## 16. Packaging and Delivery

### 16.1 Phase-1 Packaging

- ship Rust sidecar binaries bundled with the IDE extension
- produce artifacts for macOS arm64, macOS x64, and Linux x64 first
- prefer reproducible release builds and signed artifacts where host distribution requires it

### 16.2 Build Tooling

- Rust workspace with `cargo`
- TypeScript workspace with `pnpm`
- shared schema codegen only if it materially reduces drift; otherwise keep schemas hand-authored and tightly versioned

## 17. ADR-Level Decisions

These are the default architectural decisions unless superseded by a dated ADR under [`docs/adr/`](./adr/):

- backend is a Rust sidecar, not an in-process WASM core
- canonical persistence is append-only event log plus SQLite projections (see [ADR 0005](./adr/0005-storage-and-retention.md))
- terminal rendering is owned end-to-end by the custom Rust VT engine — block truth is derived from Rust event artifacts and the canvas renderer consumes the engine's `GridMirror` directly (RFC 0001, EPIC-I); the transitional xterm.js bootstrap was retired after EPIC-I
- two explicit host modes, one canonical core (see [ADR 0001](./adr/0001-host-modes.md))
- IDE host integration starts with a VS Code-compatible adapter interface
- optional assist orchestration lives in the TypeScript host, while execution and persistence stay outside assist control
- block boundary is OSC 133-primary with an explicit degraded fallback (see [ADR 0002](./adr/0002-execution-boundary-contract.md))
- session metadata is tiered by confidence; env delta is out of scope for Phase 1 (see [ADR 0003](./adr/0003-session-metadata-truth-model.md))
- sidecar lifecycle is contracted, including crash recovery and version handshake (see [ADR 0004](./adr/0004-sidecar-lifecycle-contract.md))
- secrets are policy-governed with explicit reveal and audit (see [ADR 0006](./adr/0006-secret-and-sensitive-data-policy.md))
- parser rollout is tiered with precision > recall (see [ADR 0007](./adr/0007-parser-rollout-plan.md))
- TUI sessions have distinct block sub-state and bounded raw-blob retention (see [ADR 0008](./adr/0008-raw-tui-mode-semantics.md))
- input routing is local, deterministic, and bounded by an ambiguity budget (see [ADR 0009](./adr/0009-input-routing-policy.md))
- degraded states render through a fixed badge / tooltip / banner taxonomy (see [ADR 0010](./adr/0010-degraded-mode-ui-contract.md))
- delivery is at-least-once with idempotent, deterministic reducers and snapshot-accelerated replay (see [ADR 0011](./adr/0011-event-replay-and-reducer-semantics.md))
- risk classification composes deterministically; unknown parse escalates and never downgrades (see [ADR 0012](./adr/0012-risk-classification-composition.md))
- history search runs BM25 plus a small explicit rerank, workspace-scoped by default (see [ADR 0013](./adr/0013-history-search-and-relevance.md))
- repo layout is backend domain+hexagonal and frontend domain+FSD, enforced by CI (see [ADR 0014](./adr/0014-repository-structure.md))

## 18. First Implementation Blueprint

### 18.1 Milestone A

- stand up Rust sidecar transport
- establish versioned event schema
- implement one PTY-backed shell session
- persist append-only events and minimal block projection

### 18.2 Milestone B

- add block list and raw terminal dual rendering
- add rerun lineage
- add SQLite FTS5 search
- add fixture-driven diagnostics for Rust and TypeScript

### 18.3 Milestone C

- add editor navigation bridge
- add compare view
- deepen shell integration and protocol compatibility
- add graphics/protocol benchmark validation

### 18.4 Milestone D

- add natural-language suggestion flow with approval gates as optional placeholder
- add block-scoped summary and Q&A as optional placeholder

# Quanta Terminal Product Spec

> **Architectural contracts:** the parts of the system where implementers would otherwise drift live under [`docs/adr/`](./adr/). When this spec is aspirational and an ADR is concrete, the ADR wins.

## 0. Executive Summary (KR)

Quanta Terminal은 IDE-like 환경에 내장되는 현대적 터미널이며, Rust 기반 PTY 코어와 TypeScript 프론트엔드 위에서 동작한다.

핵심은 일반 터미널과의 호환성을 깨지 않으면서, 모든 실행을 구조화된 block으로 승격하는 것이다. AI는 제품 정의의 중심이 아니라 후순위 부가 계층이다.

제품 목표는 Ghostty, WezTerm, VS Code integrated terminal, kitty graphics protocol ecosystem, Warp를 함께 참고하는 benchmark matrix를 기준으로 삼되, IDE 연결성, 에러에서 코드로 이동하는 디버깅 루프, 구조화된 실행 히스토리, protocol breadth, raw terminal trust에서는 명확히 앞서는 것이다. 실제 측정 방식은 [benchmark-protocol.md](./benchmark-protocol.md)에 고정되어 있다.

호스트 배포는 VS Code 호환 extension 모드와 Tauri 데스크톱 모드 두 가지로 명확히 갈라져 있으며, 둘은 동일한 Rust core와 React UI를 공유한다. 자세한 경계는 [ADR 0001](./adr/0001-host-modes.md)을 본다.

## 1. Product Definition

Quanta Terminal is a modern terminal built inside an IDE-like environment.

It is not a replacement for PTY semantics. It is a PTY-compatible terminal system that adds:

- block-oriented execution UX
- modern terminal protocol support and shell integration
- IDE-linked error and result navigation
- optional assistive workflows with explicit human approval before execution

The product bar is not "better shell history" or "pretty logs". The target is a terminal that remains compatible with standard shell workflows while materially improving fidelity, protocol coverage, execution readability, traceability, and recovery speed compared to mainstream integrated terminals.

## 2. Product Vision

Build the best general-purpose IDE terminal that still behaves like a real terminal.

Success condition:

- existing shell, CLI, and PTY workflows continue to work
- command runs become structured, searchable, and reusable execution artifacts
- long logs and failures become navigable without hiding raw truth
- users can move from terminal failure to code fix to rerun in one tight loop
- optional natural language can exist as a safe proposal layer, never as a product-defining crutch

## 3. Strategic Positioning

### 3.1 Category

IDE-embedded, PTY-compatible, terminal-first execution environment with optional assistive layers.

### 3.2 Benchmark Target

Use a benchmark matrix instead of a single product proxy.

Reference set:

- Ghostty for native feel, GPU-forward rendering direction, and shell integration expectations
- WezTerm for protocol breadth, multiplexing expectations, and terminal power-user ergonomics
- VS Code integrated terminal for IDE-shell integration and editor-linked recovery flows
- kitty graphics protocol ecosystem for modern graphics/protocol compatibility bar
- Warp for block readability and command review ergonomics

Operational measurement (tasks, fixtures, user segments, parity vs superiority targets) lives in [benchmark-protocol.md](./benchmark-protocol.md).

Quanta Terminal must exceed the benchmark matrix on:

- IDE-context integration
- code navigation from errors and logs
- structured execution history as reusable knowledge
- rerun and compare workflows across execution blocks
- terminal responsiveness
- command block readability
- command recall and re-execution UX
- multi-line composition UX
- Unicode, grapheme, emoji, and width correctness
- terminal protocol compatibility and shell integration semantics
- raw terminal trust for TUI and interactive applications

AI-related UX is explicitly non-primary in Phase 1.

### 3.3 Non-goals

- breaking shell behavior for the sake of UI structure
- forcing users into AI-first flows
- hiding raw output behind summaries
- replacing TUI/full-screen apps with partial emulation

## 4. Product Principles

1. PTY truth is the source of truth.
2. Structured UX is layered on top of raw execution, never the reverse.
3. Terminal excellence outranks AI convenience.
4. IDE integration must accelerate debugging, not add ceremony.
5. No naive heuristics as primary architecture for parsing, error detection, or intent routing.
6. If block parsing or enrichment fails, command execution still succeeds.

## 5. Primary Users

### 5.1 Core user

Developers working inside an IDE who repeatedly run build, test, lint, package, server, infra, and debugging workflows.

### 5.2 High-value scenarios

- iterative local development
- compiler and test failure diagnosis
- long-running logs and service output inspection
- repo-specific workflow acceleration with minimal ceremony

## 6. Technical Product Assumptions

### 6.1 Stack

- Core terminal engine: Rust
- Frontend UI: TypeScript / React
- Host integration: two explicit modes (VS Code-compatible extension, Tauri desktop) sharing one core — see [ADR 0001](./adr/0001-host-modes.md)
- Reference technical architecture and stack decisions: [technical-architecture.md](./technical-architecture.md)

### 6.2 System shape

The product should be designed as a layered system:

1. PTY execution layer in Rust
2. stream capture and event model in Rust
3. structured execution/block model in Rust
4. enrichment services for parsing, error extraction, and metadata derivation
5. frontend renderer and interaction model in TypeScript
6. optional assist layer for intent understanding, summarization, and command suggestion
7. IDE bridge for file/line navigation and workspace context injection

### 6.3 Architectural stance

- PTY compatibility is a hard constraint
- block model is a first-class domain object, not a frontend-only rendering trick
- raw stream and rendered block views must coexist
- enrichment should be incremental and attach metadata without mutating raw truth
- session state must persist independently from rendered views

## 7. Core Domain Model

### 7.1 Session

A session represents one live terminal context.

Required fields:

- session id
- shell type
- launch cwd (authoritative, per [ADR 0003](./adr/0003-session-metadata-truth-model.md))
- current cwd with `cwd_source ∈ { launch, osc7, prompt_estimate, unknown }`
- launch env (redacted per [ADR 0006](./adr/0006-secret-and-sensitive-data-policy.md))
- shell integration status (installed, missing, partial)
- start time
- active process tree metadata
- session history pointer
- workspace fingerprint (scopes history and search, per [ADR 0005](./adr/0005-storage-and-retention.md))

Phase 1 does not track live env delta. That decision is explicit in ADR 0003; "env delta" and "environment mutation tracking" are not Phase-1 capabilities and should not appear in Phase-1 designs.

### 7.2 Command Block

A command block is the primary execution artifact.

Required fields:

- block id
- session id
- `kind ∈ { command, tui_session, detached }` (see [ADR 0008](./adr/0008-raw-tui-mode-semantics.md))
- `sub_state ∈ { none, tui_mixed }`
- command text (raw) and resolved redacted command
- input mode: shell or natural-language intent
- execution state (see §19.3 lifecycle state machine)
- stdout segments
- stderr segments
- exit code with `exit_code_source ∈ { osc133, child_exit, prompt_regex_estimate, unknown }`
- termination signal if any
- start time
- end time
- duration
- cwd with `cwd_source` (per [ADR 0003](./adr/0003-session-metadata-truth-model.md))
- launch env snapshot (redacted, per [ADR 0006](./adr/0006-secret-and-sensitive-data-policy.md))
- `boundary_signal ∈ { osc133, child_exit, prompt_regex }`
- `boundary_confidence ∈ { authoritative, degraded }` (see [ADR 0002](./adr/0002-execution-boundary-contract.md))
- `is_compound: bool`, `is_background: bool`, `background_children: block_id[]`
- TUI metadata when applicable: `tui_entered_at`, `tui_exited_at`, `tui_bytes_written`, `tui_blob_id`, `unclean_exit`
- `detached_reason` if applicable (for example `sidecar_crash`, per [ADR 0004](./adr/0004-sidecar-lifecycle-contract.md))
- derived diagnostics
- links to code locations
- optional summaries and follow-up conversation references
- rerun lineage
- pin and label metadata

Fields such as "env summary" and "env delta" are not part of the Phase-1 block schema. See ADR 0003.

### 7.3 Diagnostic

Structured error/warning/navigation entity extracted from execution output.

Required fields:

- severity
- parser source
- file path
- line
- column
- message
- symbol if available
- confidence
- originating output span

### 7.4 Suggested Command

Assist-generated or context-generated execution proposal.

Required fields:

- suggestion id
- source intent
- command
- explanation
- risk classification
- destructive action flags
- required confirmation level
- applicable context

## 8. Functional Requirements

## 8.1 Epic A. Core Terminal Usability

### US-A1. Command Execution

Users can input and execute shell commands inside the IDE.

Acceptance criteria:

- shell command input and execution is supported
- commands run inside a real PTY session
- stdout, stderr, and exit code are captured
- cwd and environment context are preserved

### US-A2. PTY Compatibility

Users can keep normal shell workflows without behavioral breakage.

Acceptance criteria:

- bash, zsh, and standard shell behavior are preserved
- interactive commands are supported
- copy, paste, cursor movement, and shortcuts behave naturally
- full-screen TUI support is explicitly defined as supported, separate mode, or limited

### US-A3. Multi-line Input

Users can compose complex multi-line commands before execution.

Acceptance criteria:

- input area supports multi-line editing
- newline insertion is distinct from execute action
- long commands do not require single-line composition

### US-A4. Session Persistence

Users can continue work without losing local context.

Acceptance criteria:

- session-specific cwd persists
- session-specific env persists
- history and context persist until session close
- multiple sessions are supported

## 8.2 Epic B. Block-Based Execution Experience

### US-B1. Command Blocking

Each execution is grouped into a structured command block.

Acceptance criteria:

- each run maps to exactly one command block
- block contains command, output, exit code, duration, and timestamp
- block boundaries are visually and semantically clear
- block can be collapsed and expanded

### US-B2. Block Rerun

Users can rerun a previous block quickly.

Acceptance criteria:

- each block exposes rerun action
- rerun re-executes the original command
- same-session and new-session rerun policy is supported or clearly specified

### US-B3. Block Search

Users can search past execution blocks.

Acceptance criteria:

- search by command text
- search by output content
- filter by exit status, time, and metadata
- search operates on structured blocks, not only flat shell history
- workspace-scoped by default; global-history search is opt-in
- results ranked by a deterministic relevance formula, not raw SQL order

Query syntax, relevance weights, dedupe, and pinned-block promotion are specified in [ADR 0013 — History Search and Relevance](./adr/0013-history-search-and-relevance.md).

### US-B4. Block Pinning and Organization

Users can preserve important execution blocks.

Acceptance criteria:

- pin specific blocks
- apply labels or tags
- pinned blocks are available in a dedicated retrieval surface

## 8.3 Epic C. Error Understanding and Recovery

### US-C1. Automatic Error Detection

The terminal detects likely failures without requiring users to manually scan full output.

Acceptance criteria:

- error state is inferred from stderr and output patterns
- exit code and output patterns are jointly used
- the design avoids simplistic string matching as the sole criterion

### US-C2. Error Summarization

Long failures are summarized without obscuring the original log.

Acceptance criteria:

- core failure message is extracted from long logs
- summary is shown alongside full raw output
- summary emphasizes noise reduction and likely causes

### US-C3. Fix Suggestions

The terminal proposes likely next steps for common failure types.

Acceptance criteria:

- suggestions are aligned to detected error types
- proposals may be commands or explanatory guidance
- preview is shown before any execution

### US-C4. Jump From Error to Code

Users can jump directly from error output to file and line.

Acceptance criteria:

- file and line are extracted from stack traces, compiler errors, and lint errors
- clicking navigates to the file position
- related symbol highlighting is supported where possible

## 8.4 Epic D. Natural Language Input and Command Suggestion

### US-D1. Optional Natural Language Input

Users can type natural language into the same input surface.

Acceptance criteria:

- the input accepts both shell commands and natural language
- the system distinguishes shell command from intent input
- intent input goes to suggestion flow instead of immediate execution

### US-D2. Optional Natural Language Command Suggestion

Natural language requests produce one or more command suggestions.

Acceptance criteria:

- at least one command suggestion is produced for natural language input
- each suggestion is previewable before execution
- users can accept, edit, or cancel

### US-D3. Optional Command Explanation

Users understand what a suggestion does before running it.

Acceptance criteria:

- each suggestion includes explanation
- destructive commands show warning state
- high-risk actions can require extra confirmation

### US-D4. Optional Context-Aware Workflow Suggestions

The terminal suggests common actions from repo and runtime context.

Acceptance criteria:

- suggestions can use repo, file, and error context
- common workflows include build, test, install, port kill, and process inspection
- suggestions remain assistive rather than intrusive

## 8.5 Epic E. IDE Integration

### US-E1. Link Results to Code

Execution results connect to editor locations where possible.

Acceptance criteria:

- logs and errors become clickable links when code locations are identifiable
- clicking opens the editor at the right location
- users can easily return from code to terminal block context

### US-E2. IDE Context-Aware Suggestions

Assistance uses current file and project context.

Acceptance criteria:

- current file, workspace root, and package manager context can be used
- suggestions never auto-execute
- the scope of context usage can be explicitly limited

### US-E3. Error-Fix-Rerun Loop

Users can move from failure to code to rerun in a single loop.

Acceptance criteria:

- error block supports file navigation
- after edit, rerun is directly available
- rerun result can be compared with previous run

## 8.6 Epic F. Execution History and Reuse

### US-F1. Structured History

Execution history is stored as structured knowledge.

Acceptance criteria:

- history is stored as structured blocks instead of plain strings
- blocks can store timestamp, cwd, env summary, and exit status
- important runs can be rerun or duplicated

### US-F2. Saved Actions

Reusable commands or blocks can be saved as explicit actions.

Acceptance criteria:

- block or command can be saved as reusable action
- saved action supports name and description
- execution preview is available before run

### US-F3. Result Comparison

Reruns can be compared against previous runs.

Acceptance criteria:

- exit status comparison is available
- output diff or summary diff is available
- duration change is visible

## 8.7 Epic G. Optional Assistance Usability

### US-G1. Block-Scoped Summarization

Users can optionally ask the assist layer to summarize a specific block.

Acceptance criteria:

- summarize action is available on a block
- summary scope is limited to that block
- summary and raw output are both accessible

### US-G2. Block-Scoped Follow-Up Questions

Users can ask contextual questions about a specific execution block.

Acceptance criteria:

- users can ask questions such as why it failed, how to fix it, or what to do next
- scope can distinguish current block from full session

### US-G3. Safe Assist Execution Proposals

Assist-generated commands are reviewed before execution when the optional assist layer is enabled.

Acceptance criteria:

- assist-generated commands never auto-execute
- execution requires explicit user approval
- destructive commands can trigger elevated warnings

## 8.8 Epic H. Management and Non-Functional Requirements

### US-H1. Performance

The terminal remains responsive under large outputs.

Acceptance criteria:

- large logs do not freeze the UI
- block rendering is decoupled from raw stream handling
- virtualization or chunked rendering strategy exists

### US-H2. Raw Truth Preservation

Users always retain access to raw terminal output.

Acceptance criteria:

- raw output is available for every block
- summaries and analysis are overlays on top of raw output
- users can switch between block view and raw view

### US-H3. Mode Switching

A fallback mode closer to a traditional terminal exists.

Acceptance criteria:

- at least one fallback mode is provided in addition to block mode
- even if block parsing fails, execution still works normally

## 9. Priority (Strategic Importance)

Priority is the strategic importance of each capability to the finished product. It is *not* a build order. Build order lives in §17. First-ship scope lives in §19.14. The three must not be conflated; if they disagree, each owns its own question:

- **Priority (this section)** — which capabilities matter most for the product's eventual value?
- **Sequencing (§17)** — in what order do we build, given substrate dependencies?
- **Phase-1 Definition of Done (§19.14)** — what is the minimum cut to call Phase 1 shipped?

A P0 capability can be scheduled for a later phase if its substrate is not yet ready. That is expected, not a contradiction.

### P0

- US-A1 Command Execution
- US-A2 PTY Compatibility
- US-A3 Multi-line Input
- US-B1 Command Blocking
- US-B2 Block Rerun
- US-C1 Automatic Error Detection
- US-C2 Error Summarization
- US-C4 Jump From Error to Code
- US-H2 Raw Truth Preservation

### P1

- US-B3 Block Search
- US-B4 Block Pinning and Organization
- US-C3 Fix Suggestions
- US-E1 Stronger Result-to-Code Linking
- US-F1 Structured History

### P2

- US-D1 Optional Natural Language Input
- US-D2 Optional Natural Language Command Suggestion
- US-D3 Optional Command Explanation
- US-D4 Context-Aware Workflow Suggestions
- US-E2 IDE Context-Aware Suggestions
- US-E3 Error-Fix-Rerun Loop
- US-F2 Saved Actions
- US-F3 Result Comparison
- US-G1 Block-Scoped Summarization
- US-G2 Block-Scoped Follow-Up Questions
- US-G3 Safe Assist Execution Proposals
- US-H3 Mode Switching

## 10. Product Requirements by Capability Layer

### 10.1 PTY and Session Layer

- real PTY-backed execution
- shell compatibility across supported shells
- interactive input handling
- session persistence and multiplexing
- tiered session metadata (authoritative / shell-integrated / estimated / unknown) per [ADR 0003](./adr/0003-session-metadata-truth-model.md)
- no live env delta tracking in Phase 1

### 10.2 Stream and Block Layer

- lossless stdout/stderr capture
- execution boundary tracking
- block lifecycle state machine
- raw stream retention
- structured metadata attachment

### 10.3 Diagnostics Layer

- parser framework for compiler, linter, stack trace, and test output
- confidence-scored extraction instead of naive one-rule matching
- file/line/code-location normalization
- error state synthesis from multi-signal evidence

### 10.4 Optional Assist Layer

- command-vs-intent classification
- command suggestion generation
- explanation and risk annotation
- block-scoped summarization
- follow-up Q&A grounded to execution artifacts

### 10.5 IDE Integration Layer

- file/line navigation bridge
- current workspace and editor context access
- jump-back-to-terminal interaction
- rerun after code edit flow

### 10.6 History and Knowledge Layer

- durable storage of execution blocks
- indexed search
- saved actions
- lineage and rerun comparison

## 11. UX Requirements

### 11.1 Input UX

- one input surface for shell and natural language
- clear distinction between insert-newline and execute
- explicit prefixes (`/cmd`, `/ask`) available to bypass classification
- workspace-level default mode (shell, intent, auto) so power users pin behavior
- explicit preview when the system interprets input as intent
- zero ambiguity around what will execute

Routing policy, confidence thresholds, ambiguity budget, and correction paths are specified in [ADR 0009 — Input Routing Operational Policy](./adr/0009-input-routing-policy.md).

### 11.2 Block UX

- clear boundary per execution
- fast collapse and expand
- stable metadata row with command, status, duration, timestamp
- visible raw output access
- persistent actions: rerun, summarize, pin, copy

### 11.3 Safety UX

- explicit review step before any assist-generated execution
- destructive command detection with strong warnings
- no silent transformations of user-entered shell commands

### 11.4 Navigation UX

- clickable diagnostics
- fast return from code navigation back to source block
- compare current rerun with previous result in-place

### 11.5 Ambiguity Budget

The input router exists to reduce friction, not to prompt for clarification. Targets, measured per release:

- chooser UI fires on at most 5% of unprefixed submissions (alert at 10%)
- misroute rate at most 2% (alert at 5%)
- misroute is measured as "user corrected the route within 60 seconds via re-submission or an explicit switch action"

If either target degrades, the classifier is the problem, not the user. See [ADR 0009](./adr/0009-input-routing-policy.md).

## 12. Quality Bar

This product should be judged against SOTA terminal systems, not against basic integrated terminals.

Minimum quality bar:

- PTY fidelity high enough that developers trust it as a default terminal
- block model useful enough that users prefer it over flat scrollback
- terminal fidelity high enough that users trust Quanta over leading standalone terminals
- shell integration and protocol support deep enough to feel first-class in real projects
- IDE integration deep enough to reduce debugging loop time in real projects

## 13. Success Metrics

### 13.1 Product metrics

- time to identify the primary failure in long-output commands
- time from terminal error to opening the relevant file and line
- time from code edit to rerun completion
- successful retrieval rate for prior execution blocks
- destructive-command cancellation rate after warning review

### 13.2 Quality gates

- no regression on baseline PTY compatibility scenarios
- no loss of raw stdout/stderr fidelity
- no mandatory assist step for standard shell workflows
- large-output sessions remain responsive under benchmark loads

### 13.3 Adoption and retention

Task-efficiency metrics tell you whether Quanta *could* win; adoption metrics tell you whether users actually *stay*. Track both, per user segment and per release:

- default-terminal replacement rate — fraction of surveyed users who set Quanta as their daily terminal
- block-mode retention rate — fraction who remain in block mode after 7 days of use
- rerun feature usage rate
- block search usage rate
- AI suggestion acceptance rate after preview
- AI suggestion rejection-reason taxonomy (at minimum: wrong tool, risky, already-done, unclear)
- raw-mode fallback rate — fraction of sessions that drop out of block mode for reasons other than TUI entry
- TUI-triggered fallback frequency — informational, not a regression signal

Local telemetry captures these to the user's own profile; aggregate reporting is opt-in.

## 14. Architecture Guidance

### 14.1 Rust responsibilities

- PTY management
- process lifecycle and stream capture
- session state and persistence
- block lifecycle construction
- diagnostic extraction pipeline
- history storage and indexing
- frontend-facing API/event protocol

### 14.2 TypeScript responsibilities

- terminal surface and block rendering
- multi-line input UX
- suggestion and preview UI
- editor/workspace integration
- search, pinning, labels, compare, and navigation flows
- optional assist affordances and confirmation UX

### 14.3 Cross-layer contract

The frontend should not reconstruct terminal truth from rendered text. The Rust core should expose a stable event and artifact model:

- session events
- input events
- output chunk events
- execution started/completed events
- diagnostic extracted events
- suggestion created/accepted/rejected events
- rerun lineage events

Reference implementation detail, transport, storage, and module breakdown are defined in `docs/technical-architecture.md`.

## 15. Benchmarking Against the Terminal Benchmark Matrix

Quanta Terminal should benchmark against the reference set defined in `docs/terminal-benchmark-matrix.md`, with Warp treated as one reference rather than the sole proxy.

Core benchmark areas:

- command composition
- execution block readability
- block rerun speed and ergonomics
- large-log responsiveness
- error extraction accuracy
- code navigation from compiler and stack-trace output
- trust and clarity of destructive-command warnings
- structured history retrieval
- shell integration correctness
- protocol compatibility and raw-mode trust

Benchmark outcome target:

- parity on baseline terminal quality
- superiority on IDE-connected debugging and recovery workflows

## 16. Risks and Design Constraints

### 16.1 Key risks

- breaking PTY fidelity while chasing structured UX
- relying on brittle output parsing
- mixing raw truth and assist-derived summaries in a way that confuses users
- over-triggering assistive intervention and degrading terminal flow
- UI collapse under large outputs

### 16.2 Design constraints

- raw execution must remain accessible
- enrichment must be detachable from execution success
- assist-generated execution requires explicit approval
- full-screen/TUI behavior must be clearly specified, not implicitly broken

## 17. Recommended Delivery Sequencing (Build Order)

Sequencing is the order in which work is built, dictated by substrate dependencies. Items later in the sequence depend on earlier items being stable. This order does not redefine priorities (§9) or Phase-1 ship cut (§19.14); it captures what must be built first so that later work is even possible.

### Phase 1: Terminal Truth and Core Blocks

- US-A1
- US-A2
- US-A3
- US-A4
- US-B1
- US-H2

### Phase 2: Recovery and Navigation

- US-B2
- US-C1
- US-C2
- US-C4
- US-E1

### Phase 3: Terminal Excellence and Recovery Depth

- shell integration depth
- terminal protocol breadth
- richer diagnostics and code navigation
- compare and retrieval acceleration

### Phase 4: Durable Knowledge and Workflow Acceleration

- US-B3
- US-B4
- US-F1
- US-F2
- US-F3
- US-D4
- US-E2
- US-E3

### Phase 5: Optional Assist Placeholder

- US-D1
- US-D2
- US-D3
- US-G1
- US-G2
- US-G3

## 18. Open Decisions

Decisions previously listed here have graduated into ADRs. The ADRs are the binding source of truth.

- TUI/full-screen handling → [ADR 0008](./adr/0008-raw-tui-mode-semantics.md)
- Persistence, workspace scoping, retention, delete → [ADR 0005](./adr/0005-storage-and-retention.md)
- Input routing, classifier thresholds, ambiguity budget → [ADR 0009](./adr/0009-input-routing-policy.md)
- Shipped diagnostic parsers and rollout tiering → [ADR 0007](./adr/0007-parser-rollout-plan.md)
- Env / secret / sensitive-data policy → [ADR 0006](./adr/0006-secret-and-sensitive-data-policy.md) and [ADR 0003](./adr/0003-session-metadata-truth-model.md)
- Block boundary detection and shell integration dependency → [ADR 0002](./adr/0002-execution-boundary-contract.md)
- Sidecar lifecycle and recovery → [ADR 0004](./adr/0004-sidecar-lifecycle-contract.md)
- Host modes (extension vs Tauri) → [ADR 0001](./adr/0001-host-modes.md)
- Degraded-mode UI contract (badge, tooltip, banner taxonomy and gating) → [ADR 0010](./adr/0010-degraded-mode-ui-contract.md)
- Event replay, reducer determinism, resume, snapshots → [ADR 0011](./adr/0011-event-replay-and-reducer-semantics.md)
- Risk classification composition rules → [ADR 0012](./adr/0012-risk-classification-composition.md)
- History search and relevance ranking → [ADR 0013](./adr/0013-history-search-and-relevance.md)
- Repository structure (backend hexagonal by domain; frontend FSD by domain) → [ADR 0014](./adr/0014-repository-structure.md)
- Terminal protocol conformance corpus → [benchmark-protocol.md §11](./benchmark-protocol.md)

Still open:

- Whether to ship a headless CLI harness for automated benchmark subsets.
- Whether AI provider orchestration supports multi-provider fallback in Phase 1 or waits until Phase 5.

## 19. Implementation Contract for Engineering

This section exists to remove ambiguity for implementation agents. If another section is aspirational and this section is concrete, this section wins.

### 19.1 Supported Platforms

Phase-1 target:

- macOS as the primary development platform
- Linux as the secondary supported platform
- bash and zsh required in P0
- fish is allowed only as explicitly unsupported or later-phase support until validated

Non-target in Phase 1:

- Windows shell parity
- remote/container session orchestration as a first-class feature

### 19.2 Source of Truth Hierarchy

When multiple representations disagree, resolve in this order:

1. PTY byte stream and process lifecycle truth
2. normalized terminal event log emitted by Rust
3. persisted execution artifact model
4. enrichment metadata
5. UI presentation state
6. optional summaries, explanations, and suggestions

No layer below PTY truth may rewrite or delete the upstream artifact. It may only annotate, index, summarize, or derive additional views.

### 19.3 Command Block Lifecycle State Machine

Each block must move through this state machine:

- `created`: input accepted, execution not yet started
- `starting`: PTY write issued, process spawn boundary not yet confirmed
- `running`: output and lifecycle events may stream
- `completed`: process ended with final exit code
- `failed_to_start`: shell execution boundary failed before normal run
- `canceled`: user-initiated cancellation with best-effort signal delivery
- `detached`: block remains open while process ownership is no longer fully tracked

State invariants:

- exactly one terminal state per block
- terminal states are `completed`, `failed_to_start`, `canceled`, `detached`
- `end_time` is null until a terminal state is reached
- `duration` is derived, never authored independently
- reruns always create a new block id and a lineage edge, never mutate prior blocks

### 19.4 Event Protocol Contract

The Rust core must expose a stable append-only event protocol. Minimum event types:

- `session.created`
- `session.updated`
- `input.submitted`
- `block.created`
- `block.state_changed`
- `output.chunk`
- `output.cursor_state_changed`
- `diagnostic.detected`
- `enrichment.updated`
- `suggestion.generated`
- `suggestion.reviewed`
- `block.completed`
- `block.canceled`
- `history.indexed`

Required event envelope:

- `event_id`
- `event_type`
- `session_id`
- `block_id` when applicable
- `monotonic_seq`
- `wall_clock_ts`
- `payload`
- `schema_version`

Contract requirements:

- events are append-only and replayable
- ordering is guaranteed within a session via `monotonic_seq`
- frontend rendering must be reconstructible from replay
- schema changes require explicit versioning

Delivery guarantees, reducer determinism, dedupe windows, snapshots, resume cursor, and schema-migration behavior are specified in [ADR 0011 — Event Replay, Reducer Determinism, and Resume](./adr/0011-event-replay-and-reducer-semantics.md). Core commits to at-least-once delivery with idempotent reducers.

### 19.5 Canonical Data Schemas

Minimum canonical block schema:

- `block_id: string`
- `session_id: string`
- `ordinal: integer`
- `input_text: string`
- `input_kind: shell | intent`
- `resolved_command: string | null`
- `state: created | starting | running | completed | failed_to_start | canceled | detached`
- `start_time: string`
- `end_time: string | null`
- `exit_code: integer | null`
- `termination_signal: string | null`
- `cwd: string`
- `env_delta_redacted: object`
- `stdin_echo: string | null`
- `stdout_span_ids: string[]`
- `stderr_span_ids: string[]`
- `diagnostic_ids: string[]`
- `summary_ids: string[]`
- `parent_block_id: string | null`
- `comparison_baseline_block_id: string | null`
- `pin_state: none | pinned`
- `labels: string[]`

Minimum output span schema:

- `span_id`
- `block_id`
- `stream: stdout | stderr`
- `seq`
- `byte_offset_start`
- `byte_offset_end`
- `rendered_text`
- `ansi_runs`
- `is_truncated_in_view: boolean`

Minimum diagnostic schema:

- `diagnostic_id`
- `block_id`
- `category: compiler | linter | runtime | test | infra | shell | unknown`
- `severity: error | warning | info`
- `parser_id`
- `confidence: float`
- `message`
- `path`
- `line`
- `column`
- `end_line`
- `end_column`
- `symbol`
- `raw_span_refs`

### 19.6 Diagnostic Extraction Strategy

No naive single-pattern extraction pipeline is allowed as the primary design. The minimum architecture is a ranked multi-parser system:

1. structured parser adapters for known tools
2. grammar or parser-combinator based extractors for common stack trace families
3. shell/runtime fallback extractor with confidence penalties
4. cross-signal scorer using exit code, stderr density, repetition, location validity, and parser precision priors

Shipped parsers, accuracy targets, latency budgets, and rollout tiering are specified in [ADR 0007 — Diagnostic Parser Rollout Plan](./adr/0007-parser-rollout-plan.md). Tier 1 (P0): rustc/cargo, tsc, Python traceback, Node stack. Do not ship a parser that does not clear its precision bar.

Parser output normalization requirements:

- workspace-relative and absolute paths must normalize to one canonical internal path form
- line and column indices must be normalized to 1-based editor coordinates
- duplicate diagnostics across repeated lines must be merged with provenance retained

### 19.7 Input Routing Contract

The shared input surface must route using an explicit classifier with confidence scores, not ad hoc frontend heuristics.

Routing outputs:

- `shell_command`
- `natural_language_intent`
- `ambiguous_requires_user_choice`

Required rules:

- obvious shell syntax must default to `shell_command`
- obvious natural language requests must never auto-execute
- ambiguous input must show a choice UI instead of guessing silently
- users may override routing manually before execution
- explicit `/cmd` and `/ask` prefixes bypass classification
- workspace-level default mode is configurable (shell, intent, auto)

Full routing policy — confidence thresholds, ambiguity budget, local adaptation, correction paths — is specified in [ADR 0009 — Input Routing Operational Policy](./adr/0009-input-routing-policy.md).

### 19.8 Optional Assist Safety Policy

All assist-originated execution proposals must carry a machine-readable risk label:

- `safe_readonly`
- `workspace_write`
- `system_mutation`
- `network_external`
- `destructive`
- `credential_sensitive`

Approval policy:

- `safe_readonly`: single explicit approval
- `workspace_write`: explicit approval with visible diff or command preview
- `system_mutation` or `network_external`: elevated warning plus explicit approval
- `destructive` or `credential_sensitive`: elevated warning, explicit approval, and a second confirm action

Classification composition — how pipelines, `sudo`, recursion, globs, backgrounding, command substitution, and unknown-parse inputs combine to produce the final label and modifiers — is specified in [ADR 0012 — Risk Classification Composition Rules](./adr/0012-risk-classification-composition.md). The composition is deterministic, additive, and never downgrades on unknown input.

Absolute constraints:

- no assist-suggested command auto-executes
- no silent command rewriting after user approval
- secrets detected in composed commands must be redacted in persisted summaries and telemetry

### 19.9 TUI and Full-Screen Mode Contract

Phase-1 behavior must be explicit:

- full-screen TUI apps run in raw terminal mode
- block enrichment may be suspended while a TUI owns the screen
- returning from TUI restores block mode with a preserved raw transcript boundary
- partial rendering of TUIs inside block cards is out of scope for Phase 1
- the block carrying a TUI stays one block with a `tui_mixed` sub-state

Detection signals (alt-screen escapes), transcript retention limits, enrichment suspension scope, rerun semantics, and replay behavior are specified in [ADR 0008 — Raw / TUI Mode Semantics](./adr/0008-raw-tui-mode-semantics.md).

### 19.10 Performance Budgets

P0 performance budgets:

- keystroke-to-echo latency under 16 ms at p50 on a warm local session
- block header render under 50 ms after command completion for typical runs
- first useful diagnostic extraction under 300 ms after relevant output appears for known parsers
- UI remains interactive while receiving at least 10 MB/min sustained output
- history search returns initial results under 150 ms on 10k stored blocks

If a budget cannot be met, the system must degrade by reducing enrichment work, not by risking PTY fidelity or freezing the input path.

### 19.11 Persistence and Indexing Contract

History storage requirements:

- append-only event log for replay and debugging
- materialized block store for fast retrieval
- searchable index over command text, normalized output text, diagnostics, labels, cwd, and exit status
- explicit retention and compaction policy
- workspace-scoped history namespace by default; global cross-workspace search is opt-in

Security and privacy requirements:

- redact or hash env keys matching secret policies before persistence
- store enough provenance to trace every summary or diagnostic back to raw spans
- user-visible delete must remove both materialized block data and associated search index entries
- export and support-bundle paths apply the same redaction as persistence

Storage root, workspace-fingerprint scheme, blob spill threshold, retention windows, delete semantics (two-stage with grace), corruption recovery, compaction, and migration chain are specified in [ADR 0005 — Storage and Retention](./adr/0005-storage-and-retention.md). Secret class taxonomy, detection ruleset, manual reveal flow, and AI-provider data-handling modes are specified in [ADR 0006 — Secret and Sensitive Data Policy](./adr/0006-secret-and-sensitive-data-policy.md).

### 19.12 Benchmark and Evaluation Matrix

Every major milestone must be evaluated on the canonical task corpus. Operational details — fixtures, user segments (novice vs experienced), parity vs superiority targets, metric definitions, and results-file discipline — are specified in [benchmark-protocol.md](./benchmark-protocol.md).

Baseline scenarios every milestone must cover:

1. `cargo test` with compiler failure and clickable source navigation
2. `pnpm test` or `npm test` with stacked runner output and rerun comparison
3. long-running dev server with noisy logs and responsive scrolling/search
4. Python traceback with multi-frame navigation
5. full-screen TUI entry and exit without session corruption
6. optional assist suggestion flow for a destructive-looking command with approval gating

Required benchmark outputs:

- median and p95 latency
- diagnostic precision and recall on fixture corpus
- successful error-to-code navigation rate
- block reconstruction fidelity from event replay
- sidecar-crash recovery time to next usable prompt (Quanta-specific)

### 19.13 Test Strategy

The implementation is not complete without the following automated test layers:

- Rust unit tests for PTY/session/event/block state transitions
- parser fixture tests for each shipped diagnostic adapter
- replay tests that rebuild frontend-consumable state from event logs
- integration tests for rerun lineage and comparison integrity
- frontend tests for routing, approval gating, and block rendering virtualization
- end-to-end tests for error-to-code navigation across at least one Rust repo and one Node/TypeScript repo

### 19.14 Phase-1 Definition of Done (First Ship Cut)

Phase 1 is done only if all conditions hold. This is the first-ship cut, not the full strategic scope (§9) and not the full sequencing plan (§17). Items P0 in §9 that are not listed here are deferred to later phases, and that is intentional.

- a developer can use Quanta as a daily local terminal for supported shells
- every execution yields a replayable block artifact with raw output preserved
- Tier-1 parser fixtures (rustc/cargo, tsc, Python traceback, Node stack) meet the accuracy bars in [ADR 0007](./adr/0007-parser-rollout-plan.md)
- editor navigation works from real compiler/test outputs on Tier-1 parsers
- optional assist suggestions, where surfaced, are preview-only and fully approval-gated
- large-output scenarios remain responsive within stated budgets
- degraded modes (shell integration missing, estimated cwd, sidecar crash recovery) render per the [ADR 0010](./adr/0010-degraded-mode-ui-contract.md) UI contract
- replay determinism passes on the fixture harness per [ADR 0011](./adr/0011-event-replay-and-reducer-semantics.md)
- terminal protocol conformance bank (benchmark-protocol.md §11) passes green with documented xfails only

## 20. Engineering Build Pack

This section is the recommended direct input for engineering agents.

### 20.1 Build Order

1. Build Rust PTY session core and append-only event protocol first.
2. Build canonical block artifact model and replay pipeline second.
3. Add parser framework and fixture-driven diagnostic extraction third.
4. Build TypeScript renderer on top of replayable events, not ad hoc terminal scraping.
5. Add IDE navigation bridge and jump-back workflow.
6. Add optional assist routing, suggestion review UI, and risk gating only after the execution substrate is stable.

### 20.2 Hard Constraints for Implementers

- never make frontend heuristics the primary source for block boundaries or diagnostics
- never let enrichment failure block command execution
- never hide raw output behind summaries
- never auto-run assist-generated commands
- never use a flat string-only history as the canonical store

### 20.3 First Ticket Set

- define Rust event schema and versioning policy
- implement PTY-backed session manager with shell/cwd/env tracking
- implement command block lifecycle reducer and persistence
- implement output span storage with ANSI retention
- implement parser adapter interface and fixture corpus
- implement file/line normalization and editor link bridge
- implement block list virtualization and raw/block dual view
- implement input router with confidence outputs and manual override
- implement optional assist suggestion entity, risk classifier, and review UI

## 21. LLM-Friendly Product Summary

Quanta Terminal is a Rust-based, PTY-compatible terminal core with a TypeScript frontend for IDE-like environments.

It must preserve normal shell behavior while upgrading command execution into structured, searchable, rerunnable blocks with raw output, metadata, diagnostics, and optional assist overlays.

The product supports natural-language input as a safe command suggestion layer, never as silent auto-execution.

It links errors, logs, compiler output, and stack traces to code locations inside the IDE, enabling a fast error-to-code-to-rerun loop.

It stores execution history as reusable knowledge, supports block search and comparison, and aims to beat leading modern terminals on IDE integration, debugging flow, structured history, and terminal trust while keeping assistive AI optional and non-central.

## 22. One-Paragraph Prompt Seed

Design and build a PTY-compatible terminal for an IDE-like environment, with a Rust core and TypeScript/React frontend. Ship two explicit host modes — a VS Code-compatible extension and a Tauri desktop app — that share the same core. Preserve standard shell behavior and interactive PTY workflows, and represent each execution as a structured block with command, raw stdout/stderr, exit code, duration, timestamp, diagnostics, rerun lineage, and code links. Use OSC 133 shell integration as the authoritative block-boundary signal; degrade explicitly when it is missing. Target terminal excellence first: high PTY fidelity, correct Unicode and shell integration behavior, robust TUI/raw mode handling, high protocol compatibility, and a tight IDE-linked error-to-code-to-rerun loop. Benchmark against Ghostty, WezTerm, VS Code integrated terminal, the kitty graphics protocol ecosystem, and Warp as a matrix, with Warp as the closest product-shape comparison. Assistive natural language is optional, local-first, preview-only, approval-gated, and never on the silent auto-execution path. All contracts — host modes, boundary detection, session metadata tiers, sidecar lifecycle, storage, secrets, parser rollout, TUI semantics, input routing — are pinned in ADRs under `docs/adr/`.

## 23. Korean Prompt Seed

일반 터미널과 호환되는 IDE 내장 터미널을 Rust core + TypeScript/React 프론트엔드로 설계하라. 호스트는 VS Code 호환 extension 모드와 Tauri 데스크톱 모드 두 가지를 명시적으로 분리하되 동일한 core를 공유한다. bash/zsh 등 기존 shell workflow와 interactive PTY 동작을 깨지 않으면서, 각 명령 실행을 command, raw stdout/stderr, exit code, duration, timestamp, diagnostics, rerun lineage, code link를 포함한 structured block으로 표현해야 한다. block 경계는 OSC 133 shell integration을 authoritative 신호로 쓰고, 없을 경우 degraded mode를 사용자에게 명시적으로 알린다. compiler/lint/stack trace에서 file/line을 뽑아 IDE navigation과 연결하고, error-to-code-to-rerun 루프를 짧게 만든다. 자연어 입력은 local-first classifier + preview + approval gate를 통과해야만 실행 경로로 간다. PTY 충실도, 프로토콜 대응, Unicode correctness, TUI/raw mode trust, shell integration, structured history가 우선순위다. benchmark는 Ghostty, WezTerm, VS Code, kitty graphics protocol ecosystem, Warp를 matrix로 쓰고, 실제 측정 방식은 `docs/benchmark-protocol.md`에 고정한다. host 분리, 경계 판정, session metadata 계층, sidecar lifecycle, storage/retention, secret policy, parser rollout, TUI semantics, input routing은 모두 `docs/adr/`에 ADR로 고정되어 있다.

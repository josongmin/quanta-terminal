# ADR 0001 — Host Modes and Deployment Targets

## Status

Accepted for Phase 1 planning. Supersedes implicit single-host assumptions in earlier spec revisions.

## Context

Earlier drafts described Quanta as "an IDE-embedded terminal" while the reference stack simultaneously assumed a VS Code-compatible extension host with a Rust sidecar and React UI. Historical notes also reference Tauri desktop assets. These two targets differ on lifecycle, packaging, editor bridging, permission model, and sidecar management. Left unresolved, implementation agents will silently blend the two and the codebase will calcify around the blend.

Opinion: a single canonical core with thin host adapters is achievable. What is not achievable is "one host" that handwaves the difference between a desktop app and an extension surface.

## Decision

Quanta supports two explicit host modes. Every feature is specified against the core first, then against the host adapter. The core is identical across hosts.

### Mode A — Extension Host

- Target: VS Code-compatible extension host API.
- Packaging: extension bundle ships the Rust sidecar binary as a platform-specific resource.
- Lifecycle: extension activate/deactivate events control sidecar start/stop.
- Editor bridge: implemented on the host extension API directly.
- Permissions: inherits extension host sandbox, cannot request broader filesystem access than the host grants.
- Sidecar transport: Unix domain socket in the extension's global storage path, stdio fallback in dev.
- Multi-window: one sidecar per user profile, windows share it via the same socket.

### Mode B — Desktop Host (Tauri)

- Target: Tauri shell with embedded React UI.
- Packaging: single signed application bundle, sidecar is a sibling binary inside the resources directory.
- Lifecycle: Tauri app lifecycle controls sidecar; last window close triggers sidecar shutdown.
- Editor bridge: implemented against an embedded editor surface or a null adapter if no editor is present.
- Permissions: operating-system level, not sandboxed by an extension host.
- Sidecar transport: Unix domain socket inside the app's application-support directory.
- Multi-window: same profile, same sidecar.

### Shared Core

Independent of host:

- Rust sidecar (`quanta-core` and siblings).
- Event protocol, block model, persistence, diagnostics, history.
- React UI packaged as a host-agnostic module that receives an injected host-bridge object.
- Terminal rendering: the custom Rust VT engine (`quanta-vt` + `quanta-block`)
  is the single renderer (RFC 0001, EPIC-I). Earlier drafts of this ADR
  described xterm.js as a raw-mode bootstrap with a replaceable renderer
  abstraction; that transitional clause is retired as of EPIC-I. No host
  ships a fallback renderer.

### Host Adapter Interfaces

The core never calls the host directly. The host injects:

- `EditorBridge` — open file/range, reveal, focus, optional selection capture.
- `WorkspaceBridge` — workspace root, current file, task metadata, per-host context capability flags.
- `SidecarSupervisor` — spawn, kill, restart the sidecar; surface crash events.
- `HostCapabilities` — boolean flags the UI reads to enable or hide features that only make sense on one host (for example, native notification, window management, IDE tab coordination).

## Phase-1 Rollout

Ship **Mode B first** (Tauri desktop). The competitive target is Warp, which is a standalone desktop app; meeting and beating it on UI/UX is easiest when the Phase-1 demo surface is the same shape. Mode A (VS Code extension) follows once the host-bridge interfaces are stable enough that the second target is an adapter swap, not a rewrite.

This reverses an earlier draft of this ADR. Reasons recorded so the reversal is not undone casually:

- Warp comparison requires a Tauri-shaped surface to be honest.
- The desktop host owns full lifecycle control, which makes ADR 0004 (sidecar lifecycle) exercisable end-to-end from day one.
- The extension host adds sandbox constraints that would muddy early UX experiments.

Opinion: if the team does both in parallel before the bridges stabilize, you will end up with two subtly different cores. Do not. Build Mode B through a usable state, extract the host bridge cleanly, then port to Mode A.

## Non-Goals

- Running one sidecar per window.
- Browser-tab-only hosts. No remote SaaS target in Phase 1.
- Windows shell parity in either host.

## Consequences

- Implementation tickets must declare their host mode in the title.
- Any feature that depends on host capability must gate on a `HostCapabilities` flag, never on a string-matched host name.
- Release engineering owns two packaging pipelines; plan for that cost.

## Verification

- `tools/check-fsd-layers.mjs` — enforces that `packages/ui/` never imports `@quanta/host-tauri`.
- `tools/check-adr-compliance` ADR-0001 row — confirms `packages/host-common/` and `packages/host-tauri/` exist and the UI package does not reach into host-specific code.

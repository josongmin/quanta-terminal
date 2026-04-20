# Plan 0004 — Plugin / Extension System (master plan)

- **Status**: Draft
- **Companion RFC**: `docs/rfc/0004-plugin-system.md`
- **Target release**: Quanta 1.6
- **Nominal effort**: ~15 engineer-weeks, parallelisable across 2 engineers

This master plan orchestrates the six epics (A–F) that together deliver the plugin system. Each epic has its own document under this directory; this README is the shared entry-point: it defines the goal, the sequencing, the interlocks, the acceptance gates, and the shared conventions that every epic plan inherits.

---

## 1. Goal

Let third-party developers extend Quanta without forking, via a sandboxed, capability-gated, versioned plugin API. By GA we must:

1. Ship three first-party example plugins: `kubectl-contexts`, `aws-cli-autocomplete`, `gitlab-ci-log-highlighter`.
2. Enable an external developer to author, sign, and install a plugin in under one working day using only public documentation.
3. Freeze the v1 Plugin API. Any breaking change after GA requires a major-version bump and a deprecation window.

---

## 2. Non-goals (this plan)

- Marketplace hosting / discovery / payments — deferred to RFC 0004.1.
- Native (dylib/so/dll) plugin loading — out of scope, see RFC §3.
- Deep VT semantics or GPU-render hooks — out of scope, see RFC §3.
- Cross-plugin composition / dependencies — out of scope for v1.

---

## 3. Epic sequencing & dependency graph

```
A (manifest)  ──┐
                ├──▶  C (API surfaces) ──┬──▶  F (UI management)
B (wasm host) ──┘                        │
                                         │
                D (perms + sandbox) ─────┤
                                         │
                E (distribution) ────────┘
```

Interlocks:

- **A before B**: the host cannot parse/validate input without the schema.
- **A, B before C**: API surfaces need both the manifest contract and the runtime to live in.
- **C, D in parallel**: permissions design is independent of API-surface internals once A is done.
- **E depends on A**: bundle format embeds the manifest.
- **F integrates everything**: last epic; stabilises the user-facing surface.

Recommended timeline (two engineers in parallel):

| Week | Eng-1 | Eng-2 |
| --- | --- | --- |
| 1–2 | Epic A | Epic A review, stub Epic B |
| 3–4 | Epic B | Epic D (permission prompt design) |
| 5 | Epic B | Epic D |
| 6–7 | Epic C (surfaces) | Epic D |
| 8–9 | Epic C | Epic E (CLI + bundling) |
| 10 | Epic C (example plugins) | Epic E |
| 11–12 | Epic F | Epic F |
| 13 | Hardening, acceptance gate | Hardening, acceptance gate |

Total: 13 weeks wall clock. Nominal sum 15 engineer-weeks.

---

## 4. Shared conventions

Every epic in this plan inherits the following conventions.

### 4.1 Crates & packages

- Host-side plugin code lives in a **new crate**: `crates/quanta-plugin-host/`. Owned by the Platform team.
- UI-side plugin code lives in a **new package**: `packages/plugin-worker/` (Web Worker runtime) and `packages/plugin-api/` (public TS types exported as `@quanta/plugin-api`).
- CLI lives in a **new tool**: `tools/quanta-plugin-cli/` (sibling agents will not touch this — it's new ground).
- The six existing agents working on RFCs 0001/0002/0003 do not touch any of the above paths.

### 4.2 Versioning

- Plugin API version is semver: `"1.x"`, `"1.2"`, `"2.x"`.
- Quanta host version and plugin API version are **decoupled**: host 1.6 may support plugin API 1.x; host 2.0 may support both 1.x (deprecated window) and 2.x.
- The manifest requires an exact range declaration. `"1.x"` means "any 1.minor"; `"1.2"` means "only 1.2.x". The host rejects plugins whose declared range does not intersect host-supported ranges.

### 4.3 Error taxonomy

Plugins fail in predictable, narrow ways. The host exposes one error enum to the UI:

| Code | Meaning |
| --- | --- |
| `ManifestInvalid` | Schema violation, unknown field, missing reason. |
| `BundleInvalid` | Tar malformed, path traversal, size over cap. |
| `SignatureInvalid` | Signature check failed; or unknown key and user declined. |
| `ApiVersionIncompatible` | Manifest API version does not intersect host support. |
| `PermissionDenied` | Call into a capability whose token was not granted or was revoked. |
| `Trapped` | WASM trap, out-of-fuel, out-of-memory, panic in the plugin. |
| `RateLimited` | Exceeded per-plugin rate limit. |
| `TimeoutExceeded` | Plugin hook took longer than its budget. |
| `HostBusy` | Host declined due to resource pressure; retry later. |
| `PluginDisabled` | Plugin is disabled (manual or auto-disable after repeated failures). |

Each code maps to a user-facing message string in the Plugins tab; the raw code is available for developer-mode logs.

### 4.4 Test conventions

- Every epic has **unit tests**, **integration tests**, and **acceptance tests**.
- Every epic ships a **"hostile plugin" test** that encodes an attack vector relevant to that epic (e.g. Epic E ships a tampered-bundle test).
- Integration tests run a real plugin in a real plugin-host; no mocking of the WASM boundary.
- Example plugins built in Epic C double as regression fixtures for Epics D, E, F.

### 4.5 Documentation deliverables

Per epic:

- Engineering design: in the epic plan doc.
- API reference: generated from the published `@quanta/plugin-api` types and the Rust trait docs.
- Tutorial: one short "hello world" tutorial per epic where relevant.
- Changelog entries: on every bump of plugin API minor/major.

Ship a single public docs site at GA: `plugins.quanta.sh` (or wherever the main docs live), with sections mirroring the RFC structure.

### 4.6 Telemetry (local-only)

The host collects the following counters and emits them only to the local debug log (no network in v1):

- plugin load time (ms)
- per-hook call count and latency histogram
- permission denial count
- trap / oom / rate-limit count

No plugin content, no user input, no filesystem paths are recorded in telemetry. Audit log is a separate stream (see Epic D).

---

## 5. Permission matrix (canonical)

Reproduced from RFC 0004 §8, this is the checklist reviewers use for first-party plugin submissions and the format we expect in third-party docs.

| Plugin | network | fs_read | fs_write | clip_read | clip_write | exec | storage |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| kubectl-contexts | — | `~/.kube/config` | — | — | — | `kubectl` | yes |
| aws-cli-autocomplete | `sts.amazonaws.com` | `~/.aws/*` | — | — | — | `aws` | yes |
| gitlab-ci-log-highlighter | — | — | — | — | — | — | yes |
| corporate-sso-helper | `sso.corp.example.com` | `~/.corp/tokens` | `~/.corp/tokens` | — | — | `corp-auth` | yes |
| snippet-clipboard | — | — | — | yes | yes | — | yes |
| ai-custom-provider | `api.anthropic.com` | — | — | — | — | — | yes (secret) |

---

## 6. Acceptance gate (GA)

The plugin system is GA-ready when **all** of the following are true:

- [ ] Three example plugins ship end-to-end (kubectl-contexts, aws-cli-autocomplete, gitlab-ci-log-highlighter).
- [ ] External developer completes the "hello world" tutorial and installs their plugin in under one working day.
- [ ] `quanta-plugin-cli` supports new / build / dev / publish / validate / test.
- [ ] Plugins tab in Settings renders installed plugins, permission grants, audit logs, enable/disable toggle.
- [ ] Signature verification works for self-signed and first-party-signed bundles.
- [ ] Revocation flow: disable plugin, verify all tokens are invalidated, no further audit entries.
- [ ] Resource limits enforced: a CPU-bomb plugin is auto-disabled within 100 ms.
- [ ] Permission prompt correctly reproduces manifest reasons and scoping.
- [ ] "Hostile plugin" test suite passes (see Epic D).
- [ ] No Critical or High security issues open.
- [ ] API v1 frozen: any change post-GA requires an RFC amendment.

---

## 7. Risks

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| wasmtime CVE exposes host memory | Low | Critical | Pin wasmtime to audited versions; auto-update on advisory; defence-in-depth via OS sandbox where available. |
| API v1 ships with a design flaw we cannot break | Med | High | Internal alpha-only period, beta with external invitees, freeze only after ≥2 weeks of beta feedback. |
| Users fatigue on permission prompts | Med | Med | Group prompts per install; never prompt mid-session; pre-approve for enterprise-managed. |
| Plugin authors bypass narrow surfaces by stringly-typed escape hatches | Med | Med | No escape hatches in v1 API; reviewer-enforced for first-party plugins; lint rule for deprecated patterns. |
| Cross-platform WASI divergence | Low | Med | Ship a thin WASI subset (fd_write only); target exact behaviour across mac/linux/windows. |
| Audit log grows unbounded | Low | Low | Rotation at 10 MiB, 5 files kept, purge on uninstall. |
| Third-party plugins break on Quanta host updates | Med | High | Plugin API major compatibility; deprecation window; CI fixture that loads every public first-party plugin on each host release. |

---

## 8. Epic documents

- `epic-A-plugin-manifest-schema.md` — manifest format, versioning, permission categories, API declarations.
- `epic-B-wasm-runtime-host.md` — wasmtime integration, WASI subset, resource limits.
- `epic-C-plugin-api-surfaces.md` — six API hooks, Rust traits, TS types, example plugins.
- `epic-D-permissions-and-sandbox.md` — capability tokens, audit log, revocation, UI prompt.
- `epic-E-distribution-and-marketplace.md` — bundle format, signing, `quanta-plugin-cli`.
- `epic-F-ui-plugin-management.md` — Settings "Plugins" tab, logs, enable/disable.

---

## 9. Out-of-scope / follow-ups

- RFC 0004.1 — Marketplace hosting.
- RFC 0004.2 — Plugin-to-plugin extension points.
- RFC 0004.3 — Lua scripting as a first-party plugin.
- RFC 0004.4 — Inline user scripts (lighter companion, not a plugin).
- Enterprise MDM integration for managed plugins.
- Plugin telemetry channel (requires privacy design).

---

## 10. Change history

| Date | Author | Change |
| --- | --- | --- |
| 2026-04-20 | Platform Team | Initial master plan. |

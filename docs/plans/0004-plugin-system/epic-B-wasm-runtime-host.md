# Epic B — WASM Runtime Host

- **Parent**: `docs/rfc/0004-plugin-system.md`, `docs/plans/0004-plugin-system/README.md`
- **Depends on**: Epic A (manifest schema)
- **Duration**: 3 weeks
- **Status**: Draft

Epic B builds the Rust side of the runtime: load a WASM plugin, enforce resource limits, expose host imports behind capability tokens, and tear the plugin down cleanly on failure or revocation.

---

## 1. Goal

A production-grade wasmtime-based plugin host that can load a WASM module, pin its memory / CPU / rate-limit ceilings, route imported-function calls to capability-checked host handlers, and recover gracefully from traps, timeouts, and panics.

By end of epic:

- `crates/quanta-plugin-host/` exposes a public API:
  - `PluginHost::load(bundle_path, manifest, grants) -> PluginHandle`
  - `PluginHandle::call<H: Hook>(token, args) -> Result<H::Output, PluginError>`
  - `PluginHandle::shutdown()`
- Resource limits enforced and tested.
- Hostile-plugin test suite: CPU bomb, memory bomb, infinite recursion, capability-token forgery, malformed imports.
- Benchmark suite showing cold-start under 40 ms and per-call overhead under 0.5 ms for a no-op hook.

---

## 2. Non-goals

- Parsing or validating the manifest (Epic A).
- The actual API-surface semantics (Epic C).
- Permissions UI and capability-grant flow (Epic D).
- Bundle unpacking / signature verification (Epic E).
- UI-side Web Worker runtime (tracked in Epic C and Epic F).

This epic assumes a valid manifest, a valid WASM binary, and a valid grant list are handed to it.

---

## 3. Architecture

```
                         PluginHost (top-level registry)
                              │
                              │ one per loaded plugin
                              ▼
                        ┌───────────────┐
                        │ PluginHandle  │
                        │  ┌─────────┐  │
                        │  │ Store<T>│  │   wasmtime Store
                        │  │         │  │   - fuel: refilled per call
                        │  │         │  │   - memory limiter
                        │  └─────────┘  │
                        │  ┌─────────┐  │
                        │  │Instance │  │   wasmtime Instance
                        │  └─────────┘  │
                        │  ┌─────────┐  │
                        │  │ Imports │  │   host-provided functions
                        │  └─────────┘  │
                        │  ┌─────────┐  │
                        │  │ Tokens  │  │   capability tokens for this plugin
                        │  └─────────┘  │
                        │  ┌─────────┐  │
                        │  │ Audit   │  │   per-call audit sink
                        │  └─────────┘  │
                        └───────────────┘
```

One `wasmtime::Engine` is shared across all plugins (engine is cheap; JIT caches are reused). One `Store<PluginCtx>` per plugin so that memory limits, fuel, and per-plugin data are isolated.

---

## 4. Public API

### 4.1 `PluginHost`

```rust
pub struct PluginHost {
    engine: wasmtime::Engine,
    plugins: HashMap<PluginId, PluginHandle>,
    config: HostConfig,
}

pub struct HostConfig {
    pub memory_soft_mb: u32,       // default 32
    pub memory_hard_mb: u32,       // default 64
    pub fuel_per_call: u64,        // default 10 ms equivalent
    pub hook_timeout_ms: u32,      // default 50
    pub max_concurrent_calls: u32, // default 16
    pub max_log_lines_per_sec: u32,
    pub audit_sink: Arc<dyn AuditSink>,
}

impl PluginHost {
    pub fn new(config: HostConfig) -> Self { … }

    pub fn load(
        &mut self,
        wasm_bytes: &[u8],
        manifest: &Manifest,
        grants: &PermissionGrants,
    ) -> Result<PluginId, PluginError> { … }

    pub fn unload(&mut self, id: &PluginId) -> Result<(), PluginError> { … }

    pub fn call<H: HookInvocation>(
        &self,
        id: &PluginId,
        args: H::Args,
    ) -> Result<H::Output, PluginError> { … }
}
```

### 4.2 `PluginHandle` (internal)

Holds a `wasmtime::Store<PluginCtx>`, the instance, the imports table, the grant map, and a channel to the audit sink. Never exposed outside the crate; callers work through `PluginHost`.

### 4.3 `PluginCtx` (per-store data)

```rust
pub struct PluginCtx {
    pub plugin_id: PluginId,
    pub grants: PermissionGrants,
    pub tokens: CapabilityTokenTable,
    pub audit: Arc<dyn AuditSink>,
    pub log_limiter: RateLimiter,
    pub call_counter: AtomicU32,
}
```

The wasmtime import closures take `&mut Caller<'_, PluginCtx>` and can read `ctx.grants`, mutate the audit sink, and so on.

---

## 5. WASI subset

We ship a **minimal** subset of WASI preview 1:

| WASI call | Behaviour |
| --- | --- |
| `fd_write` | Accepts fd = 1 (stdout) and fd = 2 (stderr). Appends to an in-memory per-plugin log buffer, rate-limited. Any other fd errors with `EBADF`. |
| `clock_time_get` | Returns monotonic and wall-clock times. No real-time clocks (avoids fingerprinting). |
| `random_get` | Cryptographically secure via host OS. |
| `proc_exit` | Traps the plugin cleanly and tears down the store. |
| `environ_get` / `environ_sizes_get` | Returns an empty environment. |
| `args_get` / `args_sizes_get` | Returns empty argv. |
| `poll_oneoff` | Errors with `ENOSYS` in v1. |
| all `fd_*` other than `fd_write` | Errors with `EBADF` / `ENOSYS`. |
| all `path_*` | Errors with `ENOSYS`. |

Rationale: anything that could give filesystem or network access *must* go through our host imports so the capability layer sees it. WASI's own sandbox is an OK starting point, but we want one code path, one place to enforce policy.

---

## 6. Host imports (namespaced)

Host imports are grouped into namespaces so plugins can bind only the ones they use and the linker error reads well:

- `quanta:session` — submit hook registration, block event subscription.
- `quanta:palette` — palette entry registration.
- `quanta:block` — block render hook registration.
- `quanta:diagnostic` — output-line subscription.
- `quanta:ai` — suggestion callback registration.
- `quanta:settings` — schema registration + storage get/set.
- `quanta:fs` — read-file / write-file (permission-gated).
- `quanta:exec` — spawn command (permission-gated).
- `quanta:net` — fetch (permission-gated).
- `quanta:clip` — clipboard read / write (permission-gated).
- `quanta:log` — structured log (rate-limited).
- `quanta:notify` — push a toast notification to the UI.

Each import signature is pinned in a schema file committed to `crates/quanta-plugin-host/src/imports/schema.capnp` so the Rust host and any SDK-side bindings stay in lockstep.

### 6.1 Capability-token check

Every permission-gated import begins with:

```rust
ctx.tokens.verify(token_arg, Category::FilesystemRead)
    .ok_or(PluginError::PermissionDenied)?;
ctx.audit.record(AuditEvent {
    plugin: ctx.plugin_id.clone(),
    category: Category::FilesystemRead,
    action: "read_file",
    details: json!({ "path": path }),
    outcome: Outcome::Requested,
});
```

Failure short-circuits before any privileged work. The audit entry is written regardless of outcome (requested, allowed, denied, errored) so hostile behaviour is visible.

### 6.2 Argument marshalling

We use Cap'n Proto for all non-trivial arguments. A shared schema file `imports/schema.capnp` defines:

- `CommandSubmitEventArgs` / `CommandSubmitResult`
- `BlockRenderEventArgs` / `UiFragmentList`
- `PaletteEntrySpec`
- `OutputLineEventArgs` / `DiagnosticList`
- `AiSuggestEventArgs` / `AiSuggestion`
- `SettingsSchemaSpec`
- `FsReadArgs` / `FsWriteArgs` / `FsResult`
- `ExecArgs` / `ExecResult`
- `FetchArgs` / `FetchResult`
- `NotifySpec`
- `AuditDetail`

Marshalling convention: the plugin allocates a buffer in its linear memory, writes the Cap'n Proto message, and calls the host with `(ptr, len, token)`. The host reads the bytes, validates, processes, writes a response to a plugin-provided response buffer (separate alloc call) or returns a small in-return value for tiny results.

---

## 7. Resource limits — enforcement details

### 7.1 Memory

- `wasmtime::StoreLimits` with `memory_size(hard_bytes)` — hard cap; growth past this traps.
- Soft cap warns at 75 % via audit log.
- Memory *shrink* is not automatically triggered; plugins are expected to free internally.

### 7.2 CPU (fuel)

- Fuel metering enabled in the engine config.
- Before each call, the host calls `store.add_fuel(fuel_per_call)`.
- Remaining fuel is reclaimed after the call (we subtract unused fuel from the plugin's budget counter, so a plugin that makes many calls doesn't get unlimited cumulative fuel).
- Out-of-fuel traps are caught by the host and converted to `PluginError::Trapped { reason: "cpu_budget_exhausted" }`.

### 7.3 Wall-clock timeout

Fuel is not wall-clock — a plugin can deadlock on a tight `fd_write` loop that is "cheap" in instructions but wall-clock slow through the host. We add a second timeout via a watchdog thread that calls `Engine::increment_epoch` on a timer; the plugin's store is configured with `epoch_deadline_trap` and an epoch budget per call.

### 7.4 Concurrent calls

- A per-plugin semaphore with `max_concurrent_calls` permits.
- Over the cap, callers receive `PluginError::HostBusy`.

### 7.5 Rate limits

- Per-plugin token buckets for log lines, event subscriptions, and event bus messages.
- Exceeding the bucket drops the excess and writes a single "rate limited" audit line per window.

### 7.6 Log rate

Separate bucket for `quanta:log` to bound the cost of a chatty plugin. Over-limit log entries are dropped and a single `log_rate_limited` audit entry replaces them.

---

## 8. Trap / error recovery

If a plugin traps, panics, exceeds fuel, exceeds epoch, exceeds memory, or hangs past the watchdog timeout:

1. The host catches the trap.
2. The current call returns `PluginError::Trapped` with a categorised reason.
3. A per-plugin "strikes" counter increments. Default policy: 3 strikes in 60 s → auto-disable the plugin and show a toast: "Plugin X has been disabled due to repeated failures. Check logs in Settings → Plugins."
4. The store is dropped; all tokens invalidate.
5. The audit log records the trap with a stack trace summary (WASM frame pointers only; no symbolication without debug info).

Panics inside Rust host imports are also caught via `std::panic::catch_unwind`; they produce `PluginError::Trapped { reason: "host_panic" }` and follow the same strike policy so a host-side bug triggered by plugin input doesn't take down the host.

---

## 9. Hot reload (developer mode)

When the host is launched with `QUANTA_PLUGIN_DEV=1` and a plugin is installed via `quanta-plugin dev`, the host watches the manifest file and entry-point files for changes. On change:

1. Drain in-flight calls (up to 200 ms).
2. Unload the plugin.
3. Re-validate the manifest.
4. If permissions changed, re-prompt the user.
5. Reload.
6. Replay the most recent `activate()` lifecycle.

Hot reload is **developer-only**; it's disabled in release builds to prevent accidental exposure.

---

## 10. Lifecycle

```
load  ────────▶ instantiate ────▶ call `_activate` (exported by plugin)
                                        │
                                        ▼
                             plugin registers hooks
                                        │
                                        ▼
                             steady state: host invokes hooks
                                        │
                                        ▼
                             shutdown ─▶ call `_deactivate` (if exported)
                                        │
                                        ▼
                             drop store ─▶ invalidate tokens
```

Plugin-exported WASM functions (the plugin side of the contract):

- `_activate()` — required; called once at load.
- `_deactivate()` — optional; called at shutdown.
- `_on_command_submit(ptr, len)` — if registered.
- `_on_block_render(ptr, len)` — if registered.
- `_on_palette_invoke(ptr, len)` — if a palette entry is triggered.
- `_on_output_line(ptr, len)` — if registered.
- `_on_ai_suggest(ptr, len)` — if registered.

All but `_activate` are called in response to events. Arguments are Cap'n Proto-encoded; returns go to a plugin-allocated buffer pointer.

---

## 11. Work breakdown

### Sprint 1 (week 1)

- **B-1.1** Lay down crate scaffolding (lib.rs, `imports/`, `store.rs`, `error.rs`).
- **B-1.2** Wasmtime Engine config: fuel, epoch, memory limiter.
- **B-1.3** Minimal WASI subset (fd_write, clock, random, proc_exit, environ, args).
- **B-1.4** `PluginHost::load` — compile module, build imports, instantiate, call `_activate`.
- **B-1.5** `PluginCtx` struct + basic audit sink trait.
- **B-1.6** "Hello world" plugin WASM (just `_activate` that logs "hi").
- **B-1.7** Integration test: load the hello-world plugin, assert the log line landed.

### Sprint 2 (week 2)

- **B-2.1** Capability token table type + verify path.
- **B-2.2** Cap'n Proto schema for first two API surfaces (for test harness only; real integration is Epic C).
- **B-2.3** `fs.read_file` and `exec.spawn` host imports with capability checks (stubs; real policy in Epic D).
- **B-2.4** Fuel + epoch enforcement; out-of-fuel and out-of-epoch tests.
- **B-2.5** Memory limiter tests.
- **B-2.6** Concurrent-call semaphore.
- **B-2.7** Strike counter + auto-disable.
- **B-2.8** Hot reload (dev mode).

### Sprint 3 (week 3)

- **B-3.1** Hostile plugin suite (see §12).
- **B-3.2** Benchmarks (cold start, per-call overhead).
- **B-3.3** Performance tuning: import closure dispatch, Cap'n Proto scratch-buffer reuse.
- **B-3.4** Multi-plugin tests (10 plugins in one host, verify isolation).
- **B-3.5** Documentation pass.
- **B-3.6** Hardening and review.

---

## 12. Hostile-plugin test suite

Every scenario ships as a `.wasm` fixture under `crates/quanta-plugin-host/tests/hostile/`. Each is accompanied by an expected `PluginError`.

| # | Name | Attack | Expected outcome |
| --- | --- | --- | --- |
| 1 | `cpu_bomb.wasm` | Infinite loop. | `Trapped("cpu_budget_exhausted")`, strike +1. |
| 2 | `cpu_bomb_stealth.wasm` | Loop that yields every N iters to spread over time. | Epoch watchdog trips. `Trapped("epoch")`. |
| 3 | `mem_bomb.wasm` | `memory.grow` past hard cap. | Memory-limiter trap. |
| 4 | `mem_leak.wasm` | Alloc without free across calls. | Hits hard cap eventually; strike + auto-disable. |
| 5 | `stack_bomb.wasm` | Unbounded recursion. | Stack overflow trap. |
| 6 | `unknown_import.wasm` | Imports `wasi_snapshot_preview1.fd_read`. | Link error at load; `PluginError::ManifestInvalid`-ish. |
| 7 | `bad_argv_exec.wasm` | Passes `/bin/sh -c 'rm -rf ~'` to exec. | `PermissionDenied` if `sh` not in allowlist; if in allowlist, still blocked because argv[0] contains `/`. |
| 8 | `forge_token.wasm` | Passes a made-up capability token. | `PermissionDenied`. |
| 9 | `fd_write_flood.wasm` | Spams `fd_write` at 10 k lines/sec. | Rate limiter drops; one `log_rate_limited` audit entry. |
| 10 | `panic_in_host.wasm` | Sends malformed Cap'n Proto → host panics. | `catch_unwind` converts to `Trapped("host_panic")`; strike +1. |
| 11 | `path_traversal_read.wasm` | Grant `~/project/` fs_read; passes `~/project/../../secret`. | Path canonicaliser catches; `PermissionDenied`. |
| 12 | `exec_long_argv.wasm` | argv with 10 000 args. | Reject at exec import; `InvalidArgument`. |
| 13 | `fuel_recursive.wasm` | Plugin calls host which calls plugin (via event). | Reentrancy counter caps at 2 levels; third level `HostBusy`. |
| 14 | `fork_attempt.wasm` | Tries to spawn via WASI `proc_exec` (not in subset). | Link failure. |
| 15 | `clock_fingerprint.wasm` | Uses `clock_time_get` for high-res timing. | Host returns monotonic clamped to 1 ms; timing side-channels minimized. |
| 16 | `memory_share_attempt.wasm` | Exports its memory; another plugin tries to import. | Per-store memory; cross-plugin import impossible by construction. |

All 16 must pass as automated tests before Epic B is accepted.

---

## 13. Benchmarks

Under `crates/quanta-plugin-host/benches/`:

- **cold_start**: load a ~200 KiB plugin, call `_activate`, unload. Target: p50 < 40 ms, p99 < 100 ms on mid-range laptop.
- **per_call_noop**: a hook that immediately returns. Target: p50 < 0.5 ms.
- **per_call_10kb_payload**: hook with a 10 KiB input. Target: p50 < 1.5 ms.
- **parallel_plugins**: 10 plugins handling `block.onRender` in parallel. Target: throughput ≥ 5000 calls/sec total.
- **audit_overhead**: on-vs-off comparison. Target: audit adds ≤ 10 %.

Benchmarks are run in CI on a reference machine; regressions beyond 20 % fail the build.

---

## 14. Observability

- Every call emits a structured log line at `debug` level: `{plugin, hook, duration_us, outcome, fuel_used, epoch_used}`.
- Dev-mode HUD (behind `QUANTA_PLUGIN_HUD=1`): a small overlay showing per-plugin CPU / memory / call rate.
- `quanta-plugin-host` exposes a `/metrics` endpoint *if* a future RFC adds an admin surface (not in v1).

---

## 15. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| wasmtime API churn across versions | Pin via Cargo with patch bumps only; RFC amendment for minor+ upgrades. |
| Cap'n Proto adds schema-evolution footguns | Schema file is a single source of truth; CI compares Rust-generated and plugin-SDK-generated stubs for parity. |
| Fuel cost doesn't correlate with wall-clock | Use epoch timer as the wall-clock guard; fuel is a secondary check. |
| Plugin isolation broken by a shared global (e.g. shared cache) | No shared mutable state between plugins except the engine (which is read-only in practice); lint against it. |
| Hostile plugin exploits host-panic → state corruption | `catch_unwind` at every import; clippy lint for unchecked `unwrap` in import code paths. |

---

## 16. Acceptance criteria

- [ ] `PluginHost::load` / `unload` / `call` API implemented and documented.
- [ ] WASI subset limited to the documented calls.
- [ ] Fuel + epoch + memory limits enforced with passing tests.
- [ ] All 16 hostile-plugin scenarios caught.
- [ ] Benchmarks meet targets.
- [ ] Hot reload works under `QUANTA_PLUGIN_DEV=1`.
- [ ] Strike-based auto-disable works (3 strikes in 60 s).
- [ ] No Critical security issues; High issues triaged with owners.

---

## 17. Open questions (epic-local)

- Is epoch-based wall-clock enforcement accurate enough for a 50 ms budget? Prototype to validate on hot loops.
- Should we support `wasmtime`'s component model in v1.1, or stick with core WASM? v1 sticks with core; component model tracked for future.
- Per-plugin thread vs. per-host thread-pool? Default to thread-pool with N = logical CPUs; revisit if plugin contention is measurable.

---

## 18. Change history

| Date | Author | Change |
| --- | --- | --- |
| 2026-04-20 | Platform Team | Initial epic plan. |

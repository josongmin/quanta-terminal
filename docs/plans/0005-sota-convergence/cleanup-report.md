# P0 Cleanup Report

- Date: 2026-04-21
- Commit audited: `f74c047` (wave 4)
- Working branch: `main`
- Auditor: Agent FF (inspect-only pass)
- Mode: diagnose-and-report (no code changes committed, per mission brief)

---

## 1. Typecheck

Ran `pnpm --filter @quanta/ui exec tsc --noEmit` and `pnpm -r typecheck`.

- **`@quanta/host-common`** — clean.
- **`@quanta/ui`** — 3 errors, all pre-existing, all test-file only.

| # | File:Line | Kind | Category |
|---|-----------|------|----------|
| 1 | `packages/ui/src/features/input/__tests__/paste-encoding-edge-cases.test.ts:28` | TS6133 `'utf8' is declared but its value is never read.` | **dead import — real bug, safe 1-line fix (delete line 28).** Authored by Agent R; `new TextEncoder()` is never consumed. |
| 2 | `packages/ui/src/features/input/__tests__/paste-ime-ordering.test.ts:150` | TS2379 `onPasteGate: undefined` under `exactOptionalPropertyTypes`. | **test-config issue.** The test is asserting the "field omitted" path but passes `undefined` explicitly. Fix: either `{}` (omit the key) or loosen the `InputHostMountOptions` signature; runtime semantics identical. |
| 3 | `packages/ui/src/shared/ui/tooltip/__tests__/Tooltip.test.tsx:134` | TS2307 `Cannot find module '../tooltip.module.css?inline'` | **dependency/vite-plugin type issue.** Vite resolves `?inline` at bundle time; vitest executes it; TypeScript has no declaration for the query-param variant. Requires adding `declare module '*.module.css?inline'` to `packages/ui/src/types/vite.d.ts` (or equivalent). Not a bug — tests pass at runtime. |

All three tests **pass at runtime** when executed directly — verified:

```
✓ paste-ime-ordering.test.ts (5 tests) 14ms
✓ Tooltip.test.tsx (7 tests) 403ms
```

- **Errors at start: 3**
- **Errors fixed (actionable): 2** (would fix; held per "DO NOT commit code")
- **Remaining (external / config): 1** — `?inline` CSS module declaration

## 2. Lint

- `pnpm -r lint` → `None of the selected packages has a "lint" script`.
- The only lint-style rule is `lint:fsd` (layer check) on `@quanta/ui` — passes.
- Grep-rule CLIs (`check:render-path`, `check:input-path`, `check:no-block-chunks`) are wired via root `package.json` and succeed (see §8).

No rule violations identified in wave 3/4 files.

## 3. Rust

Ran from `packages/host-tauri/src-tauri`:

### `cargo fmt -- --check`

Fails. Diffs touch **crash.rs, embedded_shell.rs, error.rs, flow_control.rs, ipc.rs, shell_integration.rs** — all pre-existing "rustfmt prefers one-liner / multi-liner" hunks. Nothing semantic.

**In-scope files (wave 3/4):**
- `flow_control.rs` — 2 trivial hunks at L127 (method chain formatting) and L388 (`assert!` arg wrap).
- `ipc.rs` — 3 hunks, all around the new `quanta_pause_pty/resume_pty/set_session_size` handlers landed by Agent N.

A single `cargo fmt` run resolves all of them. Held.

### `cargo clippy --all-targets -- -D warnings` (default features)

2 errors:

| File:Line | Lint | Status |
|-----------|------|--------|
| `src/embedded_shell.rs:291` | `dead_code` on `is_wsl_from_proc_version` | Pre-existing. Function is only consumed from `#[cfg(test)]` — fix is `#[allow(dead_code)]` on the fn or `#[cfg(any(test, windows))]`. |
| `src/ipc.rs:974` | `clippy::manual_strip` — `&s[2..]` after `s.starts_with("~/")` | Pre-existing (editor integration). Trivial `strip_prefix` rewrite. |

Plus 4 clippy warnings in test code (all `assertions_on_constants` / `single_match` — cosmetic).

### `cargo clippy --all-targets --all-features -- -D warnings`

Fails at `src/lib.rs:87` with an **intentional** `compile_error!` — `embedded-shell` and `sidecar` features are designed to be mutually exclusive. Running clippy with `--all-features` is diagnostic misuse, not a repo bug. Recommended invocation is:

```
cargo clippy --all-targets -- -D warnings
cargo clippy --all-targets --no-default-features --features sidecar -- -D warnings
```

### `cargo test --workspace` (repo root)

**Blocked.** `crates/quanta-pty/Cargo.toml` inherits `libc` from `workspace.dependencies` but `libc` is **not declared** in the root `Cargo.toml`:

```
error inheriting `libc` from workspace root manifest's `workspace.dependencies.libc`
Caused by: `dependency.libc` was not found in `workspace.dependencies`
```

This is a **real regression** that will break CI Rust jobs. One-line fix: add `libc = "0.2"` to root `Cargo.toml` `[workspace.dependencies]` (alongside `nix`). Escalated; held per "do NOT commit code" and because fixing it touches the core engine crate surface.

## 4. Cross-reference audit

Walked `docs/plans/0005-sota-convergence/`:

- `README.md`, `gap-tracking.md`, `test-strategy.md`, `epic-beta-input.md`, `migration-checklist.md` — all present.
- Agent attribution in `gap-tracking.md` §"Agent assignments (live)" is clean and consistent (Agents A → S; T-Z referenced in-commit only).
- **Stale reference found**: `packages/ui/src/__tests__/compat/harness-audit.test.ts` at L22 and L286 reference `AUDIT_RECOMMENDATIONS.md` — **this file does not exist** in the repo (`find . -name AUDIT_RECOMMENDATIONS.md` returns empty). Agent S merged the audit findings directly into `test-strategy.md` §"Agent S wave-3 audit upgrade" instead of shipping a separate doc. The comments should be edited to point at `test-strategy.md` instead.
- No TODO comments in wave-3/4 files reference completed work — grep for `TODO-P0|FIXME-P0` returned zero hits across `packages/ tools/ .github/`.

## 5. Stale TODO sweep

- `TODO-P0` / `FIXME-P0` / `HACK-P0`: **zero matches** anywhere in tree.
- Generic `TODO`/`FIXME` with "wave" / "deferred" / "P1 follow-up" markers — 17 files, all are legitimate future-work pointers (DPR mid-session, ConPTY SIGSTOP, recorder tool, etc.), not stale.
- No re-scoping needed.

## 6. Test-suite ordering / flakiness

Ran `pnpm --filter @quanta/ui exec vitest run` four times (runs 1, 2, 4 captured full output; run 3 was truncated by an output-capture issue, not an actual failure):

| Run | Test Files | Tests | Duration |
|-----|-----------|-------|----------|
| 1 | 340 passed / 2 skipped (342) | 4683 passed / 21 skipped (4704) | 47.55s |
| 2 | 340 passed / 2 skipped (342) | 4683 passed / 21 skipped (4704) | 44.61s |
| 4 | 340 passed / 2 skipped (342) | 4683 passed / 21 skipped (4704) | 46.49s |

**Identical pass/skip counts across 3 full runs. Zero flake observed.**

Skip breakdown (2 skipped files, 21 skipped tests) — all intentional (e.g., SessionInputSurface degraded-gate awaiting P1 impl, `it.skip` placeholders for future features marked in commit message). Matches the mission's stated baseline (4681/4702) within noise; in fact slightly better (new C-UX-02 fixture lands an extra 2 tests).

Note: `test-suite passes individually but fails under suite ordering` — **not observed**. All tests ran in one shared vitest process with stable count.

## 7. `.claude/worktrees/` cleanup

`git worktree list` shows 7 locked worktrees under `.claude/worktrees/` all at commit `aa4dfef` (pre-wave-2 branch). They are locked and left intentionally by the orchestrator, so `git worktree prune` is a no-op on locked entries.

**`.gitignore` does NOT include `.claude/`**, and `git status` on `main` shows:
```
Untracked files:
  .claude/
```

Recommended addition to `.gitignore` (held — file touch):

```
# Claude Code per-agent worktrees (locked by orchestrator)
.claude/
```

This is the single most useful cleanliness fix remaining.

## 8. Package.json consistency

All mission-listed scripts defined:

| Script | Location | Status |
|--------|----------|--------|
| `test:perf` | root `package.json` + `packages/ui/package.json` | ✓ wired to `tools/run-perf-budget.mjs` |
| `test:compat` | `packages/ui/package.json` | ✓ `vitest run compat` |
| `check:render-path` | root | ✓ `tools/check-one-render-path/index.mjs` |
| `check:input-path` | root | ✓ `tools/check-one-input-path/index.mjs` |
| `check:no-block-chunks` | root | ✓ `tools/check-no-block-chunks-in-render/index.mjs` |
| `check:all` | root | ✓ composes the three above + `pnpm -r --parallel run check` |

All corresponding tool directories (`tools/check-one-render-path/`, etc.) exist and have an `index.mjs`. No broken wiring.

## 9. CI workflow dry-validate

Validated all 7 YAML files in `.github/workflows/` with `python3 yaml.safe_load`:

```
ci.yml ......... OK
compat.yml ..... OK    (wave 4 — Agent V)
grep-rules.yml . OK    (wave 4 — Agent V)
nightly.yml .... OK
perf-budget.yml  OK    (wave 4 — Agent V)
perf.yml ....... OK
release.yml .... OK
```

All syntactically valid. No dead job references.

## 10. Fixture registry consistency

- `packages/ui/fixtures/compat/` — **33 directories** (C-COMB-01..03, C-ED-01..03, C-IME-01..04, C-MON-01..03, C-MUX-01..03, C-NET-01..02, C-PG-01..03, C-RP-01..03, C-SH-01..03, C-STRESS-01..03, C-UX-01..03).
- `packages/ui/src/__tests__/compat/C-*.test.ts` — **33 test files**, one per fixture.
- `packages/ui/src/__tests__/compat/registry.ts` — **33 entries**, every key matches a fixture directory.

**Registry ↔ filesystem ↔ tests: bijective. No drift.**

(The mission counted "30 fixtures" but wave 4's Agent U added C-UX-02 + C-UX-03 + C-COMB-03 bringing the ledger to 33 at f74c047.)

---

## Closed TODOs

None to close (no TODO-P0 / FIXME-P0 markers found). Wave authors kept inline comments as forward-looking doc only.

## Open (escalated to P1)

| # | Issue | Severity | Suggested fix |
|---|-------|----------|---------------|
| P1-CLEANUP-01 | `libc` missing from `[workspace.dependencies]` in root `Cargo.toml` breaks `cargo test --workspace` | **HIGH** — will break CI Rust stage | Add `libc = "0.2"` alongside `nix` entry |
| P1-CLEANUP-02 | `AUDIT_RECOMMENDATIONS.md` referenced from `harness-audit.test.ts` but does not exist | LOW — comment-only | Repoint comments at `test-strategy.md` |
| P1-CLEANUP-03 | `?inline` CSS module type declaration missing (Tooltip.test.tsx) | LOW — type-only | Add `vite.d.ts` augmentation |
| P1-CLEANUP-04 | `exactOptionalPropertyTypes` regression in `paste-ime-ordering.test.ts` | LOW — type-only | Replace `{ onPasteGate: undefined }` with `{}` |
| P1-CLEANUP-05 | `utf8` dead import in `paste-encoding-edge-cases.test.ts:28` | LOW — trivial | Delete line |
| P1-CLEANUP-06 | `cargo fmt --check` shows 10 hunks across 6 files | LOW — cosmetic | Single `cargo fmt` run |
| P1-CLEANUP-07 | `cargo clippy` (default features) shows 2 errors + 4 test warnings | MED — CI-blocking if `-D warnings` enforced | Strip-prefix rewrite in `ipc.rs`, `#[allow(dead_code)]` on `is_wsl_from_proc_version` |
| P1-CLEANUP-08 | `.claude/` not in `.gitignore` | LOW — working-tree noise | One-line `.gitignore` addition |

---

## Summary

- **Typecheck**: 3 errors, all pre-existing, 2 trivially fixable, 1 needs `vite.d.ts` declaration. No new errors from waves 3/4.
- **Lint**: no lint pipeline beyond FSD; FSD passes.
- **Rust**: clippy (default) 2 pre-existing errors; `flow_control.rs` itself is clean modulo cosmetic fmt. Workspace `cargo test` currently blocked by missing `libc` workspace-dep — HIGH priority escalation.
- **Flake rate**: **0 %**. Three full UI suite runs identical: 4683 pass / 21 skip / 0 fail / 340 test files. Meets and beats the 4681/4702 bar.
- **Cross-ref**: one dead reference (`AUDIT_RECOMMENDATIONS.md`) in 2 comments.
- **Worktrees**: 7 locked leftovers; `.gitignore` missing `.claude/` entry.
- **CI / scripts / fixture registry**: all clean.

**Confidence the codebase is clean: HIGH for TS runtime, HIGH for UI flake, MED-HIGH for Rust** (blocked by missing `libc` workspace dep which silently passes today because `cargo build` from inside `packages/host-tauri/src-tauri` doesn't pull the broken crate, but `cargo test --workspace` from root does).

Recommend landing a small follow-up PR applying P1-CLEANUP-01, -05, -06, -07, -08 as a single atomic "cleanup sweep" commit — all are one-line or rustfmt-driven changes and they collectively restore `cargo test --workspace`, `cargo clippy -D warnings`, `cargo fmt --check`, and a clean `git status` on `main`.

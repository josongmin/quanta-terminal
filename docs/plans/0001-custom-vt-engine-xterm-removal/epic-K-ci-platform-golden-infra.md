# EPIC-K — CI + Platform Matrix + Golden Infrastructure (cross-cutting) — Detailed Plan

- **Status**: Planning (cross-cutting, Phase 0 → Phase 6 rolling; spec-ready
  from day 1, rules landed incrementally as the implementations they
  enforce land).
- **Date**: 2026-04-19
- **Scope owner**: EPIC-K planning agent.
- **Implements**: RFC 0001 v4 §2 invariants (especially I-2 "UI does not
  parse ANSI", I-4 "semantic width wins, paint adapts", I-6 "input encoder
  layer is non-optional" — all three grep-enforceable), §3.5 enforcement,
  §13.11 side-by-side diff (CI-runnable form), §13.9 compat matrix
  (machine-graded), §14.5 host/platform matrix, §19 removal gate (provides
  the CI workflow shapes that feed the gate).
- **Freezes**: `.github/workflows/*.yml` job shapes for the VT engine epic
  family, `tools/check-ui-no-ansi/` + `tools/check-paint-no-width-override/`
  + `tools/check-key-event-encoder-layer/` CLI contracts, golden-fixture
  corpus layout `crates/quanta-vt/tests/compat/<program>/` (file set), the
  pragma-escape grammar for CI allowlists, the platform-matrix doc format.
- **Out-of-scope**: the _semantic content_ of compat fixtures (EPIC-G owns).
  The _perf baseline numbers + benches_ (EPIC-J owns). The _code the rules
  enforce_ (EPIC-B / C / D / E own their own sources). EPIC-K owns the
  _rules_, _workflows_, and _doc surfaces_ that together make the invariants
  mechanically verifiable.
- **No-touch per parallel-agent brief**: `crates/quanta-vt-width/` and
  `crates/quanta-metrics/`.

This plan is the testable contract EPIC-K implementation will be held to.
Every Definition-of-Done item maps to a specific workflow file, tool CLI
test, or platform-matrix row.

---

## 1. Summary

**Goal**. Build the CI substrate that turns RFC §2's invariants from
design-document prose into machine-enforced rules, extends the compat matrix
to four platforms, and lays the golden-fixture scaffolding EPIC-G fills in.
Specifically:

1. Three grep rules (`check-ui-no-ansi`, `check-paint-no-width-override`,
   `check-key-event-encoder-layer`) enforce I-2, I-4, I-6 respectively.
2. Five workflow files (`vt-engine.yml`, `ui-renderer.yml`,
   `compat-matrix.yml`, `parity.yml`, plus extensions to `ci.yml` +
   `perf.yml`) cover every MUST acceptance from RFC §13.
3. Per-platform matrix doc (`docs/platform-matrix.md`) tracks macOS arm64,
   macOS x86_64, Linux x86_64, Windows x86_64 differences (RFC §14.5).
4. Golden-fixture scaffolding: directory structure + README for EPIC-G.
5. `justfile` targets so every CI check is locally runnable.

**Phase / Duration**. Phase 0 → Phase 6, rolling. ~1 week total effort
distributed across phases as the rules' targets land.

**Dependencies**. Schema freeze is Phase 0 (grep rule scaffolding + workflow
stubs). Each rule is _enforced_ in CI only after its target implementation
lands (so we don't block EPIC-B with a rule about EPIC-E). The 4-platform
matrix is activated in Phase 4 after EPIC-G's compat entries are recorded
on all platforms.

**Owner**. EPIC-K implementation agent. Works with every other epic's
agent to confirm rule patterns match the real (not assumed) code surface.

---

## 2. Background & motivation

### 2.1 Invariants need mechanical enforcement

RFC §2 lists ten invariants. Some are structural (I-1 "exactly one VT
engine") and enforced by the absence of code. Some are behavioral (I-7 "IME
preedit never enters the grid") and enforced by tests. Three are
grep-enforceable:

- **I-2** "UI does not parse ANSI. No `\x1b` escape-sequence
  interpretation, no CSI/OSC/DCS handling anywhere in TS."
- **I-4** "Semantic width wins, paint adapts. Font metrics MAY affect pixel
  placement, but they MAY NOT override the engine's semantic cell width."
- **I-6** "Input encoder layer is non-optional. Browser `KeyboardEvent` →
  encoder → bytes. Never browser → PTY directly."

Each is preventable by a simple static rule. Without CI, the rule relies on
reviewer vigilance and drifts over time. The cost of building the rule is a
few hundred lines of Rust; the cost of losing the rule is the return of the
dual-state architecture.

### 2.2 Four-platform matrix as a doc surface

RFC §14.5 lists "macOS, Linux, Windows behavior matrix maintained."
Turning that into a live document (`docs/platform-matrix.md`) with per-row
test coverage is what lets us make decisions about Windows "known partial"
status (RFC §14.5 rollback: "if Windows compat blocks too long, Windows
falls to 'known partial' status"). The matrix is the evidence for that
decision.

### 2.3 Why "rolling" cross-cutting

Each rule targets a specific epic's code. A rule landed before the code it
enforces either:
- Has nothing to scan → false green.
- Scans an empty tree → no-op, defers its real test.

Rules land simultaneously with the code they enforce. Workflow
_skeletons_ exist from Phase 0; enforcement activates as each impl epic
merges.

### 2.4 RFC invariants this realizes

- **I-1** — ensured by the absence of a second VT engine; EPIC-I's grep
  (`"xterm" packages/`) is part of the same family but owned by EPIC-I.
- **I-2** — `check-ui-no-ansi` (§4.1).
- **I-4** — `check-paint-no-width-override` (§4.2).
- **I-6** — `check-key-event-encoder-layer` (§4.3).
- **§3.5 enforcement** — "CI grep: no `\x1b` parsing outside
  `crates/quanta-vt/`" is literally §4.1's rule.
- **§13.11 side-by-side diff** — `ui-renderer.yml` runs the harness.
- **§13.9 compat matrix** — `compat-matrix.yml` runs EPIC-G fixtures per
  platform.
- **§14.5 platform matrix** — `docs/platform-matrix.md`.
- **§19 removal gate** — every workflow feeding the gate's evidence is
  defined here.

---

## 3. Scope

### 3.1 In-scope files

#### 3.1.1 New CI tooling binaries

All under `tools/`, each a small Rust binary run by workflow steps.

- `tools/check-ui-no-ansi/Cargo.toml`
- `tools/check-ui-no-ansi/src/main.rs`
- `tools/check-ui-no-ansi/src/scan.rs`
- `tools/check-ui-no-ansi/src/pragma.rs`
- `tools/check-ui-no-ansi/tests/scan.rs`
- `tools/check-ui-no-ansi/tests/fixtures/` — small TS files exercising
  each pattern + allowlist pragma.
- `tools/check-paint-no-width-override/Cargo.toml`
- `tools/check-paint-no-width-override/src/main.rs`
- `tools/check-paint-no-width-override/src/scan.rs`
- `tools/check-paint-no-width-override/tests/scan.rs`
- `tools/check-paint-no-width-override/tests/fixtures/`
- `tools/check-key-event-encoder-layer/Cargo.toml`
- `tools/check-key-event-encoder-layer/src/main.rs`
- `tools/check-key-event-encoder-layer/src/scan.rs`
- `tools/check-key-event-encoder-layer/src/pragma.rs`
- `tools/check-key-event-encoder-layer/tests/scan.rs`
- `tools/check-key-event-encoder-layer/tests/fixtures/`

Each tool follows the same shape:
- Binary takes an optional `--root <path>` (defaults to repo root).
- Walks `packages/` with a glob filter.
- Emits JSON-lines violations to stdout on failure.
- Exit code 0 = clean, 2 = violations, 1 = usage error.

The workspace already has three directories at the exact names used
above. This epic completes them (some may be empty skeletons today).

#### 3.1.2 New GitHub workflow files

- `.github/workflows/vt-engine.yml`
- `.github/workflows/ui-renderer.yml`
- `.github/workflows/compat-matrix.yml`
- `.github/workflows/parity.yml`

Plus modifications to:

- `.github/workflows/ci.yml` — wires the new sub-workflows via
  `workflow_call` + `needs:` dependencies.
- `.github/workflows/perf.yml` — EPIC-J owns content; EPIC-K adds the
  path-filter common to the other workflows (§4.5).

#### 3.1.3 Platform-matrix doc (new)

- `docs/platform-matrix.md` — per-platform quirk tracking (§4.4).

#### 3.1.4 Golden-fixture scaffolding (new)

- `crates/quanta-vt/tests/compat/README.md` — layout convention + how to
  regenerate fixtures. EPIC-G fills in the fixtures themselves.
- `crates/quanta-vt/tests/compat/.gitkeep` — keeps the directory alive
  until the first fixture lands.
- `scripts/record-compat-stream.sh` — `script(1)` wrapper EPIC-G uses.

#### 3.1.5 Justfile targets (extend)

- `justfile` — add:
  - `just check-ui-no-ansi` → invoke the tool.
  - `just check-paint-no-width-override` → invoke the tool.
  - `just check-key-event-encoder-layer` → invoke the tool.
  - `just ci-lint` → run all three plus the existing checks.
  - `just ci-platform-local` → the subset of `compat-matrix.yml` that
    runs locally.

### 3.2 Out-of-scope files

- The files the rules scan. Those belong to EPIC-B (`crates/quanta-vt/`),
  EPIC-D (`packages/ui/src/shared/ui/cell-renderer/`), EPIC-E
  (`packages/ui/src/features/input/`), etc.
- Compat fixture content (EPIC-G).
- Perf bench content (EPIC-J).
- `crates/quanta-vt-width/` + `crates/quanta-metrics/` per parallel-agent
  brief.

### 3.3 Relationship to existing tools

The workspace already has:
- `tools/check-fsd-layers.mjs` — JS tool; existing; this epic does not
  touch but references from `ci.yml`.
- `tools/check-adr-compliance/` — existing; referenced.
- `tools/check-event-topic-names/` — existing; referenced.
- `tools/check-hex-imports/` — existing; referenced.

The three new rules fit the same pattern (small Rust/JS CLI, JSON-lines
output, runs under `just ci-lint` and under `ci.yml`).

---

## 4. Design

### 4.1 `check-ui-no-ansi`

**Purpose** — enforce RFC I-2: no ANSI parsing in TS/JS code outside the
intentional input-encoder surface.

**Scan roots**:
- `packages/ui/src/**/*.{ts,tsx,js,jsx,mjs,cjs}`
- Excludes `__tests__/fixtures/` (fixture files may contain ANSI
  literally by design — they ARE terminal captures).
- Excludes `node_modules/`, `dist/`, `build/`.

**Forbidden patterns** (regex; case-sensitive):

| Pattern | Matches | Rationale |
|---|---|---|
| `\\x1b` | escape-character literal in strings | direct ANSI byte construction |
| `\\u001b` | Unicode escape for ESC | ditto |
| `ESC\\[` | "ESC[" as a string literal intending CSI | CSI construction |
| `\\bCsiParser\\b` | named parser class | implies ANSI parsing |
| `\\bOscParser\\b` | named OSC parser | ditto |
| `\\bDcsParser\\b` | named DCS parser | ditto |
| `\\bparseAnsi\\b` | function name | ditto |
| `\\bparseCSI\\b` | function name | ditto |

**Allowlist pragma**:

```ts
// allow-ansi-reference: <reason ≥ 10 chars>
const CURSOR_UP = "\x1b[A";
```

Pragma applies to the single line immediately following. The reason is
graded by length (≥ 10 chars) not by content — length is a nudge toward
"explain yourself," not a content filter. The input-encoder files under
`packages/ui/src/features/input/` are expected to use this pragma for
output-byte construction (e.g., building `ESC [ 200~` for bracketed
paste). They are still ANSI byte emitters; they just are _not_ ANSI
parsers, which is what I-2 prohibits.

**CLI shape**:

```
check-ui-no-ansi [--root <repo-root>] [--json]

Exit 0: no violations.
Exit 2: ≥ 1 violation. JSON-lines on stdout:
  {"file": "packages/ui/src/shared/x.ts", "line": 42, "pattern": "\\x1b",
   "content": "...", "suggestion": "add pragma or move to encoder"}
Exit 1: usage error.
```

**Implementation note** — Rust binary, `walkdir` crate, `regex` crate.
Preserves line numbers via a `BufReader<File>::lines()` scan; no AST
needed.

**Unit test plan** — five fixture files in
`tools/check-ui-no-ansi/tests/fixtures/`:

1. `clean.ts` — no ANSI, no pragma. Expect: clean.
2. `bare-escape.ts` — `const x = "\x1b[0m";` no pragma. Expect: one
   violation.
3. `allowed.ts` — pragma + escape on next line. Expect: clean.
4. `short-reason.ts` — pragma with reason < 10 chars. Expect: one
   violation (reason too short).
5. `csi-parser.ts` — `class CsiParser {}`. Expect: one violation.

### 4.2 `check-paint-no-width-override`

**Purpose** — enforce RFC I-4: no paint-layer file imports width logic
other than the TS mirror of `quanta-vt-width`.

**Scan roots**:
- `packages/ui/src/shared/ui/cell-renderer/**`
- `packages/ui/src/widgets/terminal-canvas/**`

**Forbidden imports** — string-match on `import` specifiers:
- `unicode-width`
- `grapheme-splitter`
- `grapheme-breaker`
- `wc-width`
- `string-width`
- any other `*width*` / `*grapheme*` package OTHER THAN
  `@/shared/lib/width/*` (the EPIC-A TS mirror).

**Allowlist** — no pragma. This rule has no escape valve. If a new width
library is needed, the right move is to extend the TS mirror (EPIC-A)
rather than import a competing library. Shutting the escape valve here
is deliberate: RFC I-4 is a non-negotiable invariant and the correct
path is always "route through the SSOT."

**CLI shape** — same as §4.1.

**Unit test plan** — five fixtures:

1. `clean.ts` — imports from `@/shared/lib/width/`. Clean.
2. `unicode-width.ts` — `import wcwidth from "unicode-width";`. Violation.
3. `grapheme-splitter.ts` — violation.
4. `star-import.ts` — `import * as w from "unicode-width";`. Violation.
5. `require-style.ts` — `const w = require("unicode-width");`. Violation.

### 4.3 `check-key-event-encoder-layer`

**Purpose** — enforce RFC I-6: browser `KeyboardEvent` values reach PTY
only via the encoder surface under `packages/ui/src/features/input/`.

**Scan roots**:
- `packages/ui/src/**/*.{ts,tsx}` EXCEPT `packages/ui/src/features/input/**`
  itself.

**Forbidden combinations** — any file that:
1. Has an identifier `KeyboardEvent`, OR has a `keydown` / `keypress` /
   `keyup` event listener, AND
2. Calls `bridge.write(...)` / `session.write(...)` / `writePty(...)` /
   any of a configured list of PTY-write names directly — without
   routing through `import { keyEncoder, ... } from
   "@/features/input"`.

The rule fires when (1) and (2) appear in the same file AND the file
does not import from the encoder barrel. The false-positive surface is
a file that uses `KeyboardEvent` as a _type_ (not a value) while
happening to also write to PTY for unrelated reasons; the pragma
(below) covers that case.

**Allowlist pragma**:

```ts
// allow-direct-write: <reason ≥ 10 chars>
bridge.write(controlBytes);
```

Pragma applies to the single line immediately following. Valid uses are
limited: protocol-level control bytes (non-keyboard) from a feature that
has legitimate direct-write needs (e.g., a resize signaller).

**CLI shape** — same as §4.1.

**Unit test plan** — five fixtures:

1. `clean-encoder.ts` — imports from `@/features/input`, uses
  `keyEncoder(...).bytes` then writes. Clean.
2. `bad-direct-write.ts` — `KeyboardEvent` + `bridge.write(ev.key)` no
  pragma. Violation.
3. `allowed-direct-write.ts` — pragma + direct write. Clean.
4. `type-only-keyboard-event.ts` — uses `KeyboardEvent` as a type, calls
  `bridge.write(binaryProtocolBytes)`. With pragma: clean. Without:
  violation.
5. `input-feature-internal.ts` — file lives inside `features/input/`, rule
  ignores it (scan exclusion).

### 4.4 Platform matrix

`docs/platform-matrix.md` structure:

```markdown
# Platform compatibility matrix

Tracks per-platform quirks for the terminal engine. Drives RFC §14.5
rollback decisions; feeds RFC §19 removal gate.

Last reviewed: <date>
Last re-captured: <date>

| Row | macOS arm64 | macOS x86_64 | Linux x86_64 (Ubuntu 22.04) | Linux x86_64 (Arch) | Windows x86_64 |
|---|---|---|---|---|---|
| IME behavior — Korean 2-set | tested, pass | TBD | tested, pass | TBD | TBD |
| IME behavior — Japanese IME | tested, pass | TBD | TBD | TBD | TBD |
| IME behavior — Chinese pinyin | tested, pass | TBD | TBD | TBD | TBD |
| Font fallback chain | CoreText, tested | CoreText, TBD | fontconfig, TBD | fontconfig, TBD | DirectWrite, TBD |
| IME candidate-popup anchoring | cellToScreen, tested | TBD | over-root-window, TBD | over-root-window, TBD | DirectManipulation, TBD |
| Focus-out policy during IME | cancel | cancel | preserve 1s | preserve 1s | preserve 1s |
| Clipboard permission prompt | browser-level | browser-level | browser-level | browser-level | browser-level |
| Bracketed-paste default | on | on | on | on | on |
| `$TERM` identity | xterm-256color | xterm-256color | xterm-256color | xterm-256color | xterm-256color |
| Known quirks | — | — | under-test locale drift (LANG=ko_KR.UTF-8 ambiguous-width) | — | ConPTY resize latency (RFC §14.5 known-partial) |
```

Each cell value is one of:
- `tested, pass` — CI has an artifact proving this.
- `tested, partial` — CI has a partial pass (edge cases listed below the
  table).
- `TBD` — no coverage yet.
- freeform — a specific note that does not fit the prior three.

### 4.5 Workflow architecture

#### 4.5.1 Top-level `ci.yml` as orchestrator

`ci.yml` becomes a dispatcher:

```yaml
jobs:
  fast-lints:
    uses: ./.github/workflows/lints.yml
  vt-engine:
    uses: ./.github/workflows/vt-engine.yml
    needs: [fast-lints]
  ui-renderer:
    uses: ./.github/workflows/ui-renderer.yml
    needs: [fast-lints]
  parity:
    uses: ./.github/workflows/parity.yml
    needs: [vt-engine, ui-renderer]
  compat-matrix:
    uses: ./.github/workflows/compat-matrix.yml
    needs: [parity]
  perf:
    uses: ./.github/workflows/perf.yml
    needs: [vt-engine, ui-renderer]
```

Each sub-workflow is `workflow_call`-shaped and runs independently on
its path filter.

#### 4.5.2 `vt-engine.yml`

Runs on any PR touching `crates/quanta-vt/**`,
`crates/quanta-vt-width/**`, `crates/quanta-proto/**`:

```yaml
jobs:
  cargo-tests:
    runs-on: ubuntu-22.04
    steps:
      - checkout
      - cargo test -p quanta-vt
      - cargo test -p quanta-vt-width
      - cargo clippy -p quanta-vt -- -D warnings
  fuzz-smoke:
    runs-on: ubuntu-22.04
    steps:
      - checkout
      - cargo fuzz run vte_process --max-total-time=120 # 2-minute smoke
  compat-unit:
    runs-on: ubuntu-22.04
    steps:
      - checkout
      - cargo test -p quanta-vt --test compat
```

#### 4.5.3 `ui-renderer.yml`

Runs on any PR touching `packages/ui/src/**`:

```yaml
jobs:
  vitest:
    runs-on: ubuntu-22.04
    steps:
      - checkout
      - pnpm install --frozen-lockfile
      - pnpm --filter @quanta/ui test
  visual-regression:
    runs-on: ubuntu-22.04
    steps:
      - checkout
      - pnpm --filter @quanta/ui test:visual
  ime-goldens:
    runs-on: macos-14
    if: secrets.MACOS_RUNNER_TOKEN  # if: guard; skip if secret absent
    steps:
      - checkout
      - pnpm --filter @quanta/ui test:ime
```

The `if:` guard on the IME-goldens job exists because not every fork
has a macOS runner with the required IME-replay token. The guard makes
the job a soft-skip rather than a hard fail on forks.

#### 4.5.4 `compat-matrix.yml`

The big one. Runs on-schedule (nightly) AND on PRs touching
`crates/quanta-vt/tests/compat/**`:

```yaml
strategy:
  fail-fast: false
  matrix:
    os: [macos-14, macos-13-x86_64, ubuntu-22.04, ubuntu-arch-docker, windows-latest]
    program: [vim, nvim, less, nano, htop, btop, top, tmux, vim-in-tmux,
              ssh-loopback, man, ranger, mc]
    exclude:
      - {os: windows-latest, program: ssh-loopback}  # Windows ssh flow differs
jobs:
  compat:
    runs-on: ${{ matrix.os }}
    continue-on-error: ${{ matrix.os == 'windows-latest' }}  # known-partial per §4.5
    steps:
      - checkout
      - cargo run -p quanta-vt --example compat-runner -- --program ${{ matrix.program }}
      - upload-artifact: compat-report.json
```

Windows is gated `continue-on-error: true` to implement the RFC §14.5
"known partial" status. The final aggregation job examines all reports
and fails the build iff any macOS-arm64/macOS-x86/Linux cell is red;
Windows reds are recorded as advisory. This matches §19 gate
expectations (Windows can be partial; macOS + Linux must be green).

#### 4.5.5 `parity.yml`

Runs on any PR touching width/grapheme code:

```yaml
jobs:
  rust-ts-parity:
    runs-on: ubuntu-22.04
    steps:
      - checkout
      - cargo test -p quanta-vt-width --test parity
      - pnpm --filter @quanta/ui test -- width-parity
      - node tools/parity-compare.mjs \
          target/rust-parity.json \
          packages/ui/dist/ts-parity.json
```

### 4.6 Pragma grammar

All three grep rules share one pragma grammar:

```
// <allowlist-kind>: <reason>
```

- `<allowlist-kind>` is the rule-specific literal (e.g.,
  `allow-ansi-reference`, `allow-direct-write`).
- `<reason>` is free text ≥ 10 characters.
- Pragma applies to the immediately following line only (single-line
  scope). Block-scope pragmas are not supported; if a block needs many
  exceptions, the block needs refactoring.

The grammar is parsed with a tiny regex; the implementation lives in
`tools/<rule>/src/pragma.rs` for each rule that has a pragma.

### 4.7 Rule dogfood period

Each rule lands in two steps:

1. **Soft-enforcement.** The rule runs in CI with `continue-on-error:
   true` and posts violations as a PR comment for 1 week. False
   positives are reported and fixed by extending the pragma allowlist
   or tightening the pattern.
2. **Hard enforcement.** After 1 week clean, `continue-on-error` is
   removed; violations fail the build.

This prevents the anti-pattern of a newly-landed rule blocking every PR
because of a false-positive not caught in rule-unit-testing.

### 4.8 Golden-fixture layout

`crates/quanta-vt/tests/compat/<program>/` structure (EPIC-G owns
contents; this epic freezes the layout):

```
compat/
├── README.md                     # (this epic writes)
├── vim/
│   ├── scenario.md               # human-readable what-was-typed
│   ├── input.pty                 # raw PTY byte capture
│   ├── expected_grid_snapshot.json
│   ├── expected_cursor.json
│   └── expected_modes.json
├── nvim/
│   └── ...same structure...
...
```

The README documents:
- How to record a fixture (via `scripts/record-compat-stream.sh`).
- What `TERM`, `LINES`, `COLUMNS` to set.
- How to verify the fixture locally before committing.
- The CI workflow that consumes it.

### 4.9 Justfile targets

Extension to `justfile`:

```make
check-ui-no-ansi:
    cargo run -p check-ui-no-ansi -- --root .

check-paint-no-width-override:
    cargo run -p check-paint-no-width-override -- --root .

check-key-event-encoder-layer:
    cargo run -p check-key-event-encoder-layer -- --root .

ci-lint: check-ui-no-ansi check-paint-no-width-override check-key-event-encoder-layer
    pnpm --filter @quanta/ui lint:fsd
    node tools/check-hex-imports/index.mjs
    node tools/check-event-topic-names/index.mjs
    node tools/check-adr-compliance/index.mjs

ci-platform-local:
    cargo test -p quanta-vt --test compat -- --platform $(uname -s -m)
```

This is the "no CI surprises" principle: every check the workflow runs
is a `just` target.

---

## 5. Definition of Done (DoD)

Minimum 25. This list has 32.

### 5.1 Grep rules — code + tests (Phase 0-3 rolling)

- [ ] **K-DoD-01.** `tools/check-ui-no-ansi/` compiles
  (`cargo build -p check-ui-no-ansi`).
- [ ] **K-DoD-02.** `tools/check-ui-no-ansi/tests/scan.rs` has ≥ 5
  fixture-driven tests covering each forbidden pattern + pragma
  allowlist + short-reason rejection.
- [ ] **K-DoD-03.** `tools/check-ui-no-ansi` runs clean on the repo at
  Phase 2 (after EPIC-D lands, the renderer has no ANSI).
- [ ] **K-DoD-04.** `tools/check-paint-no-width-override/` compiles.
- [ ] **K-DoD-05.** `tools/check-paint-no-width-override/tests/scan.rs`
  has ≥ 5 fixture tests.
- [ ] **K-DoD-06.** `tools/check-paint-no-width-override` runs clean on
  the repo at Phase 2 (after EPIC-D lands, renderer imports only
  `@/shared/lib/width/*`).
- [ ] **K-DoD-07.** `tools/check-key-event-encoder-layer/` compiles.
- [ ] **K-DoD-08.** `tools/check-key-event-encoder-layer/tests/scan.rs`
  has ≥ 5 fixture tests.
- [ ] **K-DoD-09.** `tools/check-key-event-encoder-layer` runs clean on
  the repo at Phase 3 (after EPIC-E lands).
- [ ] **K-DoD-10.** Each tool's CLI exit code convention (0 / 1 / 2)
  documented in the tool's `src/main.rs` header comment + enforced by
  its unit tests.
- [ ] **K-DoD-11.** Pragma grammar identical across all three tools
  (§4.6) — one `pragma.rs` shape replicated.

### 5.2 Workflow files

- [ ] **K-DoD-12.** `.github/workflows/vt-engine.yml` exists, runs the
  three jobs in §4.5.2, passes on a clean main.
- [ ] **K-DoD-13.** `.github/workflows/ui-renderer.yml` exists, runs the
  three jobs in §4.5.3, passes. Macos-14 IME-goldens job uses `if:`
  guard.
- [ ] **K-DoD-14.** `.github/workflows/compat-matrix.yml` exists, runs
  the matrix in §4.5.4, aggregates results with Windows `continue-on-
  error`.
- [ ] **K-DoD-15.** `.github/workflows/parity.yml` exists.
- [ ] **K-DoD-16.** `.github/workflows/ci.yml` refactored to call the
  four sub-workflows via `workflow_call`.
- [ ] **K-DoD-17.** Each workflow has a `paths:` filter scoped to the
  files it cares about (§4.5.2 — §4.5.5).
- [ ] **K-DoD-18.** Each workflow uploads its JSON / artifact output to
  GitHub for downstream review.

### 5.3 Platform matrix doc

- [ ] **K-DoD-19.** `docs/platform-matrix.md` exists.
- [ ] **K-DoD-20.** Matrix has all 4 platform columns (macOS arm64,
  macOS x86_64, Linux x86_64, Windows x86_64); Linux split into
  Ubuntu + Arch gives 5 effective columns.
- [ ] **K-DoD-21.** Matrix has ≥ 8 rows (IME Korean, IME JP, IME CN,
  font fallback, IME popup anchoring, focus-out policy, clipboard,
  bracketed-paste, `$TERM`, known quirks).
- [ ] **K-DoD-22.** Last-reviewed / last-re-captured dates present.
- [ ] **K-DoD-23.** Rollback clause from RFC §14.5 referenced explicitly.

### 5.4 Golden scaffolding

- [ ] **K-DoD-24.** `crates/quanta-vt/tests/compat/README.md` documents
  the per-program layout (§4.8).
- [ ] **K-DoD-25.** `crates/quanta-vt/tests/compat/.gitkeep` preserves
  the directory.
- [ ] **K-DoD-26.** `scripts/record-compat-stream.sh` is a working
  `script(1)` wrapper with `TERM=xterm-256color LINES=40 COLUMNS=120`
  defaults.

### 5.5 Justfile

- [ ] **K-DoD-27.** `justfile` has five new targets per §4.9.
- [ ] **K-DoD-28.** `just ci-lint` runs all three new rules + the three
  existing rules.
- [ ] **K-DoD-29.** `just ci-platform-local` runs the per-platform
  compat subset on the local uname.

### 5.6 Dogfood + enforcement

- [ ] **K-DoD-30.** Each grep rule ran for 1 week in
  `continue-on-error: true` mode before enforcement; tracking issue
  lists any false-positive hits and pragma-grammar extensions.
- [ ] **K-DoD-31.** After dogfood, `continue-on-error` removed; rule is
  a blocking CI check.
- [ ] **K-DoD-32.** Workflow green on clean `main` for 5 consecutive
  runs before declaring the epic done (catches infra flakiness early).

---

## 6. Quality gates

| Gate | Check | Run when | Fail response |
|---|---|---|---|
| `check-ui-no-ansi` | zero violations in `packages/ui/src/` | Every PR | Add pragma (with ≥10-char reason) or refactor |
| `check-paint-no-width-override` | zero violations in renderer dirs | Every PR | Refactor to use TS mirror (no pragma; no escape) |
| `check-key-event-encoder-layer` | zero violations in `packages/ui/src/` | Every PR | Route through encoder or add pragma |
| `vt-engine.yml` jobs | cargo test green, clippy clean, fuzz smoke non-panic | Every PR touching engine | Diagnose + fix |
| `ui-renderer.yml` jobs | vitest green, visual-regression within ±1 px | Every PR touching UI | Diagnose + fix |
| `compat-matrix.yml` | macOS + Linux cells green; Windows advisory | Nightly + on touch | macOS/Linux red → fail build; Windows red → record |
| `parity.yml` | Rust↔TS parity corpus byte-identical output | Every PR touching width code | Fix parity drift |
| `perf.yml` | per-stage p95 within 110% of baseline (EPIC-J) | Every PR touching hot path | See EPIC-J |
| Platform matrix freshness | last-reviewed within 90 days | Quarterly | Re-review |
| Workflow uptime | 5 green main runs pre-enforcement | Pre-hard-enforce of each rule | Fix flakes before enforcement |
| Pragma reason length | ≥ 10 chars | Rule runtime | Reject the pragma |
| Pragma scope | applies to 1 line only | Rule runtime | Reject multi-line pragmas |

---

## 7. E2E scenarios

Minimum 6. This list has 7.

### 7.1 E2E-K1 — ANSI in UI fails `check-ui-no-ansi`

**Goal**. Confirm the rule catches a basic injection.

**Steps**.
1. Branch from main.
2. Add `const cursorUp = "\x1b[A";` to
  `packages/ui/src/shared/hello.ts` (no pragma).
3. Push.
4. Observe `ci.yml` → `check-ui-no-ansi` step fails; PR carries a
   violation report identifying the file + line.
5. Remove the line; re-push; CI green.

**Pass**. Rule fires on step 4; clears on step 5.

### 7.2 E2E-K2 — ANSI with pragma passes

**Goal**. Pragma allowlist is honored.

**Steps**.
1. Add the same line preceded by
   `// allow-ansi-reference: bracketed-paste sentinel construction for
   PTY out`.
2. Push.
3. CI green.
4. Change the pragma reason to `// allow-ansi-reference: x` (too short).
5. Push.
6. CI fails with a "reason too short" violation.

**Pass**. Steps 3 and 6 are the two expected outcomes.

### 7.3 E2E-K3 — `unicode-width` import fails `check-paint-no-width-override`

**Goal**. Rule catches the I-4 violation.

**Steps**.
1. Branch.
2. Add `import wcwidth from "unicode-width";` in
  `packages/ui/src/shared/ui/cell-renderer/Renderer.ts`.
3. Push.
4. CI fails with a violation referencing the import line.
5. Replace with `import { width } from "@/shared/lib/width";`.
6. Push.
7. CI green.

**Pass**. No pragma escape was offered; only refactoring satisfies the
rule.

### 7.4 E2E-K4 — Direct `bridge.write` from a non-encoder file fails

**Goal**. Rule catches the I-6 violation.

**Steps**.
1. Branch.
2. Add, in `packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx`:

   ```tsx
   onKeyDown={(ev) => bridge.write(new TextEncoder().encode(ev.key))}
   ```
3. Push.
4. CI fails: `KeyboardEvent` + `bridge.write` co-occur without an
   import from `@/features/input`.
5. Refactor to use `keyEncoder(ev).bytes` and write that through the
   input feature's orchestrator.
6. Push.
7. CI green.

**Pass**. Rule fires on step 4; clears on step 5.

### 7.5 E2E-K5 — PR touches `vte_processor.rs` → full workflow fan-out

**Goal**. Path-filters correctly route the PR to the relevant workflows.

**Steps**.
1. Branch; add a trivial comment to
  `crates/quanta-vt/src/adapters/vte_processor.rs`.
2. Push.
3. Observe that `vt-engine.yml`, `parity.yml`, `perf.yml`, and
  `compat-matrix.yml` all trigger; `ui-renderer.yml` does NOT trigger
  (no UI file changed).

**Pass**. The four expected workflows run; the UI workflow does not.

### 7.6 E2E-K6 — Windows compat red → known-partial advisory

**Goal**. Verify the `continue-on-error` plumbing.

**Steps**.
1. Branch.
2. Mock a Windows-specific compat failure (either a real regression or
  an injected failure in a test-only branch).
3. Push.
4. Observe: `compat-matrix.yml` aggregation job runs; Windows cell is
  red; macOS + Linux cells are green; aggregation job is green (the
  build does not block).
5. Aggregation job posts a PR comment highlighting the Windows advisory.

**Pass**. PR is mergeable despite Windows red; the advisory is visible.

### 7.7 E2E-K7 — Pragma grammar — multi-line rejection

**Goal**. Pragma applies only to the following single line.

**Steps**.
1. Add:

   ```ts
   // allow-ansi-reference: bracketed paste sentinels
   const START = "\x1b[200~";
   const END = "\x1b[201~";
   ```
2. Push.
3. CI fails: the pragma covers only `START`; `END` is unaccompanied.
4. Fix:

   ```ts
   // allow-ansi-reference: bracketed paste sentinels
   const START = "\x1b[200~";
   // allow-ansi-reference: bracketed paste sentinels
   const END = "\x1b[201~";
   ```
5. Push.
6. CI green.

**Pass**. Rule is scope-strict; author is forced to acknowledge every
violation individually.

---

## 8. Test deliverables

### 8.1 Unit tests per rule

Minimum 5 fixtures per rule (§4.1 — §4.3 detail each). 15 fixture files
in total under `tools/*/tests/fixtures/`.

### 8.2 Workflow smoke tests

- `tools/workflow-smoke/` — a small script that exercises each workflow
  file via `act` (if available) or manual-dispatch and verifies the job
  shape matches the plan. This is optional for CI time reasons; the
  required gate is a 5-green-run streak on main (K-DoD-32).

### 8.3 Golden-fixture layout smoke

- `crates/quanta-vt/tests/compat/README.md` includes a "how to verify"
  section the EPIC-G agent follows.
- `scripts/record-compat-stream.sh` has a `--dry-run` mode that exercises
  the script without recording.

### 8.4 Platform matrix capture procedure

Inline in `docs/platform-matrix.md`: instructions for re-capturing a
cell when a platform's behavior changes. The capture procedure
references the compat-matrix workflow and instructs the re-capture
author to commit the updated row + the linked compat-report artifact
from the workflow run.

---

## 9. Failure modes retired

Indirect — CI rules catch drift at PR time, before it merges. Specific
mappings:

- **§16 BAN #1** (UI re-parses ANSI) — `check-ui-no-ansi` is the
  automated enforcer.
- **§16 BAN #9** (paint layer corrects width) —
  `check-paint-no-width-override` is the automated enforcer.
- **§2 I-6** (input encoder non-optional) —
  `check-key-event-encoder-layer` is the automated enforcer.
- **RFC §14.5** platform matrix policy — `compat-matrix.yml` + the
  platform-matrix doc operationalize the "Windows as known partial"
  rollback option.

No row of RFC §22's 20 concrete failure modes is _retired_ here — those
are all retired by the implementation epics. This epic's retirement
surface is the meta-risk of "someone reintroduces one of the banned
patterns."

---

## 10. Risks

### 10.1 Grep rules over-reject (false positives)

**Likelihood**. High initially; decaying after dogfood.
**Impact**. Medium — PR authors hit rule false positives and lose trust.
**Mitigation**. Pragma escape valve (§4.6) + dogfood period (§4.7)
before hard enforcement. Each false positive → pattern tightening PR.

### 10.2 Grep rules under-reject (false negatives)

**Likelihood**. Medium.
**Impact**. High — the whole point of the rule was to catch this.
**Mitigation**. The rule's fixture suite includes explicit
false-negative cases ("this SHOULD fire; rule must catch it"). If a
false-negative hits production code, add a fixture + tighten pattern
in the same PR.

### 10.3 Windows compat flaky

**Likelihood**. High.
**Impact**. Low — `continue-on-error` policy makes it advisory.
**Mitigation**. RFC §14.5 known-partial status. §19 gate explicitly
allows Windows-partial with macOS + Linux green.

### 10.4 Workflow sprawl

**Likelihood**. Medium — 5 new .yml files.
**Impact**. Medium — reviewer confusion + slow CI.
**Mitigation**. All sub-workflows called from `ci.yml` via
`workflow_call`; path filters prevent irrelevant fan-out; aggregation
is in `ci.yml`.

### 10.5 CI time budget

**Likelihood**. Medium.
**Impact**. Medium.
**Mitigation**. Path filters (§4.5.2 — §4.5.5). Fuzz smoke is 2 minutes,
not 1 hour; deep fuzz runs are nightly only. Compat matrix Windows
runs are nightly + touch-based, not on every PR.

### 10.6 Platform matrix doc rots

**Likelihood**. High over time.
**Impact**. Medium.
**Mitigation**. Quarterly review gate (K-DoD-32) + a last-reviewed
date in the doc itself. CI does not enforce this (no good way to); a
human calendar reminder and a linked GitHub issue template is the
mitigation.

### 10.7 Secret-dependent steps hard-fail forks

**Likelihood**. High if unprotected.
**Impact**. Medium.
**Mitigation**. Every secret-dependent step uses `if: secrets.FOO` to
soft-skip on forks (§4.5.3 IME-goldens job is the reference example).

### 10.8 Pragma grammar drift between tools

**Likelihood**. Low.
**Impact**. Low.
**Mitigation**. §4.6 single grammar; each tool imports a shared
`pragma.rs` (or at least copies it byte-identically and tests the
parse).

---

## 11. Rollback

### 11.1 Rule-level rollback

Each rule can be disabled individually by removing its step from the
workflow or adding `continue-on-error: true` back. The tool binaries
stay in the repo; disabling is a workflow-level change.

### 11.2 Workflow-level rollback

Each sub-workflow can be disabled via commenting out its
`workflow_call` invocation in `ci.yml`. The sub-workflow file stays in
the repo for re-enablement later.

### 11.3 Platform-level rollback

Windows "known-partial" is already a soft-rollback built into the
design (RFC §14.5 + §4.5.4 `continue-on-error`). If macOS x86_64
becomes persistently flaky (e.g., GitHub deprecates the runner), it
too can be moved to known-partial with a doc update; RFC §19 gate
still permits removal with macOS-arm64 + Linux green.

### 11.4 Compat-matrix-level rollback

If the compat matrix is too expensive for CI time, the rollback is:
1. Move full matrix to nightly.
2. Retain a smoke-only matrix (one platform, one program per family) on
  per-PR.
3. Full matrix is the release-cut gate rather than the merge gate.
This is a strict downgrade from the Phase 4 target but keeps the
evidence chain alive.

---

## 12. Cross-references

### 12.1 RFC 0001 sections

- **§2** — the 10 invariants, especially I-2, I-4, I-6 (enforced here).
- **§3.5** — "CI grep: no `\x1b` parsing outside `crates/quanta-vt/`"
  is §4.1.
- **§13.9** — compat matrix programs; `compat-matrix.yml` runs them.
- **§13.10** — golden replay; scaffolding here, content in EPIC-G.
- **§13.11** — side-by-side diff; covered by `ui-renderer.yml` visual
  regression + EPIC-H's harness.
- **§14.5** — platform matrix; `docs/platform-matrix.md` + Windows
  known-partial policy (§4.5.4).
- **§19** — removal gate; CI workflows here feed its evidence.

### 12.2 Related ADRs

- **ADR 0001** (host modes) — updated by EPIC-I; this epic preserves
  backward-compat via path filters during the transition.
- **ADR 0014** (architecture invariants / repository structure) — the
  invariant list this epic enforces a subset of.
- **ADR 0015** (width / grapheme / line-break SSOT) —
  `check-paint-no-width-override` enforces the TS mirror of this ADR.
- **ADR 0017** (reducer ordering + mode authority) — `vt-engine.yml`
  runs the tests.
- **ADR 0018** (IME state machine) — `ui-renderer.yml` IME-goldens job
  runs the recordings.

### 12.3 Related epics

- **EPIC-A** — width SSOT; `parity.yml` runs its parity tests.
- **EPIC-B** — engine; `vt-engine.yml` runs its tests.
- **EPIC-C** — protocol; `parity.yml` includes schema-parity.
- **EPIC-D** — renderer; `check-paint-no-width-override` enforces its
  invariant.
- **EPIC-E** — input; `check-key-event-encoder-layer` enforces its
  invariant.
- **EPIC-G** — compat fixtures; this epic scaffolds the directory.
- **EPIC-I** — removes xterm; every workflow here runs post-removal
  green.
- **EPIC-J** — owns `perf.yml` content; this epic owns path-filter +
  workflow_call shape.

### 12.4 Related docs + scripts

- `docs/platform-matrix.md` — created here.
- `scripts/record-compat-stream.sh` — created here.
- `tools/check-ui-no-ansi/`, `tools/check-paint-no-width-override/`,
  `tools/check-key-event-encoder-layer/` — created / completed here.
- `tools/check-fsd-layers.mjs`, `tools/check-hex-imports/`,
  `tools/check-event-topic-names/`, `tools/check-adr-compliance/` —
  existing tools; unchanged; listed because `ci.yml` calls them.

---

## 13. Work breakdown

### 13.1 Phase 0 — grep rule scaffolding + workflow skeletons

- Scaffold `tools/check-ui-no-ansi/`,
  `tools/check-paint-no-width-override/`,
  `tools/check-key-event-encoder-layer/`: Cargo.toml + skeleton
  main.rs + minimal fixture test.
- Draft `.github/workflows/vt-engine.yml`, `ui-renderer.yml`,
  `compat-matrix.yml`, `parity.yml` as no-op skeletons (the jobs
  exist, they don't yet run the real tests).
- Draft `docs/platform-matrix.md` with all rows as TBD.
- Add `just check-*` stubs to `justfile`.

Exit: workflows visible in Actions UI; rules compile; no enforcement
yet.

### 13.2 Phase 1 — rules enforced as engine + protocol land

- `check-ui-no-ansi` soft-enforcement activated (1-week dogfood).
- `vt-engine.yml` job fills in real `cargo test` calls.
- `parity.yml` fills in real width parity call.

### 13.3 Phase 2 — renderer rule activates

- `check-paint-no-width-override` soft-enforcement activated.
- `ui-renderer.yml` fills in vitest calls.

### 13.4 Phase 3 — input rule activates

- `check-key-event-encoder-layer` soft-enforcement activated.
- `ui-renderer.yml` IME-goldens job wired.

### 13.5 Phase 4 — compat matrix activates; platform doc populated

- `compat-matrix.yml` with all 5 platform-columns wired.
- `docs/platform-matrix.md` rows filled with tested/TBD/known-partial
  labels.
- Windows known-partial policy confirmed in the doc.

### 13.6 Phase 5 — all rules hard-enforced

- After 1 week of each rule clean, `continue-on-error: true` stripped.
- Rules become blocking CI checks.

### 13.7 Phase 6 — final CI health check before EPIC-I

- 5 consecutive green main runs across all workflows.
- Platform matrix row-by-row review signed off.
- EPIC-I unblocked to start preflight.

---

## 14. Appendix — worked example of the `check-ui-no-ansi` scan

To make the rule's behavior concrete, here is a walked example against a
hypothetical file.

Input file `packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx`:

```tsx
import { keyEncoder } from "@/features/input";
// allow-ansi-reference: bracketed paste sentinel for PTY output
const PASTE_START = "\x1b[200~";
const BAD = "\u001b[0m";

class CsiParser {}  // this would be a rule hit even without a literal

function handleKey(ev: KeyboardEvent) {
  bridge.write(keyEncoder(ev).bytes);  // fine — routed through encoder
}
```

Rule output:

```json
{"file": "packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx",
 "line": 4, "pattern": "\\u001b",
 "content": "const BAD = \"\\u001b[0m\";",
 "suggestion": "add `// allow-ansi-reference: <reason>` pragma or route through encoder"}
{"file": "packages/ui/src/widgets/terminal-canvas/TerminalCanvas.tsx",
 "line": 6, "pattern": "\\bCsiParser\\b",
 "content": "class CsiParser {}",
 "suggestion": "CSI parsing belongs in crates/quanta-vt; remove from UI"}
```

Exit code 2. The line with the pragma above it (line 3's `PASTE_START`)
is NOT reported because the pragma on line 2 covers it. `handleKey` is
NOT reported because it routes through the encoder.

The example demonstrates:
- Pragma scope is strictly single-line-after.
- Different forbidden patterns surface different violations.
- Legitimate encoder-routing passes unrestricted.

This is the behavioral contract the implementation agent codes against.

---

## 15. Appendix — platform matrix update procedure

When a platform's behavior changes (either new coverage or a regression
discovered):

1. Open `docs/platform-matrix.md`.
2. Update the affected cell's label (`tested, pass` / `tested, partial` /
  `TBD` / freeform note).
3. If the update reflects a new compat workflow run, link to the
  GitHub Actions run URL in the cell or in a footnote.
4. Update the `Last re-captured` date at the top of the doc.
5. Commit the doc change as its own PR with the GitHub Actions URL in
  the commit message.

This procedure ensures every platform-matrix change is traceable to a
specific CI artifact.

---

## 16. Appendix — exact workflow path-filter reference

Paste-ready for the implementation agent.

**`vt-engine.yml`**:
```yaml
on:
  pull_request:
    paths:
      - 'crates/quanta-vt/**'
      - 'crates/quanta-vt-width/**'
      - 'crates/quanta-proto/**'
      - '.github/workflows/vt-engine.yml'
```

**`ui-renderer.yml`**:
```yaml
on:
  pull_request:
    paths:
      - 'packages/ui/**'
      - 'packages/host-common/**'
      - '.github/workflows/ui-renderer.yml'
```

**`compat-matrix.yml`**:
```yaml
on:
  schedule:
    - cron: '0 5 * * *'  # nightly 05:00 UTC
  pull_request:
    paths:
      - 'crates/quanta-vt/tests/compat/**'
      - 'scripts/record-compat-stream.sh'
      - '.github/workflows/compat-matrix.yml'
```

**`parity.yml`**:
```yaml
on:
  pull_request:
    paths:
      - 'crates/quanta-vt-width/**'
      - 'packages/ui/src/shared/lib/width/**'
      - 'crates/quanta-proto/**'
      - 'packages/host-common/src/events.ts'
      - '.github/workflows/parity.yml'
```

Each filter is deliberately narrow; broader filters burn CI minutes
without value. The filters are themselves listed as a scanned path so
that editing a filter triggers the workflow it filters — catching
self-regression.

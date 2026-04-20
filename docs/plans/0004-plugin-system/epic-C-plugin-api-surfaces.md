# Epic C — Plugin API Surfaces

- **Parent**: `docs/rfc/0004-plugin-system.md`, `docs/plans/0004-plugin-system/README.md`
- **Depends on**: Epic A (manifest), Epic B (runtime host)
- **Duration**: 4 weeks
- **Status**: Draft

Epic C designs and implements the six v1 API hooks, their Rust traits, their TypeScript mirror types, and their versioning scheme. It also produces the three example plugins that serve as both regression fixtures and developer onboarding material.

---

## 1. Goal

Ship the v1 plugin API — narrow, typed, documented — and prove it works by building three real plugins on top of it.

By end of epic:

- Six API surfaces wired from plugin → host → UI (where relevant).
- Rust host-side dispatch for each surface.
- TS mirror types under `@quanta/plugin-api` with parity tests.
- Three example plugins pass their scenario tests.
- Plugin API v1 is declared **frozen**; post-freeze changes require an RFC amendment and a major bump.

---

## 2. Non-goals

- Capability tokens / permission UI (Epic D) — but the dispatch code already plumbs tokens through.
- Bundle format / signing (Epic E).
- Settings "Plugins" tab rendering (Epic F).
- The seventh+ surfaces beyond the v1 six; any new surface is a v1.1 minor feature, not in this epic.

---

## 3. Design principles (revisited)

1. **Narrow over broad.** No `host.call("anything")` escape hatch.
2. **Typed.** Both sides see strongly typed arguments. No string-typed dispatch.
3. **Async.** Every hook is async on the TS side; Rust plugins use their own runtime (most likely sync with bounded work, since fuel forbids long blocking).
4. **Best-effort.** Hooks are advisory. A slow or failing plugin does not block the user's workflow; the host moves on after the budget.
5. **Pure inputs / data outputs.** Hooks do not perform side-effects directly; they return data the host acts on (e.g. `onCommandSubmit` *returns* a rewrite; it doesn't *submit* anything).
6. **Deterministic fan-out.** Multiple plugins on the same hook run in manifest declaration order (stable across restarts); each sees the previous plugin's output.

---

## 4. The six surfaces

### 4.1 `session.onCommandSubmit`

**When**: before the user's command hits the shell.

**Use cases**: CLI auto-complete, command expansion, dry-run safety check, audit.

**TS signature**:

```ts
export interface CommandSubmitEvent {
  readonly command: string;
  readonly sessionId: string;
  readonly shell: "bash" | "zsh" | "fish" | "pwsh" | "unknown";
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;  // filtered; see §4.1.3
  readonly userTypedAt: number;                     // epoch ms
}

export interface CommandSubmitResult {
  rewrite?: string;
  annotations?: ReadonlyArray<BlockAnnotation>;
  cancel?: boolean;
  warnings?: ReadonlyArray<string>;
}

export type CommandSubmitHandler =
  (ev: CommandSubmitEvent) => Promise<CommandSubmitResult>;
```

**Rust signature**:

```rust
pub trait CommandSubmitHandler: Send + Sync {
    fn handle(
        &self,
        token: &CapabilityToken,
        ev: &CommandSubmitEvent,
    ) -> Result<CommandSubmitResult, PluginError>;
}
```

#### 4.1.1 Fan-out order

The host iterates plugins in declaration order. Each plugin receives the event with the previous plugin's `rewrite` applied (if any). If a plugin returns `cancel: true`, downstream plugins are skipped.

#### 4.1.2 Budgeting

- Per-plugin budget: 20 ms.
- Aggregate budget across all plugins: 50 ms.
- Over budget: remaining plugins are skipped, a warning is logged, the command proceeds as-is (or as-last-rewritten).

#### 4.1.3 Env filtering

Not every env var is exposed. Plugins see a whitelist: `PATH`, `HOME`, `USER`, `SHELL`, `LANG`, `LC_*`, `TERM`, `PWD`. Secrets (anything named `*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASS*`, or matching the platform keychain environment) are redacted. The whitelist is tunable in Settings.

#### 4.1.4 Breadcrumb UI

If `rewrite` differs from the original, the resulting block shows a "Modified by plugin X" breadcrumb. Clicking it shows a diff between original and rewrite. This is load-bearing for user trust: if a plugin changes my command, I need to see it.

### 4.2 `block.onRender`

**When**: block enters the render pipeline (initial render + on each substantive state change: started → running → finished).

**Use cases**: syntax highlighting, status icons, inline panels.

**TS signature**:

```ts
export interface BlockRenderEvent {
  readonly blockId: string;
  readonly command: string;
  readonly exitCode: number | null;
  readonly stdoutPreview: string;
  readonly stderrPreview: string;
  readonly durationMs: number;
  readonly shell: string;
  readonly phase: "started" | "running" | "finished";
}

export type UiFragment =
  | { kind: "badge"; text: string; color: "info"|"warn"|"error"|"ok"; position?: "left"|"right" }
  | { kind: "inlineIcon"; svg: string; tooltip: string }
  | { kind: "decoratedLines"; ranges: LineRange[] }
  | { kind: "richPanel"; html: string; maxHeight?: number };

export interface LineRange {
  startLine: number;
  endLine: number;
  style: LineStyle;
}

export interface LineStyle {
  background?: string;    // CSS color, normalised by host
  textDecoration?: "underline"|"strikethrough"|"none";
  iconSvg?: string;
}
```

**Rust signature**: mirrors via Cap'n Proto.

#### 4.2.1 HTML sanitiser

`richPanel` HTML is passed through a strict allow-list sanitiser:

- Allowed tags: `span`, `b`, `i`, `em`, `strong`, `code`, `pre`, `a`, `br`, `ul`, `ol`, `li`, `div`.
- Allowed attrs: `class`, `href` (must start with `https://`, `mailto:`, or `command:plugin/<id>/<action>`), `title`.
- Anchors get `rel="noopener noreferrer"` injected.
- Inline `style` is stripped.
- `<script>`, `<iframe>`, `<object>`, event handlers (`onclick=...`) are stripped.
- Max HTML size per panel: 32 KiB.

If sanitisation strips *any* token, the fragment is still rendered but a warning is logged to the plugin's audit file.

#### 4.2.2 Budgeting

- 16 ms per plugin per block event.
- If a plugin regularly exceeds, strike counter (Epic B) eventually auto-disables.

### 4.3 `palette.register`

**When**: plugin's `activate()` phase. Palette entries are static per plugin lifetime; dynamic reloads (e.g. context lists) happen by the entry's `invoke` popping a sub-palette.

**TS signature**:

```ts
export interface PaletteEntry {
  id: string;                // plugin-scoped; full id is <plugin.id>/<entry.id>
  title: string;
  subtitle?: string;
  keywords?: string[];
  icon?: string;             // relative path into bundle
  invoke: (ctx: PaletteContext) => Promise<void>;
}

export interface PaletteContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly currentBlockId?: string;
  showList<T>(items: Array<{id: string; label: string; sublabel?: string; value: T}>): Promise<{id: string; value: T} | undefined>;
  showInput(prompt: string, opts?: { placeholder?: string; secret?: boolean }): Promise<string | undefined>;
  showConfirm(message: string): Promise<boolean>;
  notify(msg: string, level: "info"|"warn"|"error"|"ok"): void;
}
```

Entries are rendered in the main palette with a `[plugin]` badge next to the title. Users can hide plugin entries or filter by plugin from palette settings.

### 4.4 `diagnostic.onOutput`

**When**: per output line from a running block (rate-limited; coalesced in 50-line batches).

**Use cases**: tsc / eslint output parsers, test-failure highlighters, CI log annotation.

**TS signature**:

```ts
export interface OutputBatchEvent {
  readonly blockId: string;
  readonly lines: ReadonlyArray<{ lineNumber: number; text: string; stream: "stdout" | "stderr" }>;
}

export interface Diagnostic {
  lineNumber: number;
  range: { start: number; end: number };
  severity: "info" | "warn" | "error";
  message: string;
  code?: string;
  quickFixes?: Array<{ title: string; paletteEntry: string }>;  // references plugin's own palette entry
}

export type DiagnosticHandler =
  (batch: OutputBatchEvent) => Promise<Diagnostic[]>;
```

#### 4.4.1 Rate limiting

- Plugins receive at most 200 batches / sec.
- Per batch: up to 50 lines.
- Over the limit: batches coalesce into "skipped N lines" markers.

#### 4.4.2 UI

Diagnostics render as squiggles in the block's output area; hover shows the message; clicking opens the quick-fix menu, which invokes the plugin's palette entry.

### 4.5 `ai.onSuggest`

**When**: user asks for an AI suggestion (Composer AI button, inline "explain this error", etc.).

**TS signature**:

```ts
export interface AiSuggestEvent {
  readonly prompt: string;
  readonly context: ReadonlyArray<AiMessage>;
  readonly hints: {
    cwd: string;
    recentCommands: ReadonlyArray<string>;
    shell: string;
  };
  readonly requestedMode: "command" | "explanation" | "refactor";
}

export interface AiSuggestion {
  text: string;
  explanation?: string;
  confidence: number;              // 0..1
  providerName: string;
  citations?: Array<{ url: string; title: string }>;
}

export type AiSuggestHandler = (ev: AiSuggestEvent) => Promise<AiSuggestion>;
```

#### 4.5.1 Provider selection

Only one AI plugin can be the **active** provider at a time. The user selects from Settings → AI → Provider. If no plugin is active, Quanta's first-party AI (or none) is used.

A plugin that wants to provide *supplementary* suggestions (not replace the primary) would use `palette.register` for a "Get suggestion from X" entry, not this hook.

#### 4.5.2 Timeout

- 10 s end-to-end. Over budget: UI shows "suggestion timed out"; the plugin is audited but not penalised (network latency is expected).

### 4.6 `settings.schema`

**When**: plugin load; the host reads the schema and renders a settings panel in the Plugins tab.

**TS signature**:

```ts
export type SettingField =
  | { id: string; type: "string"; label: string; default?: string; placeholder?: string; multiline?: boolean }
  | { id: string; type: "number"; label: string; default?: number; min?: number; max?: number; step?: number }
  | { id: string; type: "boolean"; label: string; default?: boolean }
  | { id: string; type: "enum"; label: string; options: string[]; default?: string }
  | { id: string; type: "secret"; label: string };

export interface SettingsSchema {
  groups: Array<{
    id: string;
    title: string;
    description?: string;
    fields: SettingField[];
  }>;
}
```

Values are stored at `plugin.<plugin.id>.<field.id>`. `secret` fields go to the OS keychain and are referenced by handle from the plugin side (`host.storage.getSecret(handle)`).

---

## 5. TS SDK surface (`@quanta/plugin-api`)

### 5.1 Entry

```ts
import { definePlugin } from "@quanta/plugin-api";

export default definePlugin({
  id: "com.example.my-plugin",
  async activate(host) {
    host.session.onCommandSubmit(async (ev) => { /* … */ return {}; });
    host.block.onRender(async (ev) => { /* … */ return []; });
    host.palette.register({ /* … */ });
  },
  async deactivate() { /* cleanup */ },
});
```

### 5.2 `HostBridge`

The `host` object inside `activate` exposes namespaces:

- `host.session` — `onCommandSubmit(handler)`.
- `host.block` — `onRender(handler)`.
- `host.palette` — `register(entry)`, `showList`, `showInput`, `showConfirm`.
- `host.diagnostic` — `onOutput(handler)`.
- `host.ai` — `onSuggest(handler)`.
- `host.settings` — `schema(spec)`.
- `host.fs` — `readText`, `readBytes`, `writeText`, `writeBytes` (permission-gated).
- `host.exec` — `spawn(argv, opts)` (permission-gated).
- `host.net` — `fetch(url, init)` (permission-gated).
- `host.clipboard` — `read`, `write` (permission-gated).
- `host.storage` — `get`, `set`, `delete`, `getSecret`, `setSecret`.
- `host.notify` — push toast.
- `host.log` — `info`, `warn`, `error` (rate-limited).

### 5.3 Error types

```ts
export class PluginError extends Error { readonly code: PluginErrorCode; }
export type PluginErrorCode =
  | "PermissionDenied"
  | "RateLimited"
  | "Timeout"
  | "InvalidArgument"
  | "HostBusy"
  | "NotFound";
```

---

## 6. Rust SDK surface (`quanta-plugin-sdk`)

A thin crate shipped alongside the host for Rust plugin authors. Wraps the Cap'n Proto ABI into ergonomic handlers.

```rust
use quanta_plugin_sdk::{plugin, Host, CommandSubmitResult};

#[plugin(id = "com.example.my-plugin")]
struct MyPlugin;

impl MyPlugin {
    fn activate(host: &Host) -> anyhow::Result<()> {
        host.session().on_command_submit(|ev| {
            if ev.command.starts_with("kubectl") {
                Ok(CommandSubmitResult::annotate("badge:kube"))
            } else {
                Ok(CommandSubmitResult::default())
            }
        });
        Ok(())
    }
}
```

Macros generate the Cap'n Proto boilerplate and the WASM exports.

---

## 7. Example plugins

Three plugins ship end-to-end as part of this epic. Each has its own directory under `examples/plugins/`:

### 7.1 `kubectl-contexts`

- **Permissions**: `filesystem_read: ~/.kube/config`, `execute_commands: kubectl`, `settings_storage`.
- **Hooks**: `palette.register` (Switch context…, Show current context), `session.onCommandSubmit` (append badge if cmd starts with `kubectl`).
- **Settings**: favourite contexts list.
- **Acceptance**: user can switch kube context without typing the command; current context always visible next to `kubectl` commands.

### 7.2 `aws-cli-autocomplete`

- **Permissions**: `filesystem_read: ~/.aws/*`, `execute_commands: aws`, `network: https://sts.amazonaws.com`, `settings_storage`.
- **Hooks**: `session.onCommandSubmit` (completion + default-region injection), `palette.register` (AWS profile switcher).
- **Settings**: default profile, caching TTL, regions to prefer.
- **Acceptance**: typing `aws s3 cp f b` rewrites to `aws s3 cp <file> s3://<bucket>/<key>` using cached listings.

### 7.3 `gitlab-ci-log-highlighter`

- **Permissions**: `settings_storage` only.
- **Hooks**: `block.onRender` (badges per CI step), `diagnostic.onOutput` (parse errors on lines like `ERROR: Job failed: exit code 1`).
- **Settings**: toggle per-step colouring; custom regex rules.
- **Acceptance**: a GitLab CI job log gets step badges and error diagnostics without any setup beyond install.

Each example ships with its own scenario tests that exercise its hooks end-to-end.

---

## 8. Versioning scheme (detail)

### 8.1 Version declaration

Plugins declare `api_version` in the manifest. The host maintains a compatibility table:

| Host version | Supported API majors |
| --- | --- |
| 1.6.x | 1.x |
| 2.0.x | 1.x (deprecated), 2.x |
| 2.1.x | 1.x (deprecated), 2.x |
| 3.0.x | 2.x, 3.x |

The deprecation window for a major is **one full Quanta host major cycle** (≈ 6 months). A plugin on a retired major refuses to load; the Plugins tab shows a "retired API" banner.

### 8.2 Surface stability

Each surface is marked in the docs as:

- **stable** — no changes allowed within a major; new optional fields allowed as minor.
- **experimental** — may change in a minor. Plugins opting in declare `"api_version": "1.x-experimental"` (explicit suffix). v1 ships *no* experimental surfaces; all six are stable.

### 8.3 Minor-feature pattern

Adding a new surface `foo.onBar` in v1.1:

1. Add the import.
2. Plugins declaring `api_version: "1.x"` ignore the new surface unless they register for it.
3. Ship docs and a `since: 1.1` marker in the reference.

Removing a field in a minor is forbidden. Making a field optional is allowed (backwards compatible).

### 8.4 Major-bump pattern

Hypothetical v2 redesign of `block.onRender` (splitting to `onMount` + `onUpdate`):

1. Add new surface names (`block.onMount`, `block.onUpdate`) alongside the old ones.
2. Host dispatches to new or old based on plugin's declared `api_version`.
3. Old surfaces marked deprecated; lint warning in `quanta-plugin validate` when a 2.x plugin uses them.
4. After deprecation window, old surfaces removed; plugins declaring `1.x` no longer load.

---

## 9. Testing strategy

### 9.1 Parity tests

A single set of fixture events is run through:

- Rust host dispatch.
- TS SDK dispatch (through the UI-side worker, mocked or real).
- The result structures must be byte-identical after round-trip.

### 9.2 Per-surface tests

Each surface has:

- **Schema test** — every field of the Cap'n Proto and TS types is exercised.
- **Fan-out test** — N plugins on the same hook produce the expected composed result.
- **Budget test** — slow plugin is skipped; remaining plugins see correct state.
- **Error test** — plugin throws; host records audit and moves on.

### 9.3 Example-plugin tests

End-to-end scenarios live under `examples/plugins/<name>/tests/`:

- kubectl-contexts: mock `~/.kube/config` with three contexts, assert palette shows three entries, invoke one, assert exec was called correctly.
- aws-cli-autocomplete: mock S3 listings, type a partial command, assert rewrite.
- gitlab-ci-log-highlighter: feed a known log fixture, assert badges and diagnostics.

### 9.4 Snapshot tests

UI fragments are snapshot-tested: given an input event, the fragment list is stable across runs.

---

## 10. Work breakdown

### Sprint 1 (week 1)

- **C-1.1** Cap'n Proto schema definitions for all six surfaces.
- **C-1.2** Rust host-side dispatcher per surface (wiring through Epic B imports).
- **C-1.3** TS SDK skeleton (`@quanta/plugin-api`).
- **C-1.4** TS → WASM worker bridge for UI-side plugins.
- **C-1.5** Session.onCommandSubmit end-to-end (wire into Composer).

### Sprint 2 (week 2)

- **C-2.1** Block.onRender end-to-end (wire into Block Log).
- **C-2.2** HTML sanitiser + tests.
- **C-2.3** Palette.register end-to-end (wire into Palette).
- **C-2.4** Breadcrumb UI for rewritten commands.

### Sprint 3 (week 3)

- **C-3.1** Diagnostic.onOutput (output-stream subscription + rate limiter).
- **C-3.2** Ai.onSuggest + Settings provider-picker.
- **C-3.3** Settings.schema end-to-end (renders under plugin panel).
- **C-3.4** Versioning table + host compatibility checks (wires to Epic A's api_version grammar).

### Sprint 4 (week 4)

- **C-4.1** kubectl-contexts example plugin.
- **C-4.2** aws-cli-autocomplete example plugin.
- **C-4.3** gitlab-ci-log-highlighter example plugin.
- **C-4.4** Scenario tests for each.
- **C-4.5** Parity test harness.
- **C-4.6** Docs pass: reference + tutorial per surface.
- **C-4.7** API v1 freeze declaration: sign-off from platform + security.

---

## 11. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| v1 API surfaces are too narrow; plugin authors request escape hatches | Budget for a v1.1 in the release plan; collect requests during beta; evaluate each as a new narrow surface (no generic escape). |
| Surfaces are too broad, invite abuse | Threat-model each surface during design review; restrict where in doubt; broaden later (easy) rather than narrow later (hard). |
| TS ↔ Rust type drift | Single Cap'n Proto schema; CI parity test. |
| Example plugins "cheat" by using host internals | Example plugins use only the public SDK; enforced by lint rule. |
| Block.onRender fires too often and burns budget | Coalesce events per 50 ms per block; plugins that want per-byte granularity use `diagnostic.onOutput`. |

---

## 12. Acceptance criteria

- [ ] All six surfaces implemented host-side and in the TS SDK.
- [ ] Parity tests green.
- [ ] Three example plugins ship and pass scenario tests.
- [ ] Budget / fan-out / error semantics documented and tested.
- [ ] HTML sanitiser passes XSS fuzz suite.
- [ ] v1 API frozen (RFC amendment required for any change).
- [ ] Versioning / deprecation logic shipped and tested (with a synthetic "v0.9" plugin for the rejection path).

---

## 13. Change history

| Date | Author | Change |
| --- | --- | --- |
| 2026-04-20 | Platform Team | Initial epic plan. |

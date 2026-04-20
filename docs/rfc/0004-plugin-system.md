# RFC 0004 — Plugin / Extension System

- **Status**: Draft
- **Author**: Quanta Platform Team
- **Created**: 2026-04-20
- **Target release**: Quanta 1.6
- **Supersedes**: —
- **Related**:
  - RFC 0001 — Custom VT Engine (xterm.js removal)
  - RFC 0002 — WebGL Renderer
  - RFC 0003 — Inline Images
  - RFC 0004.1 (future) — Plugin Marketplace Hosting
- **Companion plan**: `docs/plans/0004-plugin-system/`

---

## 1. Summary

Quanta terminal today ships a fixed feature set: a custom VT engine, a cell grid renderer, a Composer, a Command Palette, a built-in AI provider, and a small collection of first-party block decorators. This set works for the eighty-percent case but cannot possibly serve every workflow that a terminal user encounters. Kubernetes operators want live context indicators on the prompt. AWS engineers want `aws s3 cp` auto-complete that actually understands their buckets. GitLab CI users want a log highlighter that understands job-specific ANSI conventions. Company-internal tooling — compliance banners, SSO helpers, proprietary shell wrappers — cannot ship upstream and must run out-of-tree.

RFC 0004 proposes a **third-party plugin system** modelled on the broad shape of VS Code extensions, but adapted to the terminal context. Plugins are **sandboxed** (WASM on the Rust side, Web Workers on the UI side), **capability-gated** (every privileged action requires an explicit user grant), and **versioned** (the plugin API surface is semver-frozen). Plugins extend Quanta through a small, narrow set of API hooks; they cannot modify VT semantics, swap the renderer, or touch the GPU.

This RFC defines: the manifest format, the runtime host, the API hooks, the permissions model, the distribution format, and the UI for plugin management. A companion epic plan (six epics, A–F) breaks the work into implementation-sized chunks.

---

## 2. Motivation

### 2.1 The "long tail" problem

A terminal is a general-purpose tool. Its users span:

- shell-scripting sysadmins who want cross-shell prompt enhancers;
- cloud operators who live inside `kubectl`, `gcloud`, `az`, and `aws`;
- data engineers who wrangle Snowflake, BigQuery, dbt, and Airflow CLIs;
- backend developers who juggle `docker`, `psql`, `redis-cli`, `mysql`, `rails console`;
- SREs who tail logs through `journalctl`, `stern`, `kubectl logs`, and pipe everything into `jq`;
- security engineers who want audit-log interception;
- enterprise users with bespoke internal CLIs that will never be upstreamed.

Any first-party feature set satisfies perhaps twenty percent of the long tail. The remaining eighty percent of niche workflows will *never* ship in Quanta core — either because they are too specialised, too company-specific, too legally entangled, or simply not worth the maintenance cost to the core team. But these workflows *matter* to the users who have them. Without an extension system those users fork Quanta, stop upgrading, or leave.

### 2.2 Proof points from adjacent ecosystems

- **VS Code**: over 50 000 extensions; the marketplace is widely credited as the decisive feature that moved the centre of gravity away from Sublime Text and Atom.
- **Vim / Neovim**: 30+ years of plugin ecosystem; plugins ship features that would never have landed in core.
- **Warp / Hyper / iTerm**: each has attempted some form of extensibility. Hyper has HTML/JS plugins (insecure; killed by electron DOM exposure). Warp recently opened a workflow API. iTerm has trigger scripts but no runtime plugin surface. None has a capability-gated, sandboxed, signed plugin system.
- **Browsers**: WebExtensions API proves that a narrow, permissioned, versioned surface can host a huge third-party ecosystem without becoming a security disaster (mostly).

Quanta should learn from all of these. Specifically: from the browser we take the **permission prompt**. From VS Code we take the **narrow, versioned API**. From Hyper we take the **anti-pattern to avoid** — never expose the DOM; always go through a message bus.

### 2.3 Strategic value

A working plugin system:

1. **Expands TAM**: users whose workflows are not covered by core can still adopt Quanta.
2. **Offloads feature pressure**: "please add built-in support for X" becomes "someone can write a plugin for X".
3. **Creates a moat**: an ecosystem of plugins is harder to replicate than a feature list.
4. **Generates telemetry**: which plugins get installed tells the core team where to invest.
5. **Enables enterprise**: companies can ship internal-only plugins via private distribution without any core-team involvement.

---

## 3. Non-goals

RFC 0004 explicitly does **not** do any of the following. Each non-goal is listed with its rationale so future RFCs know what would need to change to unblock it.

1. **Arbitrary native code execution.** No `.dylib` / `.so` / `.dll` loading. Native plugins can trivially escape any sandbox and execute anything the Quanta process can; the blast radius is unacceptable for an application that routinely runs with user-level filesystem access and shell spawn privileges. Native code remains off-limits for v1 and v2. Re-evaluate only if a production-grade, OS-backed process sandbox (e.g. macOS App Sandbox entitlements per child process) is available on every supported platform.
2. **Deep VT semantics modification.** Plugins cannot change how the parser interprets CSI sequences, cannot re-define SGR codes, cannot override OSC handlers, cannot install custom DCS state machines. VT conformance is load-bearing: every program that writes to the terminal relies on standard behaviour, and a single rogue plugin breaking ECH would corrupt every session running in that window. VT modification lives in the core crate (`quanta-vt`) and stays there.
3. **GPU-level render hooks.** Plugins cannot supply WGSL shaders, cannot register custom framebuffer passes, cannot write to the WebGL/WebGPU context. The renderer is performance-critical and shares GPU resources across all sessions. Block-level *decorations* (icons, badges, inline UI fragments produced in a sandboxed worker) are fine; raw GPU access is not. Re-evaluate if WebGPU offers a restricted "compute-only" child context per plugin, but that is not available in web workers today.
4. **Arbitrary DOM access from JS plugins.** Hyper's plugin model gave plugins full DOM access; this led to both supply-chain attacks (a compromised plugin could read every keystroke) and performance catastrophes (plugins could mutate any element and invalidate the renderer). Quanta's UI-side plugin runtime is a **Web Worker** with `postMessage` to the main thread. No DOM. No `window`. No `document`. Decorations are rendered by the host; plugins emit data structures describing what to render.
5. **Cross-plugin dependencies / composition.** Plugin A cannot `require` plugin B. There is no shared plugin module system, no NPM-style resolution, no plugin-to-plugin RPC. Each plugin is standalone. This avoids diamond-dependency hell and makes uninstall deterministic. A plugin that wants a library bundles it in.
6. **Runtime code generation / eval.** WASM modules are loaded once from the signed bundle. There is no `eval()`, no dynamic `import()` of arbitrary URLs, no "download more code on first run" pattern. Everything that runs must be in the signed artifact. This is critical for the audit story.
7. **Replacing the Composer, the Palette, or the Block Log.** These are core UX surfaces. Plugins can *inject* palette entries, *decorate* blocks, and *transform* commands before submit — but cannot replace the components themselves.
8. **A marketplace in v1.** v1 ships local-file install only. The marketplace (discovery, hosting, moderation, payments, revenue share) is a large, separate problem, tracked in RFC 0004.1.

---

## 4. Glossary

| Term | Meaning |
| --- | --- |
| **Plugin** | A third-party extension distributed as a signed `.quanta-plugin` bundle, containing a manifest, one or more code modules (WASM and/or JS), and a signature. |
| **Plugin host** | The Rust process that loads WASM plugins, enforces resource limits, and bridges them to Quanta internals. Lives in `crates/quanta-plugin-host`. |
| **Plugin worker** | The Web Worker that loads UI-side JS plugins and exchanges messages with the renderer main thread. |
| **Manifest** | The `plugin.json` file at the root of the bundle; declares identity, version, permissions, API surfaces consumed. |
| **API surface** | A single, versioned hook (e.g. `session.onCommandSubmit`) that plugins may register for. |
| **Capability token** | A per-API-surface grant token issued by the host at plugin-load time, based on the manifest and the user's permission decision. Every privileged call must present a valid token. |
| **Audit log** | A per-plugin append-only log of every privileged action, stored under `$APP_CONFIG_DIR/plugin-audit/<plugin_id>.log`. |
| **Host** | The running Quanta process, viewed from the plugin's perspective. |
| **Hostile plugin** | A plugin authored in bad faith — tries to exfiltrate data, escalate privilege, crash the host, or corrupt state. The security model must defeat this. |
| **API version** | Semver string declared in the manifest (`api_version: "1.x"`). Major-version mismatch causes the host to refuse to load the plugin. |

---

## 5. Architecture overview

```
                              ┌──────────────────────────────────────┐
                              │           Quanta UI (renderer)       │
                              │  ┌───────────┐    ┌──────────────┐   │
                              │  │ Composer  │    │  Block Log   │   │
                              │  └─────┬─────┘    └──────┬───────┘   │
                              │        │                 │            │
                              │        ▼                 ▼            │
                              │  ┌────────────────────────────────┐   │
                              │  │   Plugin Bridge (main thread)  │   │
                              │  └────────────┬───────────────────┘   │
                              │               │ postMessage           │
                              │               ▼                        │
                              │  ┌────────────────────────────────┐   │
                              │  │   Plugin Worker (JS sandbox)   │   │
                              │  │  loads UI-side plugin modules  │   │
                              │  └────────────────────────────────┘   │
                              └──────────────────┬───────────────────┘
                                                 │ IPC (versioned RPC)
                                                 ▼
                              ┌──────────────────────────────────────┐
                              │         Quanta Core (Rust)           │
                              │  ┌──────────────────────────────────┐│
                              │  │       Plugin Host (wasmtime)     ││
                              │  │  ┌────────┐  ┌────────┐  ┌─────┐ ││
                              │  │  │ WASM 1 │  │ WASM 2 │  │ ... │ ││
                              │  │  └────────┘  └────────┘  └─────┘ ││
                              │  └────────────┬─────────────────────┘│
                              │               │ capability-gated     │
                              │               ▼                      │
                              │  ┌──────────────────────────────────┐│
                              │  │  Session / VT / Command Engine   ││
                              │  └──────────────────────────────────┘│
                              └──────────────────────────────────────┘
```

Key design choices:

1. **Two runtimes, one model.** UI-side plugins live in Web Workers; Rust-side plugins live in wasmtime. Both present the same conceptual API surface; they differ in which hooks they can register for. A plugin manifest can declare *both* a UI entrypoint and a host entrypoint.
2. **Capability-gated IPC everywhere.** There is no shared memory between plugin and host (except the WASM linear memory that is local to the plugin). All communication is through a versioned RPC. Every call presents a capability token that the host validates against the permission grant.
3. **No ambient authority.** A plugin cannot "just do" network requests, filesystem reads, or clipboard access. It asks the host. The host checks permissions. The host performs the action. The host returns the result.
4. **Narrow surfaces, not broad ones.** We ship six API surfaces at v1 (see §6.4). Every surface is specific, documented, and version-locked. We do *not* ship a generic "do anything" escape hatch.

---

## 6. Detailed design

### 6.1 Plugin manifest (`plugin.json`)

Every plugin bundle contains a top-level `plugin.json` file. The full schema is the subject of **Epic A**; what follows is the summary.

Minimum fields:

```json
{
  "manifest_version": 1,
  "id": "com.example.kubectl-contexts",
  "name": "Kubectl Context Switcher",
  "version": "0.1.0",
  "api_version": "1.x",
  "author": {
    "name": "Jane Smith",
    "email": "jane@example.com",
    "url": "https://example.com"
  },
  "license": "MIT",
  "description": "Displays current kube context on the prompt and lets you switch via palette.",
  "icon": "icon.png",
  "entrypoints": {
    "host": "plugin.wasm",
    "ui": "ui.js"
  },
  "api_surfaces": [
    "palette.register",
    "block.onRender",
    "session.onCommandSubmit"
  ],
  "permissions": {
    "execute_commands": {
      "reason": "Run `kubectl config use-context <ctx>` when user picks one.",
      "allowlist": ["kubectl"]
    },
    "filesystem_read": {
      "reason": "Read ~/.kube/config to list contexts.",
      "paths": ["~/.kube/config"]
    },
    "settings_storage": {
      "reason": "Persist the user's favourite contexts."
    }
  },
  "signature": "…base64…"
}
```

Notes:

- `id` is a reverse-DNS identifier and is the primary key for install, update, audit-log filename, settings namespace. It cannot change across versions.
- `api_version` is a semver range of the Plugin API the plugin understands. The host rejects a plugin whose major does not match any host-supported major.
- `permissions` is a map from category → reason-string + optional scoping (allowlist of command names, filesystem paths, URL patterns). The reason is shown to the user at the permission-prompt step. No permission can be requested without a reason; the manifest validator rejects empty reasons.
- `signature` is a base64 Ed25519 signature over a canonical serialization of the manifest plus the other bundle artifacts. See §6.7.
- `entrypoints` may be partial: a plugin that only provides palette entries may only ship a `ui.js`; a plugin that only transforms commands may only ship a `plugin.wasm`.

### 6.2 Bundle format (`.quanta-plugin`)

The distributable artifact is a gzipped tar named `<id>-<version>.quanta-plugin`. Contents:

```
plugin.json
plugin.wasm        (optional)
ui.js              (optional, bundled ES module, no import() of external URLs)
assets/
  icon.png
  locales/
    en.json
    ...
LICENSE
```

A trailing `signature.sig` file contains the signature bytes over the canonical digest of all other files (excluding `signature.sig` itself). The CLI computes and embeds this at `quanta-plugin publish` time.

Install-time verification:

1. Verify bundle integrity (tar well-formed, no path traversal, no symlinks, size under limit).
2. Compute canonical digest.
3. Verify signature.
4. Parse and validate `plugin.json`.
5. Show permission prompt to user.
6. On accept: unpack to `$APP_CONFIG_DIR/plugins/<id>/` and record in the plugin registry.
7. On reject: delete the bundle, record a "declined" entry in telemetry (local only).

### 6.3 Runtime host

#### 6.3.1 Rust side — wasmtime

Implemented in `crates/quanta-plugin-host`. Responsibilities:

- Load `plugin.wasm` into a fresh `wasmtime::Store` per plugin.
- Enforce memory limit (default 64 MiB, configurable per plugin class up to 256 MiB).
- Enforce CPU fuel limit (default 10 ms per call). Fuel is refilled at call entry; running out traps the plugin.
- Provide a WASI preview 1 subset — just `fd_write` to captured stdout/stderr (for plugin logging; not routed to the terminal output stream).
- Expose the host API as imported functions; every import checks capability tokens.
- On plugin crash / trap / out-of-fuel: log, disable the plugin, show a user notification ("Plugin X crashed and has been disabled").
- On config change / revoke: drop the Store; tokens become invalid because the plugin process is gone.

#### 6.3.2 UI side — Web Worker

Implemented in `packages/ui/src/features/plugin-worker/`. Responsibilities:

- Spawn one Web Worker per enabled UI-side plugin (for v1; an optimisation to pool plugins into one worker is tracked as a follow-up).
- The worker loads `ui.js` as an ES module.
- The worker has no `window`, no `document`, no `fetch` (host-mediated), no `XMLHttpRequest`, no `WebSocket` (host-mediated).
- The worker communicates with the main thread via `postMessage` using a structured, versioned envelope:

  ```ts
  type PluginEnvelope =
    | { type: "call"; id: string; method: string; args: unknown }
    | { type: "result"; id: string; value: unknown }
    | { type: "error"; id: string; code: string; message: string }
    | { type: "event"; topic: string; payload: unknown };
  ```
- The main thread's Plugin Bridge routes `call` envelopes to the appropriate host-side handler, checks capability, and replies with `result` / `error`. `event` envelopes are unidirectional host → plugin.

#### 6.3.3 Resource limits

| Limit | UI-side default | Host-side default | Hard cap |
| --- | --- | --- | --- |
| Memory | 32 MiB | 64 MiB | 256 MiB |
| CPU per call | 16 ms | 10 ms | 100 ms |
| Total event bus msgs / sec | 200 | 200 | 1 000 |
| Concurrent outstanding calls | 16 | 16 | 64 |
| Logging rate | 50 lines / sec | 50 lines / sec | 500 / sec |

Limits are enforced before the plugin does any work; a misbehaving plugin is de-prioritised, then disabled if it keeps hitting ceilings.

### 6.4 API surfaces (v1)

Six surfaces ship in v1. Each is narrow, specific, and frozen.

#### 6.4.1 `session.onCommandSubmit(cmd) → cmd'`

Fires when the user submits a command from the Composer, before the shell receives it. The plugin returns a (possibly modified) command or a structured annotation.

```ts
interface CommandSubmitEvent {
  readonly command: string;
  readonly sessionId: string;
  readonly shell: "bash" | "zsh" | "fish" | "pwsh" | "unknown";
  readonly cwd: string;
}

interface CommandSubmitResult {
  // If present, the command is replaced with this.
  rewrite?: string;
  // Annotations attached to the block that the submit creates.
  annotations?: ReadonlyArray<BlockAnnotation>;
  // If true, the submit is cancelled.
  cancel?: boolean;
  // If non-empty, shown as an inline warning.
  warnings?: ReadonlyArray<string>;
}
```

Semantics:

- Plugins run in manifest-declaration order; the output of one plugin is the input to the next. Order is stable across restarts.
- If any plugin sets `cancel: true`, downstream plugins are not called and the submit is aborted (with a visible reason).
- `rewrite` is shown to the user in a "this command was modified by plugin X" breadcrumb; the user can click to see the diff.
- Total budget across all plugins is capped at 50 ms; beyond that the remaining plugins are skipped and a warning is logged.

Example use: aws-cli-autocomplete expands `aws s3 cp f b` into `aws s3 cp ./file s3://bucket/key` with the completions fetched from `~/.aws/credentials`.

#### 6.4.2 `block.onRender(block) → uiFragments[]`

Fires when a new block enters the render pipeline. The plugin returns a list of UI fragments to attach.

```ts
interface BlockRenderEvent {
  readonly blockId: string;
  readonly command: string;
  readonly exitCode: number | null;  // null while still running
  readonly stdoutPreview: string;    // first 4 KiB; full stream via subscription
  readonly durationMs: number;
  readonly shell: string;
}

type UiFragment =
  | { kind: "badge"; text: string; color: "info"|"warn"|"error"|"ok" }
  | { kind: "inlineIcon"; svg: string; tooltip: string }
  | { kind: "decoratedLines"; ranges: Array<{startLine:number; endLine:number; style:LineStyle}> }
  | { kind: "richPanel"; html: string /* sanitized by host */ };
```

The host sanitises any `html` fragment through a strict allow-list (tags: `<span>`, `<b>`, `<i>`, `<code>`, `<pre>`, `<a href>`; attributes: `class`, `href`; anchors force `rel="noopener"`). No `<script>`, no inline event handlers, no URLs with `javascript:`.

Example use: gitlab-ci-log-highlighter colours lines matching CI step markers and attaches a badge showing the current step.

#### 6.4.3 `palette.register(command)`

Allows plugins to add entries to the Command Palette.

```ts
interface PaletteEntry {
  id: string;                    // namespaced under plugin.id
  title: string;
  subtitle?: string;
  keywords?: string[];
  icon?: string;                 // asset path inside the bundle
  invoke: (ctx: PaletteContext) => Promise<void>;
}
```

Entries appear with a small plugin badge so the user can tell core entries from plugin entries. The host deduplicates by `id`; collisions are rejected at registration time.

Example use: kubectl-contexts registers "Switch kube context…" which opens a second palette listing contexts parsed from `~/.kube/config`.

#### 6.4.4 `diagnostic.onOutput(line) → diagnostics[]`

Fires per output line (rate-limited; see §6.3.3). The plugin returns diagnostics attached to specific character ranges.

```ts
interface OutputLineEvent {
  readonly blockId: string;
  readonly lineNumber: number;
  readonly text: string;
  readonly stream: "stdout" | "stderr";
}

interface Diagnostic {
  range: { start: number; end: number };
  severity: "info" | "warn" | "error";
  message: string;
  code?: string;     // plugin-scoped error code
  quickFixes?: Array<{ title: string; action: string /* opaque to host */ }>;
}
```

Diagnostics render as inline squiggles with a hover card. Quick-fix actions are invoked by the plugin's own `palette.register` entry when clicked.

Example use: a TypeScript-error highlighter parses `tsc` output and turns `path.ts(12,5): error TS2322: …` into a clickable diagnostic.

#### 6.4.5 `ai.onSuggest(prompt) → suggestion`

Allows a plugin to provide an alternative AI provider.

```ts
interface AiSuggestEvent {
  readonly prompt: string;
  readonly context: ReadonlyArray<{ role: "user"|"assistant"; content: string }>;
  readonly hints: { cwd: string; recentCommands: ReadonlyArray<string>; shell: string };
}

interface AiSuggestion {
  text: string;                 // the command / snippet
  explanation?: string;
  confidence: number;           // 0..1
  providerName: string;
}
```

Only one AI plugin may be "active" at a time; the user picks the active provider from Settings. First-party AI remains the default and is used if no plugin is active.

#### 6.4.6 `settings.schema`

Allows the plugin to declare a settings schema rendered as a panel inside the Plugins tab.

```ts
type SettingField =
  | { id: string; type: "string"; label: string; default?: string; placeholder?: string }
  | { id: string; type: "number"; label: string; default?: number; min?: number; max?: number }
  | { id: string; type: "boolean"; label: string; default?: boolean }
  | { id: string; type: "enum"; label: string; options: string[]; default?: string }
  | { id: string; type: "secret"; label: string };  // stored in OS keychain
```

Values are namespaced to `plugin.<id>.<field>` in Quanta's settings store. `secret` fields are stored via the platform keychain (macOS Keychain / libsecret / Windows Credential Manager) and are never serialised to the settings JSON.

#### 6.4.7 Not-an-API: the "escape hatch" anti-pattern

We explicitly do **not** ship a `host.call("anything")` generic escape hatch. Every surface is purpose-built. If a plugin needs a capability we do not provide, it files an issue and the core team adds a new, narrow surface with its own permission category. This keeps the surface auditable.

### 6.5 Permissions model

Permission categories (v1):

| Category | Description | Example host API it gates |
| --- | --- | --- |
| `network` | Outbound HTTP(S) requests to user-approved domains. | `host.fetch(url, opts)` |
| `filesystem_read` | Read files under declared paths. | `host.readFile(path)` |
| `filesystem_write` | Write files under declared paths. | `host.writeFile(path, bytes)` |
| `clipboard_read` | Read the system clipboard. | `host.clipboard.read()` |
| `clipboard_write` | Write the system clipboard. | `host.clipboard.write(text)` |
| `execute_commands` | Spawn commands under an allowlist. | `host.exec(argv, opts)` |
| `settings_storage` | Persistent, plugin-scoped key-value storage. | `host.storage.*` |

Grant flow:

1. On install (or after update with new permissions), Quanta shows a permission prompt listing each requested category, the plugin-provided reason, and the scoping (allowlist / paths / URL patterns).
2. The user accepts all, accepts selectively (revoke specific categories), or rejects the install.
3. Selective revocation produces a plugin that loads but fails any call into a revoked capability with `PermissionDenied`.
4. Later changes (new permissions on update) re-prompt.

Capability tokens:

- Tokens are opaque 128-bit random values issued by the host at plugin-load time.
- One token per granted category.
- Every privileged host call carries its token; the host validates the token belongs to the calling plugin and matches the category of the call.
- Tokens are never serialised to disk; they live only in memory and are regenerated per load.
- Revocation drops the token from the host-side table; in-flight calls complete or fail based on check timing, but no new calls succeed.

### 6.6 IPC protocol

#### 6.6.1 Wire format (UI side)

All messages are `postMessage`-serialisable structures; no transferables in v1 (a future optimisation for `block.onRender` may transfer byte buffers). The envelope was shown in §6.3.2.

#### 6.6.2 Wire format (Rust side)

WASM imports are typed functions; arguments pass through a Cap'n Proto-serialised buffer in a known memory region. Reason: WASM doesn't natively support rich types across the boundary, and writing one-off marshalling per API is error-prone. Cap'n Proto gives us schema evolution for free.

#### 6.6.3 Versioning of the IPC envelope itself

The envelope has a `version` field: `{ version: 1, ... }`. A future envelope change (e.g. adding transferable buffers) bumps this and the host maintains compatibility for the previous major.

### 6.7 Signing

Every published bundle is signed by its author. First-party plugins are signed by Quanta. Third-party plugins are signed by the author's own key.

- Keys are Ed25519.
- Signature is over a canonical SHA-256 digest of all bundle files except `signature.sig`.
- Public keys are shipped inside the bundle (in a `public_key.pem` file) *and* verified against a trust store.
- Trust store (v1):
  - First-party root key shipped in the Quanta binary.
  - User-trusted keys, added at install time via a "Trust this developer" checkbox in the permission prompt.
  - A separate "Enterprise pinned keys" list for org-deployed Quanta.
- Unknown keys: the install prompt warns loudly and requires a second confirmation.

Signing does **not** imply safety. It implies *accountability* — you know which key signed the bundle and can blacklist that key later. The permission prompt remains the primary defence.

### 6.8 Audit log

Every privileged action (every call into a permission-gated host API) is logged to an append-only file per plugin:

```
$APP_CONFIG_DIR/plugin-audit/<plugin_id>.log
```

Format: one JSON line per event.

```json
{"ts":"2026-04-20T10:15:32.123Z","plugin":"com.example.kubectl-contexts","version":"0.1.0","action":"exec","args":{"argv":["kubectl","config","use-context","prod"]},"outcome":"ok"}
```

Rotation: at 10 MiB, rename to `.1`, then `.2`, up to 5. Older files are deleted.

Logs are user-readable; the plugin cannot read its own audit log (that would let a hostile plugin scrub its tracks). The log is also mirrored to the Settings UI "Recent activity" panel.

### 6.9 Versioning of the plugin API

The Plugin API follows semver.

- **Major bumps** (v1 → v2) happen when a surface's signature changes in a breaking way (field removed, semantics changed).
- **Minor bumps** (v1.0 → v1.1) add new surfaces or optional fields. Plugins that declared `api_version: "1.x"` keep working.
- **Patch bumps** are bug-fix-only. Not visible to plugins.
- **Deprecation window**: once v2 ships, v1 continues to be supported for *one full major release cycle* (approximately six months). During that window, plugins on v1 run but show a "uses deprecated API" badge in the Plugins tab. After the window, the host refuses to load v1 plugins and the user is shown a migration prompt.

Host policy: the host may support *multiple* API majors simultaneously (e.g. v1 and v2). Each plugin binds to exactly one major based on its manifest declaration. Host-side code gates hooks on the plugin's declared major.

### 6.10 Distribution

v1:

- **Local file install.** The user double-clicks a `.quanta-plugin`, or selects it from Settings → Plugins → Install from file.
- **Developer install.** `quanta-plugin dev` symlinks the source directory into the plugins folder and enables hot reload (manifest changes re-prompt; code changes reload in place).
- **Enterprise install.** Admins drop bundles into `$APP_CONFIG_DIR/plugins-managed/`; these load read-only and cannot be disabled by the user. Permissions for managed bundles are pre-granted.

v2 (RFC 0004.1, not in scope here):

- Marketplace with discovery, ratings, versioned updates, revocation/takedown, signed metadata.

### 6.11 Developer experience

Shipped alongside the plugin system: a CLI scaffolder and dev-loop tool.

```
quanta-plugin new my-plugin --rust    # creates Rust + wasm-bindgen scaffold
quanta-plugin new my-plugin --ts      # creates TypeScript scaffold
quanta-plugin build                   # compiles + bundles + computes digest
quanta-plugin dev                     # hot-reload in the local Quanta instance
quanta-plugin publish --key ~/keys/my.key  # signs + outputs .quanta-plugin
quanta-plugin validate ./my-plugin.quanta-plugin  # static analysis + schema check
```

The scaffold contains: manifest template, example hook implementation, README skeleton, test harness (`quanta-plugin test` runs the plugin against a mock host), GitHub Actions workflow for CI builds.

---

## 7. Security

### 7.1 Threat model

Plugins are untrusted. The threat model distinguishes three axes:

1. **Malicious author.** The plugin is written to do harm (exfiltrate credentials, ransomware the home directory, install persistence).
2. **Compromised supply chain.** The plugin's author is honest but their build pipeline / signing key has been compromised.
3. **Buggy plugin.** The plugin is well-intentioned but has a bug that crashes or corrupts host state.

### 7.2 Hostile plugin: capabilities matrix

What a hostile plugin **can** do (by design, with user grant):

- Within its granted `filesystem_read` paths: read files.
- Within its granted `filesystem_write` paths: write files.
- Within its granted `execute_commands` allowlist: run programs with the user's shell privileges.
- Within its granted `network` allowlist: make HTTP(S) requests.
- Read clipboard if granted; write clipboard if granted.

What a hostile plugin **cannot** do (structurally):

- Load native code.
- Escape the WASM sandbox (given wasmtime's security posture; we track CVEs).
- Access memory of another plugin.
- Access memory of the host beyond the imported-function ABI.
- Read or write files outside its declared paths.
- Spawn commands outside its declared allowlist.
- Read the audit log.
- Tamper with the audit log (append-only, host-written).
- Modify its own manifest at runtime.
- Read or write other plugins' settings.
- Install another plugin.
- Modify VT semantics.
- Touch the GPU.
- Access the DOM.
- Access another browser tab / another terminal session's output (cross-session isolation: a plugin sees only sessions the user has explicitly routed to it).

### 7.3 Defences

- **Manifest validation**: strict JSON schema at install time; unknown fields rejected; reason strings non-empty; scoping required for filesystem/network/exec categories.
- **Capability tokens**: every call checked.
- **Resource limits**: CPU fuel, memory, rate limits.
- **Audit log**: forensics after the fact.
- **Revocation**: one-click disable from Settings; all tokens invalidated, plugin process torn down.
- **Signing**: accountability; enables key blacklisting.
- **Sandbox**: WASM + Web Worker; no shared memory.
- **No ambient authority**: plugin cannot even discover whether a file exists without a host call.
- **No shell expansion in `execute_commands`**: argv array only; no shell interpreter in between.

### 7.4 Residual risks (acknowledged)

- A user can still grant a plugin `network` + `filesystem_read` on `~/.aws/credentials` and the plugin will exfiltrate. **Mitigation**: the permission prompt clearly states "this plugin will be able to read your AWS credentials and send them to the internet"; the user accepted.
- A first-party signed plugin that gets compromised upstream could push a malicious update. **Mitigation**: auto-update requires re-consent if permissions change; signature pinning for enterprise.
- A WASM escape vulnerability in wasmtime would give a hostile plugin arbitrary host-process execution. **Mitigation**: track wasmtime security advisories; auto-update host on critical CVEs; defence-in-depth via OS-level sandboxing where available.

---

## 8. Permission matrix (example plugins × categories)

| Plugin | network | fs_read | fs_write | clip_read | clip_write | exec | storage |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| kubectl-contexts | — | `~/.kube/config` | — | — | — | `kubectl` | yes |
| aws-cli-autocomplete | `sts.amazonaws.com` (for STS session check) | `~/.aws/*` | — | — | — | `aws` | yes |
| gitlab-ci-log-highlighter | — | — | — | — | — | — | yes |
| corporate-sso-helper | `sso.corp.example.com` | `~/.corp/tokens` | `~/.corp/tokens` | — | — | `corp-auth` | yes |
| snippet-clipboard | — | — | — | yes | yes | — | yes |
| ai-custom-provider | `api.anthropic.com` or similar | — | — | — | — | — | yes (api key in secret) |
| ts-error-highlighter | — | — | — | — | — | — | yes |
| direnv-bridge | — | `~/.envrc`, cwd `.envrc` | — | — | — | `direnv` | — |

This matrix is reproduced in the user-facing docs so authors know what to ask for, and so reviewers (during manual review of first-party plugins) have a baseline to compare against.

---

## 9. Deprecation lifecycle example

Hypothetical scenario: in v1, `block.onRender` returns `uiFragments[]`. By v2 we want to split this into `block.onMount` + `block.onUpdate` so long-running blocks can stream decorations without re-emitting everything.

Timeline:

- **T**: v2 lands in Quanta 2.0 alongside v1. Plugins declaring `api_version: "1.x"` keep using `block.onRender`; new plugins declare `api_version: "2.x"` and use `onMount` + `onUpdate`. The host runs both.
- **T + 1 minor**: `block.onRender` gains a "deprecated" warning in `quanta-plugin validate` output. Plugin tab shows a "using deprecated API v1" badge.
- **T + 1 major cycle (~6 months)**: v1 support is removed. Plugins declaring `1.x` no longer load. The Plugins tab shows a migration notice ("3 plugins use the retired v1 API — visit their pages to check for updates").
- **Plugin author path**: bump your plugin's `api_version` to `"2.x"`, update your hook implementation, publish new bundle. Users auto-update on next Quanta launch.

The deprecation window is generous (one full major cycle) because the Quanta team cannot coordinate with all third-party authors. Authors who don't update ship broken plugins; users see a clear retirement notice rather than a silent break.

---

## 10. Rollout plan

Implementation sequencing (full detail in `docs/plans/0004-plugin-system/README.md`):

1. **Epic A** (2 weeks): manifest schema, validator, documentation.
2. **Epic B** (3 weeks): WASM runtime host — wasmtime crate integration, WASI subset, resource limits.
3. **Epic C** (4 weeks): the six API surfaces — Rust traits, TS types, test harness, three example plugins.
4. **Epic D** (2 weeks): permission prompt UI, capability tokens, audit log, revocation.
5. **Epic E** (2 weeks): bundle format, signing, signing key management, `quanta-plugin-cli`.
6. **Epic F** (2 weeks): Settings UI "Plugins" tab, per-plugin details, logs viewer.

Total nominal: 15 engineer-weeks; two engineers in parallel where possible.

Gating:

- **Alpha** (internal dogfood): Epic A + B + C + D done; first-party example plugins only.
- **Beta** (external plugin authors): + Epic E; scaffolder shipped; API frozen.
- **GA** (public): + Epic F; Settings UI polished; docs site live; one blog post; three example plugins on GitHub.

Acceptance gate (for GA):

1. Three example plugins shipped (kubectl-contexts, aws-cli-autocomplete, gitlab-ci-log-highlighter).
2. External developer (non-Quanta employee) writes and ships a plugin in under one working day starting from the public docs.
3. No Critical or High-severity vulns open in the plugin system.
4. `quanta-plugin-cli` supports new / build / dev / publish / validate.
5. The Plugins tab in Settings renders all installed plugins with permissions, logs, and enable/disable toggles.

---

## 11. Alternatives considered

### 11.1 No plugin system; "just accept feature requests"

Rejected. The long tail is inexhaustible; core team bandwidth is finite. Even a best-in-class core team cannot maintain kubectl-specific, aws-specific, gcloud-specific, azure-specific, *and* the next ten cloud providers, each of which has its own quirks. Ship a system once, let the ecosystem handle the rest.

### 11.2 Native (dylib / so / dll) plugins

Rejected. A terminal process routinely runs with broad filesystem access; loading untrusted native code into that process is a total loss of containment. Every serious sandboxing attempt for native code on desktop (macOS App Sandbox, Linux seccomp-bpf, Windows AppContainer) has significant rough edges; a terminal's native dependencies often don't play well. WASM gives us portable, zero-native containment at a small runtime cost.

### 11.3 JavaScript with DOM access (Hyper-style)

Rejected. Hyper's experience demonstrates this: (a) supply-chain attacks are devastating because plugins can see every keystroke, (b) performance degrades unpredictably, (c) the rendering model is owned by third parties. Web Worker + message bus is a strictly better model for our case.

### 11.4 Process-per-plugin (like VS Code extension host)

Considered. VS Code runs extensions in a separate Node.js process. Pros: real OS-level isolation. Cons: Node.js is a huge runtime to ship; startup cost per plugin is high; the IPC surface still needs capability enforcement. WASM gets us in-process, fast-start, small-footprint, and a more predictable sandbox than "trust the Node.js runtime boundary".

### 11.5 Lua scripting (Neovim-style)

Rejected as the *primary* surface. Lua is friendly and popular, and we may eventually ship a Lua host as a first-party plugin (ironic, but correct) that lets users write Lua snippets. But the platform surface should be language-neutral and reach both the UI and the Rust side; Lua is not a good fit for the Rust side (it would need embedding a Lua VM), and WASM covers more languages (Rust, TS, Go, Zig, C#, Swift-emitting-wasm).

### 11.6 "Scripts in the Composer" as a lighter alternative

Considered as complementary, not a replacement. A future RFC may add "inline scripts" — short TypeScript snippets the user writes directly in settings, running in the same UI-side worker as plugins but scoped to a single keybinding. This is useful for quick personal automations. It's not a plugin system; it doesn't solve the distribution problem.

---

## 12. Open questions

1. **Marketplace hosting.** Who runs it? What's the abuse process? Payments? Discovery algorithm? Tracked in RFC 0004.1.
2. **Cert authority for signing.** Do we operate our own CA? Use a web-of-trust? Accept self-signed with warning? v1 accepts self-signed; v2 needs a better answer.
3. **Revenue share (v2).** If the marketplace sells paid plugins, what's the cut? What's the tax story? Jurisdictional complexity. Not in scope for RFC 0004.
4. **Enterprise plugin pinning.** How do orgs ship required plugins to all their Quanta installs? The sketch in §6.10 (`plugins-managed/`) is a start; full MDM integration is TBD.
5. **Plugin-to-plugin extension points.** Should a plugin be able to *expose* a hook that other plugins consume? Tempting for things like "shell completions provider" where multiple plugins want to contribute to one list. Deferred to v2; v1 keeps plugins standalone.
6. **Localisation.** The manifest allows an `i18n/` folder with locale files. The plugin API for looking them up is TBD (`host.i18n.t(key, vars)`?). Deferred.
7. **Telemetry opt-in.** Can a plugin emit telemetry through the host's pipeline? Seems useful but raises privacy questions. Deferred; v1 has no plugin telemetry channel.
8. **Plugin update policy.** Auto-update? Prompt on every update? Only on breaking permission changes? v1 decision: auto-update on patch/minor, prompt on permission change, prompt on major.
9. **Plugin-authored keybindings.** Can a plugin claim a global shortcut (e.g. `Cmd+K Cmd+C` for kubectl context)? Potentially conflicts with core + user keymaps. v1 decision: plugins register *palette* entries only; users assign shortcuts themselves from Settings.
10. **Back-pressure on event streams.** If a plugin subscribes to `diagnostic.onOutput` and can't keep up, do we drop events or queue? v1: drop with warning; guarantee order within blocks but not across.

---

## 13. References

- **VS Code Extension API**: https://code.visualstudio.com/api
- **WebExtensions (Chrome/Firefox/Safari)**: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions
- **wasmtime security model**: https://docs.wasmtime.dev/security.html
- **WASI preview 1**: https://github.com/WebAssembly/WASI/blob/main/legacy/preview1/docs.md
- **Figma's plugin sandbox article** (inspiration for the message-bus model): https://www.figma.com/blog/how-we-built-the-figma-plugin-system/
- **Hyper plugin retrospective (reasons not to give DOM access)**: community-documented incidents.
- **RFC 0001 — Custom VT Engine (xterm.js removal)**: `docs/rfc/0001-custom-vt-engine-xterm-removal.md`
- **Companion plan tree**: `docs/plans/0004-plugin-system/`

---

## 14. Appendix A — Rust trait sketches

```rust
/// Implemented by host-side hook dispatch; each API surface has one.
pub trait CommandSubmitHook {
    fn on_command_submit(
        &self,
        token: &CapabilityToken,
        ev: &CommandSubmitEvent,
    ) -> Result<CommandSubmitResult, PluginError>;
}

pub trait BlockRenderHook {
    fn on_render(
        &self,
        token: &CapabilityToken,
        ev: &BlockRenderEvent,
    ) -> Result<Vec<UiFragment>, PluginError>;
}

pub trait PaletteRegistryHook {
    fn register(
        &self,
        token: &CapabilityToken,
        entry: PaletteEntry,
    ) -> Result<(), PluginError>;
}

pub trait DiagnosticHook {
    fn on_output(
        &self,
        token: &CapabilityToken,
        ev: &OutputLineEvent,
    ) -> Result<Vec<Diagnostic>, PluginError>;
}

pub trait AiSuggestHook {
    fn on_suggest(
        &self,
        token: &CapabilityToken,
        ev: &AiSuggestEvent,
    ) -> Result<AiSuggestion, PluginError>;
}

pub trait SettingsSchemaHook {
    fn schema(&self, token: &CapabilityToken) -> Result<SettingsSchema, PluginError>;
}
```

The WASM-side plugin exports matching functions; the host imports them, wraps them in capability-token checks, and bridges them to Rust callers. TypeScript plugins use mirrored types defined in `@quanta/plugin-api`.

---

## 15. Appendix B — Example plugin skeleton (TypeScript)

```ts
// ui.ts — compiled to ui.js during `quanta-plugin build`
import { definePlugin, type HostBridge } from "@quanta/plugin-api";

export default definePlugin({
  id: "com.example.kubectl-contexts",
  async activate(host: HostBridge) {
    const contexts = await readContexts(host);

    host.palette.register({
      id: "switch",
      title: "Switch kubectl context…",
      keywords: ["k8s", "kube", "context"],
      async invoke() {
        const picked = await host.palette.showList(
          contexts.map((c) => ({ id: c, label: c }))
        );
        if (!picked) return;
        await host.exec(["kubectl", "config", "use-context", picked.id]);
        host.notify(`Switched to ${picked.id}`, "ok");
      },
    });

    host.session.onCommandSubmit(async (ev) => {
      if (!ev.command.startsWith("kubectl")) return {};
      const ctx = await host.exec(["kubectl", "config", "current-context"]);
      return { annotations: [{ kind: "badge", text: ctx.stdout.trim(), color: "info" }] };
    });
  },
});

async function readContexts(host: HostBridge): Promise<string[]> {
  const raw = await host.fs.readText("~/.kube/config");
  const lines = raw.split("\n").filter((l) => l.match(/^\s*- name:\s*/));
  return lines.map((l) => l.replace(/^\s*- name:\s*/, "").trim());
}
```

A matching Rust-side skeleton lives in `docs/plans/0004-plugin-system/epic-C-plugin-api-surfaces.md`.

---

## 16. Appendix C — Canonical digest algorithm

```
digest = SHA-256(
  sorted_concat(
    for f in bundle.files if f.name != "signature.sig":
      utf8("path=" + f.name + "\n" + "size=" + f.size + "\n") || f.bytes || "\n"
  )
)
signature = Ed25519.sign(signing_key, digest)
```

The `sorted_concat` step is critical: any implementation that sorts files inconsistently would produce different digests on different platforms. We commit to byte-wise lex sort of the UTF-8-encoded path. Test vectors ship with the bundle spec.

---

## 17. Change history

| Date | Author | Change |
| --- | --- | --- |
| 2026-04-20 | Platform Team | Initial draft. |

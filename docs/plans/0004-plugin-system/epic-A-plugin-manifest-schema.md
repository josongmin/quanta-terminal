# Epic A — Plugin Manifest Schema

- **Parent**: `docs/rfc/0004-plugin-system.md`, `docs/plans/0004-plugin-system/README.md`
- **Owner**: Platform team
- **Duration**: 2 weeks
- **Status**: Draft

The manifest is the contract between a plugin and the host. Epic A defines the schema, the validator, and the surrounding tooling. Nothing else in the plugin system can be built before this lands, because every other component consumes the manifest.

---

## 1. Goal

Ship a stable, versioned, strictly validated `plugin.json` format. Ship a first-class validator (`quanta-plugin validate`) that catches manifest errors at author time. Ship the reference documentation that plugin authors read first.

By end of epic:

- JSON Schema file published under `docs/plans/0004-plugin-system/schema/plugin.schema.json` (Draft 2020-12).
- Rust parser + validator library in `crates/quanta-plugin-host/src/manifest/`.
- TypeScript validator mirrored in `packages/plugin-api/src/manifest/`.
- Three example manifests (for the three example plugins) that pass validation.
- One "bad manifest" test corpus with ~40 rejection cases.

---

## 2. Non-goals

- Loading the manifest's WASM / JS modules (Epic B / C).
- Verifying the bundle signature (Epic E).
- Prompting for permissions (Epic D).
- Registering the plugin at runtime (Epic C).

---

## 3. Schema reference (v1.0)

### 3.1 Top-level fields

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `manifest_version` | integer | yes | Must equal `1`. Future majors bump this; the host rejects manifests whose `manifest_version` is unsupported. |
| `id` | string | yes | Reverse-DNS, `^[a-z][a-z0-9_\-]*(\.[a-z][a-z0-9_\-]*)+$`. Max 128 chars. Primary key everywhere. |
| `name` | string | yes | Human-readable. 1–80 chars. |
| `version` | string | yes | Semver, `^\d+\.\d+\.\d+(-[A-Za-z0-9.-]+)?$`. |
| `api_version` | string | yes | One of `"1.x"`, `"1.<minor>"`, `"2.x"`. No ranges like `"^1.2"`; the grammar is deliberately small. |
| `description` | string | yes | 1–400 chars. Shown in permission prompt and plugins tab. |
| `author` | object | yes | `{ name, email, url? }`. Email RFC-5322, URL must be `https://`. |
| `license` | string | yes | SPDX identifier or `"UNLICENSED"`. |
| `icon` | string | no | Relative path to PNG inside bundle, ≤ 256 KiB, square, ≥ 128 px. |
| `entrypoints` | object | yes | See §3.2. |
| `api_surfaces` | string[] | yes | Whitelist from §3.3; min 1; duplicates rejected. |
| `permissions` | object | no | See §3.4. Omitting it means no permissions requested. |
| `signature` | string | no at schema time | Filled in at publish by the CLI; the runtime verifier requires it. |
| `i18n` | object | no | See §3.5. |
| `keywords` | string[] | no | For marketplace discovery (v2). Max 10, each 1–32 chars, `[a-z0-9-]`. |
| `homepage` | string | no | `https://…`. |
| `repository` | string | no | `https://…`. |
| `bugs` | string | no | `https://…` or `mailto:…`. |
| `engines` | object | no | `{ quanta: ">=1.6" }` constraint. |

Unknown top-level fields are **rejected** by the validator at strict mode (`quanta-plugin validate`). At install time they are accepted but logged as warnings, so host upgrades that add fields don't silently break older plugins.

### 3.2 `entrypoints` sub-schema

```json
{
  "entrypoints": {
    "host": "plugin.wasm",     // optional, relative path
    "ui":   "ui.js"            // optional, relative path
  }
}
```

Rules:

- At least one of `host` or `ui` is required.
- Paths are relative to the bundle root. Absolute paths, path traversal (`..`), and symlinks are rejected.
- `host` must end in `.wasm`; the file must be a valid WASM module (checked at bundle-validation time in Epic E).
- `ui` must end in `.js`, `.mjs`, or `.cjs`; contents must parse as an ES module with a default export.
- Files referenced but not present in the bundle cause `ManifestInvalid` at validation time.

### 3.3 `api_surfaces` enumeration (v1)

Exactly these strings are accepted:

- `session.onCommandSubmit`
- `block.onRender`
- `palette.register`
- `diagnostic.onOutput`
- `ai.onSuggest`
- `settings.schema`

Declaring a surface the plugin does not actually implement is a warning (the host can't prove it, but the validator flags unreachable registrations at build time if the code path is absent). Declaring a surface that does not exist in v1 is a rejection.

Adding a surface in v1.1 is backward-compatible: new plugins may declare it; old plugins ignore it. Removing a surface is a major bump.

### 3.4 `permissions` sub-schema

`permissions` is an object whose keys are permission categories and whose values describe the grant scope + reason.

```json
{
  "permissions": {
    "network": {
      "reason": "Fetch bucket listings from AWS S3.",
      "allowlist": ["https://*.s3.amazonaws.com", "https://sts.amazonaws.com"]
    },
    "filesystem_read": {
      "reason": "Read your AWS credentials to resolve default account.",
      "paths": ["~/.aws/config", "~/.aws/credentials"]
    },
    "filesystem_write": {
      "reason": "Cache the completions DB.",
      "paths": ["$APP_CACHE_DIR/com.example.aws-cli-autocomplete/"]
    },
    "clipboard_read":   { "reason": "…" },
    "clipboard_write":  { "reason": "…" },
    "execute_commands": {
      "reason": "Shell out to `aws` to run discovery.",
      "allowlist": ["aws"]
    },
    "settings_storage": { "reason": "Persist user preferences." }
  }
}
```

Per-category shape:

| Category | Required fields | Optional fields |
| --- | --- | --- |
| `network` | `reason`, `allowlist[]` (one or more URL glob patterns) | — |
| `filesystem_read` | `reason`, `paths[]` | — |
| `filesystem_write` | `reason`, `paths[]` | — |
| `clipboard_read` | `reason` | — |
| `clipboard_write` | `reason` | — |
| `execute_commands` | `reason`, `allowlist[]` (program names, no paths) | `argv_patterns[]` (future) |
| `settings_storage` | `reason` | — |

Hard validator rules:

- `reason` must be 8–280 UTF-8 chars. Whitespace-only or placeholder text (`"asdf"`, `"todo"`, the string `"reason"`) is rejected by a blocklist.
- `allowlist` for `network` must be URL globs with an explicit scheme; `http://` is rejected (only `https://`).
- `allowlist` for `execute_commands` is program *names* (no `/`). This means `execute_commands` on `bash` spawns the `bash` on `PATH`; it cannot spawn `/usr/bin/malicious`. Absolute paths are a deliberate rejection; the host resolves via `PATH`.
- `paths` entries may use `~`, `$APP_CONFIG_DIR`, `$APP_CACHE_DIR`, `$APP_DATA_DIR`, `$PROJECT_ROOT` (cwd). No other env expansion. No `..`. No absolute paths outside the user's home. System paths (`/etc`, `/usr`, `/System`, `C:\Windows`) are explicitly forbidden.
- Paths must be either a single file or end with `/` to denote a directory tree.
- A plugin may not request a permission without using the matching API (validator warning; not a hard reject because the plugin may use it conditionally).

### 3.5 `i18n` sub-schema

```json
{
  "i18n": {
    "default_locale": "en",
    "locales": ["en", "ja", "de"],
    "path": "locales/"
  }
}
```

Rules:

- `default_locale` must appear in `locales`.
- Each locale has a matching `<path>/<locale>.json` file in the bundle, flat key → string map.
- Keys are `^[a-z][a-z0-9_.]*$`, values are 1–400 chars.
- v1 does not ship a runtime `host.i18n.t()` (deferred); the field exists so the schema is future-proof.

---

## 4. Design decisions

### 4.1 JSON, not TOML / YAML

Chosen because: every plugin toolchain already parses JSON; YAML has indentation foot-guns and allows too-permissive constructs (anchors, aliases, tag types); TOML is fine but forces a second parser in TS where `JSON.parse` is free. Every manifest is under 4 KiB; human-hand-editability is mildly degraded but the CLI scaffolder generates most of it.

### 4.2 Strict unknown-field rejection at author time

Authors will mistype fields (`"permisions"` instead of `"permissions"`). Silent accept is hostile. The validator rejects unknowns at author time (when run by `quanta-plugin validate` or `quanta-plugin build`). At install time the host is permissive-with-warning for forward compatibility when host 1.7 adds a field that host 1.6 doesn't know.

### 4.3 `api_version` as a small grammar

Accepting full semver ranges (`"^1.2"`, `">=1.0 <2.0"`) invites tooling divergence. We accept only `"<major>.x"` or `"<major>.<minor>"`. Host interprets `"1.x"` as "any 1.*" and `"1.2"` as "exactly 1.2.*".

### 4.4 Reverse-DNS identifiers

`com.example.my-plugin` rather than `@example/my-plugin` (NPM style). Rationale: plugins aren't npm modules; a reverse-DNS id makes the "who owns this" story explicit and matches Java / Android / macOS conventions for extensions.

### 4.5 No inheritance / includes

Manifests cannot extend a parent manifest or include from another file. One file, one plugin, one source of truth. Simpler validator, simpler audit.

---

## 5. Validator behaviour

### 5.1 CLI surface

```
quanta-plugin validate <path-to-bundle-or-manifest>
```

Flags:

- `--strict` (default): reject unknown fields, reject warnings-as-errors.
- `--lenient`: warn on unknowns (used during development).
- `--json`: machine-readable output for CI.
- `--locale <code>`: run i18n checks for the given locale.

Exit codes:

- `0` — valid (strict or lenient).
- `1` — invalid.
- `2` — I/O error.

### 5.2 Error messages

Every rejection carries a `code`, a `path` (JSON pointer), a `message`, and a `hint` (how to fix). Example:

```
error: manifest.permissions.network.reason is too short
  code: REASON_TOO_SHORT
  path: /permissions/network/reason
  hint: reasons must be between 8 and 280 characters and describe the user-visible purpose.
  seen: "fetch"
  expected: e.g. "Fetch bucket listings from AWS S3 when the user types `aws s3 cp`."
```

Reasons for pedantic messages: this is the main surface plugin authors interact with. Good error messages cut onboarding time dramatically.

### 5.3 Static analysis (bonus checks)

- Warn on `permissions` requested but corresponding API never used (if we can prove it from the bundle — TS plugins analysable via AST; Rust plugins opaque).
- Warn on `api_surfaces` declared but no matching registration call.
- Warn on `icon` too small, too asymmetric, or non-PNG.
- Warn on `description` containing placeholder text.

---

## 6. Implementation sketch

### 6.1 Rust side

Crate `quanta-plugin-host`, module `manifest`:

```rust
pub struct Manifest {
    pub manifest_version: u32,
    pub id: PluginId,
    pub name: String,
    pub version: semver::Version,
    pub api_version: ApiVersionReq,
    pub description: String,
    pub author: Author,
    pub license: String,
    pub icon: Option<PathBuf>,
    pub entrypoints: Entrypoints,
    pub api_surfaces: BTreeSet<ApiSurface>,
    pub permissions: Permissions,
    pub signature: Option<String>,
    pub i18n: Option<I18n>,
    pub keywords: Vec<String>,
    pub homepage: Option<Url>,
    pub repository: Option<Url>,
    pub bugs: Option<String>,
    pub engines: Option<Engines>,
}

pub fn parse_manifest(bytes: &[u8]) -> Result<Manifest, ManifestError> { … }
pub fn validate_manifest(m: &Manifest, strict: bool) -> Vec<ManifestIssue> { … }
```

Dependencies:

- `serde` / `serde_json` for parsing.
- `semver` for versions.
- `url` for URL validation.
- `schemars` to auto-emit the JSON schema from the struct (single source of truth).

### 6.2 TypeScript side

Package `@quanta/plugin-api`, module `manifest`:

```ts
export interface Manifest { … }                 // mirrors the Rust struct
export function parseManifest(source: string): Result<Manifest>;
export function validateManifest(m: Manifest, opts: { strict: boolean }): Issue[];
```

The TS types are generated from the same JSON schema the Rust side emits, via `json-schema-to-typescript`. This guarantees the two sides stay in sync.

### 6.3 Shared JSON schema

Single source of truth: `crates/quanta-plugin-host/manifest/plugin.schema.json`, emitted from the Rust `schemars` derive. The TS build step consumes it.

---

## 7. Work breakdown

### Sprint 1 (week 1)

- **A-1.1** Lay down `crates/quanta-plugin-host/` crate; empty lib.
- **A-1.2** Define Rust struct hierarchy for the manifest.
- **A-1.3** Implement serde parsing with custom validators.
- **A-1.4** Implement URL glob validator (for `network.allowlist`).
- **A-1.5** Implement path expansion / safety validator (for filesystem categories).
- **A-1.6** Emit JSON schema via `schemars`.
- **A-1.7** Write ~25 happy-path unit tests.
- **A-1.8** Start the "bad manifest" corpus (~15 cases).

### Sprint 2 (week 2)

- **A-2.1** Add `manifest_version` / `api_version` compatibility logic.
- **A-2.2** Add strict-vs-lenient unknown-field handling.
- **A-2.3** Add static-analysis bonus checks (unused permissions, unused surfaces).
- **A-2.4** Write CLI `quanta-plugin validate` skeleton (full CLI is Epic E; here we scaffold the validate subcommand).
- **A-2.5** Generate TS types from the schema; wire `packages/plugin-api/` build.
- **A-2.6** Finish bad-manifest corpus (~40 cases).
- **A-2.7** Write three example manifests for kubectl-contexts / aws-cli-autocomplete / gitlab-ci-log-highlighter.
- **A-2.8** Write the manifest reference docs.
- **A-2.9** Code review + polish.

---

## 8. Tests

### 8.1 Unit tests (Rust)

- Every field's min/max.
- Every regex constraint (id, version, keywords).
- `api_version` grammar: all valid forms accepted, all invalid forms rejected.
- `permissions` per-category required fields.
- Reason blocklist (empty, placeholder, too short, too long).
- Path expansion on each platform.
- URL glob rejection of `http://`, of schemes other than `https`.

### 8.2 Integration tests

- Load every sample manifest from `docs/plans/0004-plugin-system/schema/examples/`.
- Round-trip: parse → emit → parse; byte-identical.
- Schema self-check: generated schema validates the sample manifests.

### 8.3 Bad-manifest corpus

Under `crates/quanta-plugin-host/tests/fixtures/bad-manifests/`. Each case is a `.json` + expected-error `.txt`. Example:

- `01-missing-id.json`
- `02-bad-id-chars.json`
- `03-empty-reason.json`
- `04-placeholder-reason.json`
- `05-http-allowlist.json`
- `06-absolute-path-fs-read.json`
- `07-path-traversal.json`
- `08-unknown-category.json`
- `09-missing-manifest-version.json`
- `10-wrong-manifest-version.json`
- `11-unknown-api-surface.json`
- `12-api-surface-duplicate.json`
- `13-api-version-range-full.json` (`"^1.2"` rejected)
- `14-duplicate-key.json`
- `15-bad-semver.json`
- `16-empty-name.json`
- `17-name-too-long.json`
- `18-entrypoints-both-missing.json`
- `19-bad-entrypoint-extension.json`
- `20-symlink-entrypoint.json`
- `21-icon-not-png.json`
- `22-icon-too-small.json`
- `23-email-malformed.json`
- `24-url-not-https.json`
- `25-locale-mismatch.json`
- `26-locale-file-missing.json`
- `27-exec-allowlist-contains-slash.json`
- `28-exec-allowlist-absolute.json`
- `29-fs-path-system-dir.json` (rejects `/etc`)
- `30-network-allowlist-empty.json`
- `31-unknown-top-level-field-strict.json`
- `32-keywords-too-many.json`
- `33-keyword-bad-chars.json`
- `34-engines-incompatible.json`
- `35-license-not-spdx.json`
- `36-description-placeholder.json`
- `37-id-reserved.json` (e.g. `com.quanta.*`)
- `38-version-leading-v.json` (`v1.0.0` rejected; must be `1.0.0`)
- `39-api-version-unknown-major.json`
- `40-manifest-too-large.json` (> 64 KiB).

### 8.4 Cross-language parity tests

A shared fixture set is run through both the Rust validator and the TS validator; outputs are compared. Any divergence is a bug.

---

## 9. Documentation

- `docs/plans/0004-plugin-system/schema/plugin.schema.json` — the JSON schema.
- `docs/plans/0004-plugin-system/schema/examples/` — three example manifests.
- "Manifest reference" chapter of the plugin docs — generated from the Rust `schemars` description attributes.
- "Authoring your first manifest" tutorial — written from the perspective of a new plugin author.

---

## 10. Risks & mitigations (epic-local)

| Risk | Mitigation |
| --- | --- |
| Schema churn during Epic C breaks early-adopter plugins | Freeze schema at end of Epic A; changes require an RFC amendment. |
| Rust / TS validators drift | Single JSON schema source; parity test suite. |
| Placeholder reasons slip through (authors paste `"TODO"`) | Blocklist + CI step in scaffolder's template that fails until reasons are replaced. |
| Path-safety logic has platform gotchas (Windows reserved names like `CON`, `PRN`) | Run fixtures on all three platforms in CI; add per-platform rejections for reserved names. |

---

## 11. Acceptance criteria

- [ ] `plugin.schema.json` published and stable.
- [ ] Rust manifest parser + validator shipped under `quanta-plugin-host::manifest`.
- [ ] TS validator shipped under `@quanta/plugin-api`.
- [ ] `quanta-plugin validate` subcommand works (full CLI lands in Epic E).
- [ ] 40-case bad-manifest corpus passes.
- [ ] Cross-language parity test suite green.
- [ ] Three example manifests for v1 example plugins validate clean.
- [ ] Manifest reference docs merged.

---

## 12. Change history

| Date | Author | Change |
| --- | --- | --- |
| 2026-04-20 | Platform Team | Initial epic plan. |

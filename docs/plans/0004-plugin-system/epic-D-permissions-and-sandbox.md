# Epic D — Permissions and Sandbox

- **Parent**: `docs/rfc/0004-plugin-system.md`, `docs/plans/0004-plugin-system/README.md`
- **Depends on**: Epic A (manifest), Epic B (runtime host)
- **Duration**: 2 weeks
- **Status**: Draft

Epic D makes the plugin system **safe**. It builds the capability-token layer, the permission prompt UI, the audit log, and the revocation flow. A good pass here means a compromised plugin can't do more than the user explicitly approved; a bad pass means game over.

---

## 1. Goal

Ship end-to-end capability-based security: every privileged call from a plugin presents a capability token that the host validates against the current grant state. Ship the user-facing permission prompt, the Settings revocation toggle, and the per-plugin audit log. Ship a hostile-plugin test suite that encodes every attack vector we can think of and prove each is defeated.

By end of epic:

- `PermissionGrants` + `CapabilityTokenTable` types; round-tripped through load → call → revoke.
- Permission prompt UI (install, update-with-new-perms, manual grant).
- Audit log writer + rotator.
- "Hostile plugin" integration suite passing.
- Revocation flow tested end-to-end.

---

## 2. Non-goals

- Loading or running the plugin (Epic B).
- The API surfaces themselves (Epic C).
- Signing / bundle verification (Epic E) — but token issuance sits downstream of signature trust.
- The Plugins tab's general management UI (Epic F) — but the permission prompt and the revocation button live across both epics.

---

## 3. Permission model

### 3.1 Categories (seven)

Reproduced here as the canonical source:

| Category | Scope modifier | Maps to host imports |
| --- | --- | --- |
| `network` | `allowlist: string[]` (URL globs, `https://` only) | `quanta:net.fetch` |
| `filesystem_read` | `paths: string[]` | `quanta:fs.read_text`, `quanta:fs.read_bytes` |
| `filesystem_write` | `paths: string[]` | `quanta:fs.write_text`, `quanta:fs.write_bytes` |
| `clipboard_read` | (no scope) | `quanta:clip.read` |
| `clipboard_write` | (no scope) | `quanta:clip.write` |
| `execute_commands` | `allowlist: string[]` (program names) | `quanta:exec.spawn` |
| `settings_storage` | (no scope) | `quanta:settings.get|set|delete|get_secret|set_secret` |

No category covers VT state, GPU, inter-plugin access, or host internals — those don't exist as plugin-reachable APIs.

### 3.2 Grant state

Per plugin:

```rust
pub struct PermissionGrants {
    pub plugin_id: PluginId,
    pub plugin_version: semver::Version,
    pub network: Option<NetworkGrant>,
    pub filesystem_read: Option<FsGrant>,
    pub filesystem_write: Option<FsGrant>,
    pub clipboard_read: bool,
    pub clipboard_write: bool,
    pub execute_commands: Option<ExecGrant>,
    pub settings_storage: bool,
    pub granted_at: SystemTime,
    pub granted_by: GrantSource,  // User { account? } | EnterpriseMdm | AutoRenewOnUpdate
}

pub struct NetworkGrant { pub allowlist: Vec<UrlGlob> }
pub struct FsGrant     { pub paths: Vec<PathPattern> }
pub struct ExecGrant   { pub allowlist: Vec<String> }
```

Grants are serialised to `$APP_CONFIG_DIR/plugins/<id>/grants.json` with strict file perms (`0600` on Unix, ACL-user-only on Windows).

### 3.3 Grant lifecycle

1. **Install**: manifest parsed (Epic A). Permission prompt shown (§4). On accept: `PermissionGrants` written; plugin loads.
2. **Update with same permissions**: no prompt; grants auto-renew for the new version.
3. **Update with new permissions**: prompt shown listing *only the deltas* (e.g. "this update newly requests `network: https://foo.com`"). User accepts or reverts to the previous version.
4. **Update that drops permissions**: auto-accept; the grant is narrowed.
5. **Revoke from Settings**: grant flag flipped; next plugin action sees `PermissionDenied`. If the plugin is currently loaded, in-flight tokens are invalidated.
6. **Uninstall**: grant file deleted; audit log archived.

### 3.4 Capability tokens

Tokens are 128-bit random opaque values issued by the host at plugin load time. The host maintains a map per plugin:

```rust
pub struct CapabilityTokenTable {
    tokens: HashMap<TokenId, Category>,
    generation: u64,
}
```

Check path on any host import:

```rust
pub fn verify(&self, token: TokenId, category: Category) -> Result<(), PluginError> {
    match self.tokens.get(&token) {
        Some(c) if *c == category => Ok(()),
        _ => Err(PluginError::PermissionDenied),
    }
}
```

On revocation: the token entry is dropped; subsequent verifies fail with `PermissionDenied`.

On plugin unload: the entire table is dropped; any in-flight call on a different thread that happens to verify after unload sees `PermissionDenied`. This is safe.

### 3.5 No ambient authority

A plugin receives capability tokens at `_activate` time by calling `host.env.get_tokens()`. The tokens are typed and namespaced in SDK code so the plugin doesn't need to reason about which token goes to which call; that's encapsulated.

But there is no "default token" that a plugin can use without grant: every host import explicitly requires a token argument. A plugin that forgets to pass a token, or passes the wrong one, gets `PermissionDenied`.

---

## 4. Permission prompt UI

### 4.1 When it triggers

- On first install of a plugin with any declared permissions.
- On update where permissions changed (delta prompt).
- On user-initiated "grant more permissions" from the Plugins tab.

Never mid-session. Never as a response to a runtime call (unlike browser permission prompts — plugins don't "ask at runtime").

### 4.2 Layout

```
┌──────────────────────────────────────────────────────────────────┐
│  [icon] Kubectl Context Switcher                                 │
│         com.example.kubectl-contexts · v0.1.0 · Jane Smith       │
│         [verified signature]                                     │
│                                                                  │
│  This plugin requests the following permissions:                 │
│                                                                  │
│  ⚡  Run commands                                                  │
│     kubectl                                                      │
│     "Run `kubectl config use-context <ctx>` when user picks one."│
│                                                                  │
│  📂  Read files                                                    │
│     ~/.kube/config                                               │
│     "Read ~/.kube/config to list contexts."                      │
│                                                                  │
│  💾  Settings storage                                              │
│     "Persist the user's favourite contexts."                     │
│                                                                  │
│  [ Advanced ▾ deselect any category to decline it individually ] │
│                                                                  │
│                           [ Cancel ]   [ Install and grant all ] │
└──────────────────────────────────────────────────────────────────┘
```

- Each line shows the category icon, the scoping (in mono font), and the author-provided reason.
- "Advanced" expands into per-category checkboxes, letting the user opt *out* of specific categories. Opted-out categories will return `PermissionDenied` at runtime; the user is warned the plugin may not function.
- The signature state is shown prominently: `verified` (known key), `self-signed` (unknown key; extra warning), `unsigned` (v1 rejects unsigned bundles).

### 4.3 Delta prompt (updates)

Shows only the new or widened permissions, with a clear "This update requests new permissions" header. If the user declines, the previous version continues to run.

### 4.4 Copy guidelines

Written in plain language. No jargon. Reasons are author-provided; the host ensures they're non-empty and non-placeholder (Epic A's blocklist). If a reason reads like marketing, we reject in the first-party submission process (for the three example plugins). Third-party plugins are on the author's own terms, but the Settings UI lets users report misleading reasons.

### 4.5 Accessibility

- Full keyboard navigation; focus order is: each category row → Advanced → Cancel → Grant.
- Screen-reader labels on every icon.
- High-contrast mode respected.
- Prompt cannot be dismissed by clicking outside — must be an explicit Cancel or Grant.

---

## 5. Audit log

### 5.1 Location

`$APP_CONFIG_DIR/plugin-audit/<plugin_id>.log` (per-plugin).

On Unix: mode `0600`, owned by the running user. On Windows: ACL allows only the current user.

### 5.2 Format

One JSON object per line (`jsonl`):

```json
{
  "ts": "2026-04-20T10:15:32.123Z",
  "plugin": "com.example.kubectl-contexts",
  "version": "0.1.0",
  "session": "sess_01HW…",
  "category": "execute_commands",
  "action": "spawn",
  "args": { "argv": ["kubectl", "config", "use-context", "prod"] },
  "outcome": "ok",
  "duration_ms": 87,
  "token_generation": 42
}
```

Fields:

- `ts`: UTC ISO 8601 with ms precision.
- `plugin`: the id.
- `version`: plugin's version at the time of the event.
- `session`: opaque session id; useful to correlate events across plugins.
- `category`: permission category that gated this action, or `system` for lifecycle events.
- `action`: narrow verb per category (`spawn`, `read_text`, `write_text`, `fetch`, `clip_read`, etc.).
- `args`: category-specific structured args; never contains secrets (see redaction rules §5.4).
- `outcome`: `ok` | `denied` | `rate_limited` | `timed_out` | `errored` | `cancelled`.
- `duration_ms`: wall-clock of the host side.
- `token_generation`: the token table generation when verification ran (for forensics; jumps mean a revoke-reload happened).

### 5.3 Rotation

- Rotate at 10 MiB.
- Rename active to `.1`; `.1` → `.2`; up to `.5`.
- `.5` is deleted on rotation.
- On uninstall: archive to `plugin-audit/archived/<plugin_id>-<ts>.log.gz` (kept 30 days, then purged). The archive lets the user review what a plugin did post-uninstall.

### 5.4 Redaction

- `args.argv` for `execute_commands`: argv is logged verbatim except for well-known secret-token patterns (regex match on AWS keys, GCP tokens, etc.) which are replaced with `<redacted>`. False-positive tolerable — we err on the side of redaction.
- `args.url` for `network`: full URL is logged. Query strings with `?key=…`, `?token=…` have the value redacted.
- `args.body` for network writes: not logged by default. Dev mode logs first 1 KiB.
- Secrets accessed via `settings_storage.get_secret`: the *handle* is logged, never the value.
- Filesystem reads: the path is logged; the content is not.

### 5.5 Plugin cannot read its own log

The audit file has OS perms that allow only the host process / user. The plugin has no `fs_read` path permission that covers `$APP_CONFIG_DIR/plugin-audit/`; even if a user grants `filesystem_read` on their home directory, the manifest validator rejects paths under `$APP_CONFIG_DIR/plugin-audit/` (an explicit denylist).

### 5.6 User-facing view

The Plugins tab (Epic F) shows the last 200 entries per plugin with category filters. "Export full log" button copies the raw file.

---

## 6. Revocation flow

Revocation happens from Settings → Plugins → <plugin> → Permissions → toggle off.

Host-side sequence:

1. UI sends `revoke(plugin_id, category)` to host.
2. Host updates the on-disk grant file.
3. Host removes the matching token from the plugin's token table and increments the generation counter.
4. Host writes an audit entry: `{ category: "system", action: "revoke", args: { category: <cat> }, outcome: "ok" }`.
5. Host emits a `permission_changed` event to the plugin (so it can gracefully stop using the capability).

Full-disable (flip "Enabled" off):

1. UI sends `disable(plugin_id)`.
2. Host cancels in-flight calls with `PluginError::PluginDisabled`.
3. Host calls `_deactivate` on the plugin (best effort, 2 s timeout).
4. Host drops the plugin's `Store`; all tokens invalidate by construction.
5. The grant file is kept so re-enable doesn't re-prompt (unless permissions changed in the meantime).

---

## 7. Hostile-plugin suite (Epic-D level)

In addition to the Epic-B hostile suite (which focuses on runtime isolation), Epic D ships permission-focused hostile tests:

| # | Name | Attack | Expected outcome |
| --- | --- | --- | --- |
| D1 | `forge_token.wasm` | Plugin invents a token value | `PermissionDenied`; audit entry with `denied`. |
| D2 | `reuse_others_token.wasm` | Plugin passes a token from another plugin (if it somehow sniffs one) | `PermissionDenied`; tokens are per-store so impossible by construction, but we include the test. |
| D3 | `off_allowlist_url.wasm` | Plugin granted `https://a.com` fetches `https://b.com` | `PermissionDenied`; audit `denied`. |
| D4 | `off_allowlist_url_subdomain.wasm` | Plugin granted `https://*.a.com` fetches `https://a.com.attacker.com` | `PermissionDenied` (glob matcher rejects subdomain-confusion attempts). |
| D5 | `off_path_read.wasm` | Plugin granted `~/project/` reads `~/secret` | `PermissionDenied`. |
| D6 | `off_path_read_traversal.wasm` | Plugin granted `~/project/` reads `~/project/../secret` | Path canonicaliser resolves before check; `PermissionDenied`. |
| D7 | `off_exec_program.wasm` | Plugin granted `kubectl`, runs `curl` | `PermissionDenied`. |
| D8 | `exec_absolute_path.wasm` | Plugin granted `kubectl`, runs `/usr/local/bin/kubectl` | `PermissionDenied` (allowlist is name-only; absolute rejected). |
| D9 | `exec_shell_injection.wasm` | Plugin granted `kubectl`, passes `kubectl; rm -rf /` as argv[0] | `PermissionDenied` (argv[0] must match allowlist; metachars in argv[0] rejected). |
| D10 | `exec_env_injection.wasm` | Plugin sets `LD_PRELOAD` before exec | Reject at exec import (env is whitelisted, LD_* stripped). |
| D11 | `fs_write_outside.wasm` | Plugin granted write to `~/cache/`, writes to `~/cache/../etc/passwd` | Rejected. |
| D12 | `fs_symlink_escape.wasm` | User has a symlink inside the granted path pointing outside | Canonicalisation resolves; if target is outside, reject. |
| D13 | `clip_without_grant.wasm` | Plugin calls `clip.read` without `clipboard_read` token | `PermissionDenied`. |
| D14 | `audit_tamper.wasm` | Plugin tries to open the audit log via `fs_read` (even if user granted it somehow) | Manifest validator rejects path at install (§5.5). |
| D15 | `audit_flood.wasm` | Plugin floods privileged calls to balloon the audit log | Rate limiter kicks in; single `rate_limited` entry; plugin strikes. |
| D16 | `revoke_race.wasm` | Plugin in flight when revoke happens | Token check after revoke fails; `PermissionDenied`. Property test with random revoke timing. |
| D17 | `reentrant_call_escalation.wasm` | Plugin uses hook callback to submit a command that the plugin itself would be re-invoked for | Reentrancy counter caps at depth 2; `HostBusy` beyond. |
| D18 | `manifest_update_silent_elevation.wasm` | v0.1 has `fs_read: ~/.ssh/`; v0.2 widens to `fs_write: ~/.ssh/` | Delta prompt triggered; no silent grant. |
| D19 | `settings_read_other.wasm` | Plugin A reads plugin B's settings keys | Storage namespace enforced; `NotFound` (not `PermissionDenied`, because it's not even a visible key). |
| D20 | `secret_leak.wasm` | Plugin stores a secret, then tries to read it via the non-secret API | Secret-handle indirection; non-secret get returns the handle opaquely, not the value. |

All 20 tests must pass before Epic D is accepted.

---

## 8. Threat-model summary

What a hostile plugin **can still do** even with this system (and why we accept it):

- **Exfiltrate data the user granted access to.** If the user granted `fs_read ~/.aws/credentials` + `network https://attacker.com`, the plugin can read and post. The prompt shows this pairing as a high-risk combination; the user accepted. No technical mitigation short of refusing to grant such combinations.
- **Be slow.** Budgets and strikes limit damage; a malicious plugin that spams the watchdog still degrades quality of service.
- **Trick users with vague reasons.** The reason blocklist and length minimum help; the final defence is user literacy and the permission prompt's clear scoping display.
- **Be legitimately compromised (upstream supply chain).** Signature accountability lets us blacklist keys post hoc; auto-updates with permission deltas prevent silent elevation.

What a hostile plugin **cannot** do:

- Access unreserved filesystem paths, even with write grant — path canonicalisation + denylist.
- Escape the WASM sandbox (given wasmtime posture + CVE tracking).
- Access other plugins' state.
- Tamper with the audit log.
- Load native code.
- Modify VT or GPU state.
- Access the DOM.

---

## 9. Work breakdown

### Sprint 1 (week 1)

- **D-1.1** `PermissionGrants` + `CapabilityTokenTable` types; serde.
- **D-1.2** Grant file storage with strict perms; cross-platform perm helpers.
- **D-1.3** Token verify path wired into Epic B's imports.
- **D-1.4** URL glob matcher (with subdomain-confusion tests).
- **D-1.5** Path canonicaliser + denylist for system dirs and audit dir.
- **D-1.6** Exec allowlist matcher (name-only; no metachars; env strip).
- **D-1.7** Audit log writer with rotation.
- **D-1.8** Secret handle indirection (keychain write path + handle issuance).

### Sprint 2 (week 2)

- **D-2.1** Permission prompt UI (React component, keyboard nav, a11y).
- **D-2.2** Delta prompt for updates.
- **D-2.3** Settings → Plugins → revoke/disable wiring.
- **D-2.4** Hostile-plugin suite D1–D20.
- **D-2.5** Copy review for prompt messages.
- **D-2.6** Security review sign-off.
- **D-2.7** Docs: security guide for plugin authors; user guide for the prompt.

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Users click-through every prompt | Single consolidated prompt per install; explicit per-category scoping visible; link to "what can this plugin do with this permission?" doc. |
| Author-supplied reasons mislead | Blocklist placeholder text; community reporting; first-party review for example plugins. |
| Path allowlist has platform quirks (Windows long paths, macOS case-insensitive fs) | Test matrix across platforms; canonicalise via platform-specific APIs, not manual string work. |
| URL glob parser is permissive | Pin glob grammar to a narrow subset; fuzz-test; reject ambiguous patterns. |
| Revoke race leaves stale tokens in-flight | Generation counter; post-revoke verify fails for old generation. |
| Secret handles leak across plugins | Handles are per-plugin IDs; keychain service string includes plugin id. |

---

## 11. Acceptance criteria

- [ ] Capability tokens issued, verified, revocable.
- [ ] Permission prompt renders and covers install / update-delta / manual grant cases.
- [ ] Audit log writes, rotates, is read-only to the plugin.
- [ ] Secret handles route to the OS keychain.
- [ ] Revocation flow invalidates tokens live.
- [ ] All 20 hostile-plugin tests pass.
- [ ] Security review sign-off.
- [ ] Docs shipped: author security guide, user security guide.

---

## 12. Change history

| Date | Author | Change |
| --- | --- | --- |
| 2026-04-20 | Platform Team | Initial epic plan. |

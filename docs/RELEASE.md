# Release Operations

This document is the single source of truth for cutting a signed, notarized
Quanta Terminal release. Everything here is invoked by `.github/workflows/release.yml`;
the doc exists so an operator can reproduce the pipeline locally and so a
fresh secret rotation has a checklist to follow.

## Pipelines at a glance

- `ci.yml` — correctness gate on every PR. Unit tests + clippy + fmt + the
  layering / topic audits. No bundling.
- `release.yml` — builds the full platform matrix (macOS arm64, macOS
  x86_64, Windows x86_64, Linux x86_64), signs, notarizes, and publishes
  the GitHub release. Triggered by `v*.*.*` tags and manual dispatch.
- `nightly.yml` — same matrix, unsigned, every night at 06:00 UTC. 7-day
  artifact retention. Catches platform regressions before a tag.

## Secrets checklist

All secrets are resolved through `${{ secrets.<NAME> }}`. Every signing step
is wrapped in `if: ${{ secrets.<NAME> != '' }}` so the pipeline passes as a
dry run on forks and unprovisioned repos. The job surface will be marked
`UNSIGNED` in the GitHub Actions summary when a secret is absent.

| Secret                         | Where to get it                                                      | Required for                      |
| ------------------------------ | -------------------------------------------------------------------- | --------------------------------- |
| `APPLE_CERTIFICATE`            | Base64 of a `Developer ID Application` .p12 export                   | macOS codesign                    |
| `APPLE_CERTIFICATE_PASSWORD`   | Password you set when exporting the .p12                             | macOS codesign                    |
| `APPLE_SIGNING_IDENTITY`       | `Developer ID Application: <Name> (<TEAMID>)`                        | macOS codesign (Tauri reads this) |
| `APPLE_ID`                     | The Apple ID that owns the developer account                         | macOS notarization                |
| `APPLE_PASSWORD`               | App-specific password from appleid.apple.com (not the real password) | macOS notarization                |
| `APPLE_TEAM_ID`                | 10-character team ID from Apple Developer portal                     | macOS notarization                |
| `WINDOWS_CERTIFICATE_PFX`      | Base64 of your Authenticode code-signing .pfx                        | Windows signing                   |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password you set when exporting the .pfx                             | Windows signing                   |
| `LINUX_GPG_KEY`                | Base64 of `gpg --export-secret-keys --armor <keyid>`                 | Linux .asc signatures             |
| `LINUX_GPG_PASSPHRASE`         | Passphrase for the exported GPG key                                  | Linux .asc signatures             |
| `TAURI_UPDATER_PRIVATE_KEY`    | Output of `tauri signer generate -w` (the private half)              | updater manifest signing          |
| `TAURI_UPDATER_KEY_PASSWORD`   | Passphrase you set on the private key                                | updater manifest signing          |

### Generating the Tauri updater keypair

```sh
cd packages/host-tauri
pnpm tauri signer generate -w quanta-updater.key
```

Commit the printed **public key** to `packages/host-tauri/src-tauri/tauri.conf.json`
under `plugins.updater.pubkey`. Store the **private key** as the
`TAURI_UPDATER_PRIVATE_KEY` repository secret and the passphrase as
`TAURI_UPDATER_KEY_PASSWORD`. **Do not commit the private key.**

Until the pubkey is populated, the app's updater plugin will refuse to
apply any update (signature-verification fails). Shipping a build with
the placeholder `"pubkey": ""` is intentionally "updater inactive"; swap
it in before the 1.0 tag.

## Cutting a release

1. Bump `version` in:
   - `package.json` (root)
   - `packages/host-tauri/src-tauri/tauri.conf.json`
   - `packages/host-tauri/src-tauri/Cargo.toml`
   - `Cargo.toml` workspace.package.version
2. Commit with a `chore(release): vX.Y.Z` message.
3. Tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. Watch the `Release` workflow on GitHub Actions. On success, the
   GitHub release page lists the signed artifacts and the update
   manifest (`latest.json`).
5. Upload `latest.json` to the updater endpoint host
   (`updates.quanta-terminal.dev`). This step is currently manual — a
   future iteration can push to S3/R2 directly from the workflow.

### Pre-release tags

Tags containing a `-` (e.g. `v0.2.0-rc1`) are marked `prerelease: true` on
the GitHub release. The updater should be configured to serve stable
users only stable tags; filtering lives at the CDN layer.

## What CI does per job

- **gate** — runs before any build. Fails fast on clippy/fmt/test errors.
- **build matrix** — per-target triple:
  1. Checkout + toolchains
  2. `./scripts/package-sidecar.sh` to stage `quanta-core`
  3. Import the platform cert / key (when secrets are set)
  4. `pnpm --filter @quanta/host-tauri tauri build --target <triple>`
  5. Sign detached signatures (Linux GPG; Tauri handles macOS/Windows
     inline via the signing identity env vars)
  6. Stage + upload as `bundle-<label>` artifact
- **manifest** — downloads every `bundle-*`, runs
  `tools/update-manifest-gen` to assemble `latest.json`, uploads as
  `update-manifest`.
- **publish** — tag-triggered only. Flattens artifacts into a single
  folder and creates the GitHub release.

## Update delivery model

- Runtime: `tauri-plugin-updater` polls
  `https://updates.quanta-terminal.dev/{{target}}/{{arch}}/{{current_version}}`.
- Response: the signed `latest.json` this workflow emits.
- On match, the plugin downloads the bundle, verifies the signature
  against the baked `pubkey`, and restarts. The TS wrapper lives in
  `packages/host-tauri/src/updater.ts`; the boot path invokes
  `checkForUpdates()` once and surfaces the result to the banner
  dispatcher (`setUpdaterBannerDispatcher`).

## Dry-run vs signed-release behavior

| Mode                                  | Signing secrets? | Build output                                         | Publish?                             |
| ------------------------------------- | ---------------- | ---------------------------------------------------- | ------------------------------------ |
| Tag on main repo with full secrets    | yes              | signed + notarized                                   | yes                                  |
| Tag on main repo with partial secrets | partial          | signed where possible, `UNSIGNED` warnings elsewhere | yes                                  |
| Tag on fork                           | no               | unsigned                                             | workflow artifacts only (no release) |
| `workflow_dispatch` manual run        | any              | follows secret presence                              | artifacts only                       |
| `nightly.yml` scheduled run           | ignored          | unsigned                                             | 7-day artifacts only                 |

Unsigned bundles are functional but the OS will refuse to launch them on
macOS without explicit Gatekeeper approval. The dry-run mode exists to
rehearse CI changes, not to ship to users.

## Troubleshooting

- **`codesign: no identity found`** — the `APPLE_SIGNING_IDENTITY` env
  var in the workflow must exactly match the Common Name of the imported
  certificate. Re-run `security find-identity -p codesigning` locally to
  confirm.
- **`xcrun notarytool: Error: Invalid credentials`** — rotate
  `APPLE_PASSWORD` (it's an app-specific password, not your AppleID
  password). Apple expires these after ~18 months.
- **`updater: signature verification failed`** — the bundled public key
  does not match the signing private key. Either regenerate the keypair
  (and bump the pubkey in `tauri.conf.json`) or re-provision the matching
  private key in secrets.
- **`Manifest gen: 0 platforms`** — the release workflow couldn't find
  bundle artifacts. Check the per-matrix job summaries for upload
  warnings; usually `tauri build` failed silently on one platform.

## Icon placeholder

The icons under `packages/host-tauri/src-tauri/icons/` are rasterized from
`assets/icon.svg` by `scripts/generate-icons.sh`. The current mark is a
stop-gap produced so `cargo tauri build` doesn't fail on an empty
`bundle.icon` array; before 1.0 a designer should replace the SVG with
the final brand asset and re-run `just generate-icons`.

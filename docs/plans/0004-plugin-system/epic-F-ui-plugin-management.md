# Epic F — UI Plugin Management

- **Parent**: `docs/rfc/0004-plugin-system.md`, `docs/plans/0004-plugin-system/README.md`
- **Depends on**: Epics A–E
- **Duration**: 2 weeks
- **Status**: Draft

Epic F delivers the user-facing Plugins tab in Settings. This is where users see what they have installed, what each plugin is allowed to do, what each plugin has recently done, and where they can revoke, disable, or remove plugins. It is also the venue for plugin-provided settings panels.

---

## 1. Goal

Ship a polished, accessible, performant Plugins tab that makes the entire plugin system legible to the user. The goal is not just "a list of plugins" but: "at a glance, understand what extensions are running in my terminal, what they can do, and what they have done."

By end of epic:

- Settings → Plugins tab with installed plugin list, per-plugin detail view, audit log view, and settings panel per plugin.
- Install-from-file UI wired (uses Epic E's bundle loader).
- Enable / disable / uninstall flows with confirmations where needed.
- Permission toggles with live revocation (uses Epic D's revoke flow).
- "Request new permissions" flow: plugin requests a permission mid-session → queued notification → user grants from the tab.
- Empty state, loading state, error state for every view.
- Full keyboard accessibility; screen-reader tested.

---

## 2. Non-goals

- Marketplace discovery UI (RFC 0004.1).
- Plugin review / rating UI (RFC 0004.1).
- Per-session plugin toggling (v1 is per-user; per-session requires a scope-design pass — deferred).
- Inline error recovery guidance beyond linking to docs.

---

## 3. Information architecture

```
Settings
├── (existing tabs…)
└── Plugins
    ├── [ + Install from file ]  [ Developer mode ▾ ]
    ├── ┌────────────────────────────────────────────┐
    │   │  kubectl-contexts    v0.1.0    [toggle]   │
    │   │  Switch kube contexts from the palette.   │
    │   │  3 permissions · 14 actions today         │
    │   └────────────────────────────────────────────┘
    ├── ┌────────────────────────────────────────────┐
    │   │  aws-cli-autocomplete  v1.2.0   [toggle]   │
    │   │  …                                         │
    │   └────────────────────────────────────────────┘
    └── …

(clicking a plugin)

Settings > Plugins > kubectl-contexts
├── Header: name, version, author, signature state
├── [ Enabled toggle ]  [ Uninstall ]
├── Tabs:
│   ├── Overview       description, README, version, links
│   ├── Permissions    category list with per-category toggles, scoping, reason
│   ├── Settings       plugin-provided schema (Epic C §4.6)
│   ├── Activity       recent audit entries (filter, export)
│   └── About          author, homepage, license, bugs
```

---

## 4. Visual design notes

- The tab follows Quanta's existing Settings typography and spacing; no custom UI kit.
- Signature state badges:
  - `Verified` — green shield, for first-party or enterprise-trusted.
  - `Trusted` — blue shield, for user-trusted keys.
  - `Self-signed` — amber shield, warning but allowed.
  - `Revoked` — red shield, plugin cannot load.
- Permission icons are reused from the install prompt so users recognise them:
  - 🌐 network
  - 📂 filesystem_read
  - ✏️ filesystem_write
  - 📋 clipboard_read / clipboard_write
  - ⚡ execute_commands
  - 💾 settings_storage
- "Managed by your organisation" plugins show a lock icon and disable all toggles.

---

## 5. Per-view details

### 5.1 Plugin list

- Sorted by user-configurable criterion (default: "Recently active"; options: "Name", "Install date").
- Filter by: enabled / disabled / managed / has warnings.
- Search across id, name, description, keywords.
- Each row shows:
  - Icon (from bundle, fallback puzzle-piece).
  - Name, version.
  - One-line description.
  - Permission count + activity-today count.
  - Toggle (on/off).
- Row is a link to the detail view.
- Keyboard: ↑/↓ navigates rows, Enter opens details, Space toggles enable.

### 5.2 Detail — Overview

- Icon + name + version + author.
- Signature badge + tooltip on hover explaining the trust state.
- Description.
- Rendered README (markdown → sanitised HTML through the same sanitiser as `richPanel`).
- Links: homepage, repository, bugs (all opened in system browser; confirmed if http and not https).
- Version history (from CHANGELOG.md if present).
- "Installed at" + "Installed from" (file path / managed / dev).

### 5.3 Detail — Permissions

One row per category the plugin declares in its manifest (even if currently revoked — shown as "declined").

Each row:

- Category icon + name.
- Scope text: "Can read `~/.kube/config`" / "Can run `kubectl`" / "Can fetch `https://*.s3.amazonaws.com`".
- Author-supplied reason (from manifest).
- Toggle: grant / revoke. Revoke takes effect immediately (uses Epic D's capability-token invalidation).
- Last-used timestamp per category (from audit log).

A "Request more permissions" notification appears if the plugin has attempted any call that returned `PermissionDenied`; clicking it opens an expansion UI where the user can grant the relevant category without re-installing.

### 5.4 Detail — Settings (plugin-provided)

- Rendered from the plugin's `settings.schema` output (Epic C §4.6).
- Each group is a collapsible section.
- Field types: string, number, boolean, enum, secret.
- Changes write through the host settings API (permission-gated behind `settings_storage` grant, which by convention any plugin with settings will have).
- Validation errors inline (per field).
- "Reset to defaults" button per group.

### 5.5 Detail — Activity

- Reverse-chron list of audit entries for this plugin (last 200; "Load more" paginates).
- Columns: timestamp, category, action, outcome, details.
- Filter by category, outcome (ok / denied / errored).
- Search by substring.
- Export: "Download log" downloads the raw `<id>.log` file; "Copy last 100" copies to clipboard.
- Each entry is expandable to show the full JSON.

### 5.6 Detail — About

- Author name + email (mailto link).
- License (linkified SPDX).
- Homepage / repository / bugs.
- Full plugin id in mono.
- Signature key fingerprint (hex, copyable).
- "Trusted at" timestamp if user-trusted.
- Developer mode section: "Copy manifest", "Copy digest", "Show bundle contents".

---

## 6. Interaction flows

### 6.1 Enable / disable

Toggle in row or detail view.

- **Disable**: host calls `_deactivate` (2 s timeout), drops store. Audit entry. UI reflects immediately.
- **Enable**: host re-instantiates the WASM/JS module, re-issues tokens, calls `_activate`. If permissions changed since last enable → delta prompt.

### 6.2 Uninstall

Confirmation modal: "Uninstall <name>? This removes the plugin and archives its activity log. Plugin settings are deleted."

- On confirm: disable first if enabled; delete plugin directory; archive audit log (Epic D §5.3); delete grants; delete settings.
- Toast on completion: "Uninstalled <name>."

### 6.3 Update flow

At launch, Quanta checks the managed-plugins directory for new bundles. (Remote-update feed for user-installed plugins is tracked as RFC 0004.1.)

For each user-installed plugin, a manual "Check for update" button is present in the detail view. v1 flow:

- User clicks "Check for update" → opens the plugin's homepage in the system browser.
- User downloads a new `.quanta-plugin` and installs via file picker.
- Install detects same `id`, different `version`. If permissions unchanged: silent upgrade. If changed: delta prompt.

### 6.4 Permission-denied nudge

When a plugin call hits `PermissionDenied` (Epic D), the host emits a `plugin_permission_denied` event. The UI increments a per-plugin counter; if it crosses 3 denials in 60 s, a toast appears: "Plugin X is asking for permissions you haven't granted. Open Plugins settings?" Clicking opens the permissions tab for that plugin with the relevant categories highlighted.

### 6.5 Crash nudge

When the host auto-disables a plugin after 3 strikes (Epic B), a toast appears: "Plugin X was disabled due to repeated failures. Open details?" Clicking goes to the plugin's detail view with the Activity tab focused and a red banner at the top.

### 6.6 Signature-warning banner

If the plugin is signed by an unknown key and the user previously accepted it, a subtle banner in the detail view reminds them: "This plugin is signed by a developer you chose to trust on <date>."

If the key is revoked, a big red banner: "The developer's signing key has been revoked. This plugin is disabled. Uninstall recommended."

---

## 7. Developer mode

Visible only when `QUANTA_PLUGIN_DEV=1` or when the user enabled "Developer mode" from the Plugins tab header.

- Shows plugins under `$APP_CONFIG_DIR/plugins-dev/` with a `[dev]` tag.
- Shows additional columns in the list: last reload time, build errors (if any).
- Adds a "Reload" button per dev plugin.
- Shows the plugin's raw console output in the Activity tab's "Dev log" sub-tab.

---

## 8. States (every view)

Each of the views above supports:

- **Empty**: "You have no plugins installed. [Install from file] or learn more about plugins."
- **Loading**: skeletons while the host enumerates plugins or the bundle unpacks.
- **Error**: scoped to the failing operation. E.g. "Couldn't load plugin <name>: invalid manifest. [Show details]". Details open the raw error.
- **Managed**: read-only banner across relevant toggles.

---

## 9. Accessibility

- All toggles have descriptive labels (`aria-label="Enable kubectl-contexts"`).
- Icons are decorative; category meaning is conveyed in text.
- Focus order is top-to-bottom, left-to-right; never traps.
- Shortcut: `Cmd/Ctrl+,` opens Settings; typing "plugins" filters to this tab.
- High-contrast mode: signature badges keep distinct shapes (shield / crossed shield) so colour isn't sole indicator.
- Screen-reader pass: tested against macOS VoiceOver, Windows NVDA, Linux Orca; live regions for toast notifications.
- Reduced motion: toggles without easing; skeletons without shimmer.

---

## 10. Performance

- Initial render of the Plugins tab for 50 installed plugins: ≤ 80 ms on a mid-range laptop.
- Detail view load: ≤ 50 ms (data already in memory; audit log read is streamed).
- Audit log rendering: virtualised list; no frame drop at 10 000 entries.
- Search is debounced 120 ms; case-insensitive substring match.

---

## 11. Telemetry (local-only)

Counters:

- Plugins tab opens.
- Install from file success / failure.
- Enable / disable toggles.
- Permission grants / revokes.
- Uninstalls.

All counters are local-only and aggregate; no plugin names or user content are recorded.

---

## 12. Work breakdown

### Sprint 1 (week 1)

- **F-1.1** Plugin list view with filter/sort/search.
- **F-1.2** Detail shell with tab routing.
- **F-1.3** Overview tab (README rendering, header, metadata).
- **F-1.4** Permissions tab with per-category toggles wired to Epic D.
- **F-1.5** Enable / disable flow.
- **F-1.6** Uninstall flow with confirmation.
- **F-1.7** Install from file (drag-and-drop + file picker).

### Sprint 2 (week 2)

- **F-2.1** Settings tab rendering plugin-provided schema.
- **F-2.2** Activity tab with virtualised list + filters + export.
- **F-2.3** About tab.
- **F-2.4** Developer mode surface.
- **F-2.5** Nudge toasts (perm-denied, crash, revoked key).
- **F-2.6** Empty / loading / error states for each view.
- **F-2.7** Accessibility pass (keyboard, screen-reader, high contrast, reduced motion).
- **F-2.8** Visual polish + docs.

---

## 13. Testing

### 13.1 Component tests

- Snapshot tests for each view (empty / loaded / error).
- Interaction tests: enable, disable, grant, revoke, uninstall.
- Keyboard navigation tests.

### 13.2 Integration tests

- Mount Settings, load 3 plugins via the real host, interact.
- Audit log streaming test: plugin emits 1000 events → UI renders without jank.
- Permission delta flow: install v0.1 → update to v0.2 with new perm → prompt → grant → live reload.

### 13.3 Visual regression

- Screenshot tests for each view; diff against baseline.
- Tested on light and dark theme.

### 13.4 Accessibility tests

- axe-core runs on each view, zero critical violations.
- Manual screen-reader pass on each view before GA.

### 13.5 Hostile-plugin UX tests

- Plugin with an intentionally huge README (truncated to 64 KiB rendering, "show more" link).
- Plugin with a malformed icon (fallback).
- Plugin that declares 20 permission categories (none accepted; prompt scrolls gracefully).
- Plugin with a 10 000-entry audit log (virtualised list scrolls smoothly).

---

## 14. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Audit log rendering janks with many entries | Virtualised list; lazy JSON parse per row. |
| Permission toggles are hard to read (too many) | Group by "granted / not granted"; show scopes compactly; progressive disclosure via "Show details". |
| Users disable plugins accidentally | Toggle is reversible; clear confirmation only for uninstall. |
| Plugin settings schema is hostile (e.g. huge enum) | Schema validator in Epic A; Plugins tab falls back to "Schema unavailable" on validation failure. |
| Developer mode accidentally enabled for end users | Off by default; requires env var or explicit toggle; clear visual affordance. |

---

## 15. Acceptance criteria

- [ ] Plugins tab ships as the last Settings tab.
- [ ] Plugin list, detail view, 5 sub-tabs all render.
- [ ] Enable / disable / uninstall flows work.
- [ ] Per-category permission toggles invalidate capability tokens live.
- [ ] Audit log renders smoothly up to 10 000 entries.
- [ ] Install from file works via DnD, file picker, and CLI.
- [ ] Nudge toasts fire on denied, crash, and revocation events.
- [ ] Developer mode exposed and tested.
- [ ] a11y pass: zero axe-core critical violations.
- [ ] Visual regression baseline green.

---

## 16. Change history

| Date | Author | Change |
| --- | --- | --- |
| 2026-04-20 | Platform Team | Initial epic plan. |

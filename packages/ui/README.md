# @quanta/ui — Host-Agnostic React UI

Quanta Terminal's UI. Host-agnostic: one React codebase boots into the Tauri
desktop host (`@quanta/host-tauri`), future VS Code host, and any other host
that supplies a `HostBridge` implementation per
[ADR 0001](../../docs/adr/0001-host-modes.md).

Architecture follows **Feature-Sliced Design** per
[ADR 0014](../../docs/adr/0014-frontend-architecture.md). Layering is enforced
by `tools/check-fsd-layers.mjs` (run via `pnpm check:layering`).

## Layer map

```
app/        bootstrap.tsx           Mounts React; owns the root error boundary.
            providers/              StrictMode and future top-level providers.

pages/      terminal-page/          The one Phase-1 route. Composes chrome.

widgets/    title-bar/              Frameless window chrome.
            banner-host/            ADR-0010 banner precedence renderer.
            terminal-canvas/        Custom Rust VT engine surface (RFC 0001).
            composer/               Multi-line command input.
            status-bar/             cwd/shell/health chips.
            session-tabs/           Phase-1 single-session placeholder.
            command-palette/        Cmd/Ctrl+K overlay.

features/   session/connect        Single subscriber bridge → store.
            banner/detect          Session→banner detector.
            composer/submit        Composer → bridge.write.

entities/   session                Session store (zustand + selectors).
            banner                 Banner active/dismissed sets.
            event                  HostEvent domain entity.

shared/     api/                   Bridge accessor (only reader of the global).
            config/                Tokens, fonts, app.css.
            lib/                   logger, keymap, focus-trap, debounce,
                                   write-batcher, perf, cx, base64,
                                   event-bus, banner-precedence.
            types/                 CSS-module decls + generated wire types.
            ui/                    Primitives: badge, banner, button,
                                   error-boundary, kbd, separator, spinner,
                                   tooltip.
```

## FSD layering rules (summary)

- `shared/` may not import any other layer.
- `entities/` may import `shared/`.
- `features/` may import `entities/`, `shared/`.
- `widgets/` may import `features/`, `entities/`, `shared/`.
- `pages/` may import all of the above.
- `app/` orchestrates the page tree and mounts React.
- No cross-slice imports within a layer (e.g. one widget cannot import another
  widget's internal modules — use the page to compose them).

Run `pnpm check:layering` at the repo root to verify.

## Primary public surface

```ts
import { bootstrapUi, setHostBridge, getHostBridge } from '@quanta/ui';
```

- `bootstrapUi({ root, bridge, onReport? })` — mount React at `root` with the
  supplied `HostBridge`. The root is wrapped in an `ErrorBoundary`; `onReport`
  is invoked when the user clicks "Report" in the fallback.
- `setHostBridge(bridge)` — injection helper (used internally by `bootstrapUi`).
- `getHostBridge()` / `tryGetHostBridge()` — read the installed bridge.

## Primitives (shared/ui)

| Primitive       | Variants                            | Notes                                     |
| --------------- | ----------------------------------- | ----------------------------------------- |
| `Badge`         | tone: neutral/accent/warning/danger | Inline chip, optional srDescription.      |
| `Banner`        | kind: info/warning/danger           | ADR-0010 session strip. Dismiss optional. |
| `Button`        | variant: default/primary/ghost      | Focus-visible + forced-colors aware.      |
| `ErrorBoundary` | —                                   | Render-time fallback with Reload/Report.  |
| `Kbd`           | —                                   | Keyboard-shortcut chip.                   |
| `Separator`     | horizontal/vertical                 | 1px rule.                                 |
| `Spinner`       | size: sm/md                         | Indeterminate; honors reduced-motion.     |
| `Tooltip`       | —                                   | Hover/focus tooltip with small offset.    |

## Testing

```
pnpm --filter @quanta/ui test       # vitest (jsdom) run
```

Widgets mount against stubbed bridges; no live Tauri IPC is required. Schema
parity with the Rust proto crate is enforced in `@quanta/host-common`.

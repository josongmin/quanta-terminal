# @quanta/host-tauri — Mode B Desktop Host

Tauri 2 desktop shell for Quanta Terminal. Mode B per [ADR 0001](../../docs/adr/0001-host-modes.md);
priority host for Phase 1.

## Running locally

From the repo root:

```
pnpm install
pnpm dev      # -> runs `pnpm --filter @quanta/host-tauri dev` -> `tauri dev`
```

`tauri dev` spins up the Vite dev server on `http://localhost:1420`, builds the
Rust crate in `src-tauri`, and opens the window. First launch compiles Tauri
dependencies and may take several minutes.

## Phase-1 embedded shell (DEV STUB)

Until the real `quanta-core` sidecar (ADR 0004) ships, the Tauri crate ships
with a `default = ["embedded-shell"]` feature that spawns a shell directly via
[`portable-pty`](https://docs.rs/portable-pty) inside the desktop process.

This is a marked stub, not a plan:

- the feature flag is named `embedded-shell`
- the module is `src-tauri/src/embedded_shell.rs` with a "DEV STUB, MARKED FOR
  REMOVAL" banner
- the IPC shape already matches the sidecar's future JSON-RPC surface, so the
  swap is a one-file rewrite of `ipc.rs`

When the sidecar lands, drop the feature and the module, and rewire the
commands to speak JSON-RPC over a Unix socket.

## OS-level prerequisites

Tauri has native dependencies outside `pnpm`:

- **macOS** — Xcode Command Line Tools (`xcode-select --install`). WebKit is
  provided by the OS.
- **Linux** — a WebKitGTK stack. On Debian/Ubuntu:
  ```
  sudo apt install libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev build-essential curl wget file
  ```
  On Fedora:
  ```
  sudo dnf install webkit2gtk4.1-devel openssl-devel gtk3-devel libappindicator-gtk3-devel librsvg2-devel
  ```
- **Windows** — Not a Phase-1 target. Building is expected to work but is not
  tested; shells spawned via the embedded stub do not have POSIX semantics.

Rust is pinned by `rust-toolchain.toml` at the repo root. Node ≥ 20 and pnpm 9.

## Window chrome

The window is decoration-less (`decorations: false`) on macOS with the native
traffic-light overlay. The React `TitleBar` widget reserves a 72px cutout for
the system buttons and exposes the remainder as a drag region
(`[data-tauri-drag-region="true"]`).

## IPC surface

Commands (Tauri `invoke`):

| Command                  | Payload                                         | Returns                      |
| ------------------------ | ----------------------------------------------- | ---------------------------- |
| `quanta_ready`           | —                                               | `()`                         |
| `quanta_spawn_session`   | `{ args: { shell, cwd, cols, rows, env }}`      | `{ session_id, shell, cwd }` |
| `quanta_write`           | `{ sessionId, data }`                           | `()`                         |
| `quanta_resize`          | `{ sessionId, cols, rows }`                     | `()`                         |
| `quanta_close`           | `{ sessionId }`                                 | `()`                         |
| `quanta_open_in_editor`  | `{ args: { path, line, column }}`               | `()` / `Err(String)`         |

Events (Tauri `listen`):

| Topic                | Payload                             |
| -------------------- | ----------------------------------- |
| `quanta://pty-data`  | `{ session_id, seq, bytes_b64 }`    |
| `quanta://pty-exit`  | `{ session_id, exit_code, signal }` |

**Event-name convention**: topics use a hyphen in the trailing segment
(`quanta://pty-data`, not `quanta://pty.data`). Tauri 2 warns on `.` in event
names; both the TS listener and the Rust emitter are pinned on the hyphenated
form via `ipc::EVENT_PTY_DATA` / `EVENT_PTY_EXIT` constants.

The TypeScript bridge in `src/bridge.ts` is the only code that depends on this
surface. If you change a command or topic, that is the file you update.

### `quanta_open_in_editor` behavior

Resolves an editor from a hardcoded chain on every call:

1. `code` (VS Code) on `PATH`
2. `cursor` on `PATH`
3. `subl` (Sublime) on `PATH`
4. `$VISUAL` / `$EDITOR` — only the first token is honored, only when it is a
   bare binary name that resolves via `PATH`. Absolute paths, shell pipelines,
   and multi-token values are rejected to close the `EDITOR="sh -c …"` vector.

The command always spawns with `Command::new(editor).arg(…)` — **never
`sh -c`**. User strings never cross into a shell interpreter. `validate_editor_path`
rejects empty input, control characters, `\n`/`\r`, and NUL before we touch
the spawn path; `is_absolute()` enforces that only fully-resolved paths reach
the command line (the TS layer is responsible for resolving relative paths
against the session cwd first — see `features/navigation/open-in-editor`).

## End-to-end smoke walkthroughs

See the "End-to-end smoke walkthroughs" section in the repo-root
[`TESTING.md`](../../TESTING.md#end-to-end-smoke-walkthroughs) for the
mock-bridge (browser dev, no Tauri) and Tauri real-bridge (`embedded-shell`
feature) walkthroughs.

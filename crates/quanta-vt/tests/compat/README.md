# `crates/quanta-vt/tests/compat/` — Golden Compat Fixtures

One directory per compat program. Each directory holds five files:

| File | Purpose |
|------|---------|
| `input.pty` | Raw PTY byte stream. Fed verbatim into `Grid::feed`. |
| `scenario.md` | Human description: what produced these bytes, expected observable state. |
| `expected_grid_snapshot.json` | Canonical grid dump at end-of-feed. Diffed cell-by-cell. |
| `expected_cursor.json` | Final `CursorPayload` — row, col, visibility, shape, pending-wrap. |
| `expected_modes.json` | Final `TerminalModeState` — DECCKM, bracketed-paste, mouse protocol, alt-screen, SUM, etc. |

Consumed by `crates/quanta-vt/tests/compat_harness.rs`. Each fixture
directory is one `#[test]` that reads the five files, feeds `input.pty`
through a fresh 24x80 `Grid`, and byte-for-byte compares the three
expected files.

## Provenance status (current pass)

The fixtures under this directory were **synthesised inline**: their
`input.pty` files are hand-constructed escape sequences that exercise a
targeted feature of the engine. They do **not** come from a recording
of a real program yet — see `VERSIONS.md` for the explicit status.

The full RFC §13.9 MUST corpus (vim, nvim, less, nano, htop, btop, top,
man, ranger, mc, tmux, vim-in-tmux, ssh-loopback, ncmpcpp) is scheduled
for a follow-up recording pass using `scripts/record-compat-stream.sh`
on a host with a live terminal. The harness is fixture-agnostic; it
discovers subdirectories of this folder at test-compile time, so adding
a real recorded fixture is "drop the five files and add one line to the
harness test list".

## Fixture catalog (current pass — synthetic)

| Fixture | Exercises |
|---------|-----------|
| `hello_world/` | Plain ASCII text + newline. The smoke test that proves the pipeline. |
| `bold_text/` | SGR 1 (bold) + SGR 0 reset. Attribute end-state. |
| `wrap_korean/` | Korean (한글) text forcing DECAWM soft-wrap; continuation flag invariant. |
| `alt_screen_enter_exit/` | DECSET 1049 → content → DECRST 1049. Alt-screen buffer + mode ordering. |
| `cursor_save_restore/` | ESC 7 / ESC 8 (DECSC/DECRC). Cursor position preserved across motion. |
| `scroll_region/` | DECSTBM `CSI 3;10 r` + scrolling-only-inside-region. |

## How the harness reads a fixture

```rust
let fixture_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("tests/compat")
    .join(name);

let input = fs::read(fixture_dir.join("input.pty"))?;
let expected_grid: GridSnapshot =
    serde_json::from_str(&fs::read_to_string(fixture_dir.join("expected_grid_snapshot.json"))?)?;
let expected_cursor: CursorPayload = /* ... */;
let expected_modes: TerminalModeState = /* ... */;

let mut grid = Grid::new(24, 80, 10_000, classifier());
let _events = grid.feed(&input);

assert_eq!(grid.snapshot(), expected_grid);
// also cursor + modes
```

## Authoring a new fixture (the synthetic path used in this pass)

1. Choose a short name that describes the feature (`hello_world`,
   `cursor_save_restore`, …).
2. `mkdir crates/quanta-vt/tests/compat/<name>/`.
3. Write `input.pty` as the raw escape-sequence bytes. Binary files are
   committed verbatim; the harness reads them as `Vec<u8>`.
4. Write `scenario.md` with: title, precondition, steps, expected
   observable state. Mirror the shape of the existing scenarios.
5. **Bless** the expected JSONs. From the repo root:

   ```sh
   QUANTA_VT_BLESS=1 cargo test -p quanta-vt --test compat_harness
   ```

   With `QUANTA_VT_BLESS` set, the harness writes the three expected
   files from the live engine's output and the test passes. With it
   **unset** (the default), the harness strictly compares and fails on
   any mismatch.
6. Inspect the generated files; if they match your intent, commit. If
   not, fix `input.pty` and re-bless.
7. Add the fixture name to the harness list in
   `crates/quanta-vt/tests/compat_harness.rs`.

## Authoring a new fixture (the recorded path, deferred)

For recording real programs (vim, tmux, htop, …):

1. Read the pre-recording checklist in Appendix C of
   `docs/plans/0001-custom-vt-engine-xterm-removal/epic-G-compat-matrix.md`.
2. On a host with the target program and a real terminal:

   ```sh
   scripts/record-compat-stream.sh vim \
     --version 9.0 \
     --scenario vim-basic-edit-save \
     --out crates/quanta-vt/tests/compat/vim/
   ```
3. The script exports the fixed capture environment (TERM, LINES,
   COLUMNS, TZ, LANG, HOME=tempdir), invokes `script(1)`, strips the
   framing, and drops `input.pty` into the fixture directory.
4. Bless the expected JSONs as above.
5. Append a row to `VERSIONS.md` (the script does this automatically).

## Gap reports

Any harness mismatch writes `compat-gap/<program>_<timestamp>.report`.
See `compat-gap/README.md` + `TEMPLATE.md` for triage workflow.

## Related docs

- `docs/plans/0001-custom-vt-engine-xterm-removal/epic-G-compat-matrix.md` — the full design.
- `docs/rfc/0001-custom-vt-engine-xterm-removal.md` §13.9 / §13.10 — the RFC contract.
- `scripts/record-compat-stream.sh` — recording tooling.
- `tests/integration/tests/compat_scripted.rs` — the scripted-interactive runner that complements golden replay.

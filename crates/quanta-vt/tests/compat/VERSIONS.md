# Compat fixture provenance (`VERSIONS.md`)

One row per `(program × capture)`. Every row pins:

- `Program` — matches the fixture subdir name.
- `Version` — the program's `--version` string or equivalent. `synthetic`
  for inline-constructed byte streams that do not come from a real
  program.
- `Host OS` — recording host (`macOS 14.5 arm64`, `Ubuntu 22.04 x86_64`,
  …) or `synthetic` if no host was involved.
- `Locale` — `LANG` value at capture time (`en_US.UTF-8` by default;
  `ko_KR.UTF-8` / `ja_JP.UTF-8` / `zh_CN.UTF-8` for CJK scenarios).
- `Date` — UTC date of capture (`YYYY-MM-DD`).
- `Recorder` — GitHub handle or initials of the engineer who recorded.
- `Notes` — short provenance / caveat.

`scripts/record-compat-stream.sh` appends a row automatically on every
recording.

## Recorded fixtures (real programs)

**Status: TBD — no recorded fixtures in this pass.**

Recording real programs (vim, nvim, less, nano, htop, btop, top, man,
ranger, mc, tmux, vim-in-tmux, ssh-loopback, ncmpcpp) requires a live
terminal on the capture host. The EPIC-G plan
(`docs/plans/0001-custom-vt-engine-xterm-removal/epic-G-compat-matrix.md`)
scopes this to a follow-up pass by an engineer with access to:

- a 24×80 terminal window or `TERM=xterm-256color` PTY;
- each program installed at a pinned version;
- `faketime` for clock-dependent programs (`top`, `htop`);
- `sshd` on localhost for `ssh-loopback`.

The harness is ready to consume those fixtures as soon as they land —
drop the five files (`input.pty`, `scenario.md`,
`expected_grid_snapshot.json`, `expected_cursor.json`,
`expected_modes.json`) into a new subdirectory and add one line to
`compat_harness.rs`.

## Synthetic fixtures (current pass)

The following fixtures are hand-constructed byte streams that exercise
specific engine invariants. They are **not** captured from any real
program; they are goldens blessed by running the current engine on a
known input and committing the output.

| Program | Version | Host OS | Locale | Date | Recorder | Notes |
|---------|---------|---------|--------|------|----------|-------|
| hello_world | synthetic | synthetic | en_US.UTF-8 | 2026-04-19 | @epic-g | `echo hello\n` equivalent; baseline smoke. |
| bold_text | synthetic | synthetic | en_US.UTF-8 | 2026-04-19 | @epic-g | SGR 1 / SGR 0 round-trip. Avoids `Color::Palette8` due to upstream serde tagged-newtype-with-primitive limitation. |
| wrap_korean | synthetic | synthetic | ko_KR.UTF-8 | 2026-04-19 | @epic-g | DECAWM wrap with wide CJK. |
| alt_screen_enter_exit | synthetic | synthetic | en_US.UTF-8 | 2026-04-19 | @epic-g | DECSET/DECRST 1049; mode ordering invariant. |
| cursor_save_restore | synthetic | synthetic | en_US.UTF-8 | 2026-04-19 | @epic-g | ESC 7 / ESC 8 (DECSC/DECRC). |
| scroll_region | synthetic | synthetic | en_US.UTF-8 | 2026-04-19 | @epic-g | DECSTBM 3;10 + fill past region. |

## Adding a recorded fixture

1. Run `scripts/record-compat-stream.sh <program> --version <v> --out crates/quanta-vt/tests/compat/<program>/`.
   The script appends a row to this file automatically.
2. Verify the row has all fields populated. Manually fill `Notes` if
   the script left it blank (it's a free-form field).
3. Re-bless the expected JSONs via
   `QUANTA_VT_BLESS=1 cargo test -p quanta-vt --test compat_harness`.
4. Commit the fixture directory + the updated `VERSIONS.md`.

## Related docs

- `README.md` (this directory) — fixture authoring workflow.
- `docs/plans/0001-custom-vt-engine-xterm-removal/epic-G-compat-matrix.md` §4.7 — the `VERSIONS.md` contract.
- `scripts/record-compat-stream.sh` — the append-on-record tool.

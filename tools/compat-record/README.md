# compat-record

Future CLI for recording **compat fixtures** from a live PTY.

**Status:** not yet implemented. Tracked under Plan 0005 Epic ε §6.

## What it will do

Spawn a target program inside a real PTY, tee every byte the PTY emits
into an `input.bytes` file, and let the author mark **checkpoints**
interactively as the scenario plays out. The output is the same fixture
layout consumed by
`packages/ui/src/__tests__/compat/compat-replay.ts`:

```
fixtures/compat/<ID>/
  input.bytes
  checkpoints.json
  meta.json
  README.md
```

## Planned invocation

```sh
tools/compat-record/record.sh \
  --id C-ED-02 \
  --shell zsh \
  --cols 80 --rows 24 \
  --out packages/ui/fixtures/compat/C-ED-02 \
  -- vim /tmp/sample.txt
```

Interactive session: the tool prints a `checkpoint> ` prompt on a side
channel while the program runs; the author types descriptions to mark
the current byte offset.

## Why not now?

P0 scope is the **replay** path — prove fixtures can be replayed
deterministically. Recording requires a cross-platform PTY wrapper
(`node-pty` on the Node side, platform-specific on Rust), terminfo
probing, and a resize-event recorder. All of that is out of scope for
ε's scaffolding milestone. The synthetic `C-ED-01` fixture proves the
replay path works end-to-end without a recording tool.

## Stub script

`record.sh` in this directory exits with status 1 and a "not yet
implemented" message, so CI / docs that reference the tool fail loudly
rather than silently.

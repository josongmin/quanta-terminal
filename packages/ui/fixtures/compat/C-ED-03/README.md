# C-ED-03: vim `:!bash` nested subshell

**Status:** synthetic (hand-authored byte stream).

## What this fixture asserts

Vim spawns a nested bash via `:!bash`. The inner bash runs INSIDE vim's
alt buffer — there is NO nested 1049h/1049l pair. The critical
contract:

**`alt_screen` flips exactly ONCE on the outer DECSET 1049h and stays
`true` across the entire inner-bash lifecycle. It only flips back to
`false` when vim itself exits on `:q!`'s DECSET 1049l.**

Any extra flip would mean the engine is treating the inner shell as its
own alt-screen cycle, which would break block semantics and corrupt the
main-buffer scrollback.

## Scenario

1. Main: `$ vim file.txt\r\n`.
2. DECSET 1049h. Vim paints tildes + status line.
3. Vim shows `:!bash` on the status line (after CSI K).
4. Vim delegates the screen to inner bash. `echo hi` runs, output
   prints, fresh prompt parked.
5. Bash exits. Vim repaints its UI (tildes + status back).
6. DECSET 1049l. Main buffer restores with the pre-entry command.
7. Shell reprints `$ `.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | 235 bytes |
| `checkpoints.json` | 8 checkpoints — two of which assert the alt-screen invariant |
| `meta.json` | cols=40, rows=8 |
| `build-fixture.mjs` | Regenerator |

# C-ED-02: nvim + LSP diagnostic overlay

**Status:** synthetic (hand-authored byte stream). Will be replaced by a
real `nvim` recording once `tools/compat-record` lands (Plan 0005
Epic ε §6).

## What this fixture asserts

Extends the C-ED-01 alt-buffer contract with two render-side guarantees
nvim + LSP depend on:

1. **Reverse-video status bar** — `/tmp/hello.ts` painted with SGR 7,
   followed by SGR 0 reset. The `sgrDigest` on the status row asserts
   the inverse attribute is preserved byte-for-byte.

2. **LSP diagnostic marker** — a single character (`4` in `42`) is
   repainted with SGR 48;5;203 (256-colour red bg). The `sgrDigest` on
   the diagnostic row asserts the red bg survives the alt-buffer round
   trip without being dropped or merged with neighbours.

Scenario step-by-step:

1. Shell prompt `$ nvim /tmp/hello.ts\r\n`.
2. DECSET 1049h (enter alt) + clear + home.
3. Paint 5 TypeScript rows; row 2 is `const x: string = 42;` (type
   error).
4. Repaint the `4` at col 18 with SGR 48;5;203.
5. Status line on last row with `/tmp/hello.ts` in reverse video.
6. DECSET 1049l; post-exit prompt.

## Files

| File | Purpose |
|---|---|
| `input.bytes` | Raw PTY byte stream (~174 bytes) |
| `checkpoints.json` | 6 checkpoints — alt entry, code paint, diagnostic SGR, status SGR, 1049l restore, post-exit |
| `meta.json` | cols=40, rows=7, synthetic zsh-like |
| `build-fixture.mjs` | Generator script (deterministic; re-run anytime) |

## Why synthetic?

Real nvim emits ~2–4 KiB of terminfo/termcap negotiation before the
first paint, plus 300+ bytes of LSP extmark/highlight SGR that varies
by colourscheme. The structural assertions (alt buffer + SGR survival)
don't depend on any of that. A 174-byte hand stream is fully reviewable
in `build-fixture.mjs`.

## Epic dependency

Green post Epic α (alt buffer + DECSET 1049 + SGR state).

# check-one-render-path

Enforces Plan 0005 invariant **I-11**: the cell renderer is the only module
that paints character data.

## What it rejects

Any source file under `packages/ui/src/` that imports from
`shared/lib/ansi-parser/*` (via either the `@ui/shared/...` alias or a
relative path) and is not on the allowlist.

## Allowlist

- `packages/ui/src/shared/lib/ansi-parser/**` — the module itself.
- `packages/ui/src/shared/ui/ansi-output/**` — legacy span renderer.
  **TODO(epic-delta):** remove once block-UX P1 ships and the legacy renderer
  is deleted.
- Any `__tests__/**` directory — tests may exercise the parser directly.
- Any directory segment equal to `p1-block-ux` — P1 flag-gated work.

## How to run

From the repo root:

```sh
pnpm check:render-path
```

Exit code `0` = clean, `1` = violations, `2` = fatal error.

## How to add allowlist entries

Edit `isAllowlisted()` in `index.mjs`. Prefer adding a path prefix or a
single directory segment match; do **not** add per-file exemptions.

## Self-test

```sh
node --test tools/check-one-render-path/__tests__/rule.test.mjs
```

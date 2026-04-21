# check-one-input-path

Enforces Plan 0005 invariant **I-12**: only `features/input/` and the single
session input surface may write bytes to the PTY bridge.

## What it rejects

Any source file that invokes any of these call patterns and is not on the
allowlist:

- `bridge.write(`
- `connection.write(`
- `sessionConnection.write(`
- `connectedSession.write(`

## Allowlist

- `packages/ui/src/features/input/**`
- `packages/ui/src/features/session/SessionInputSurface.tsx` (future file)
- `packages/ui/src/features/session/connect.ts` — the wrapper that enforces
  the degraded-gate; its `write` implementation **is** the sink.
- `packages/ui/src/features/tui/TuiInputSurface.tsx` — legacy.
  **TODO(epic-beta):** remove once the new session input surface lands.
- `packages/ui/src/features/session-tabs/**` — exposes
  `getSessionConnection().write` wrapper.
- Any `__tests__/**` or `fixtures/**` directory.
- Anything under `tools/` or `docs/`, and any `*.md` file.

## How to run

```sh
pnpm check:input-path
```

Exit code `0` = clean, `1` = violations, `2` = fatal error.

## How to add allowlist entries

Edit `isAllowlisted()` in `index.mjs`. Prefer a single explicit file path
over a broad directory — the intent is to keep this list short.

## Self-test

```sh
node --test tools/check-one-input-path/__tests__/rule.test.mjs
```

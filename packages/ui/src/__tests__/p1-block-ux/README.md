# P1 Block UX tests

Plan 0005 Epic δ — tests in this directory exercise widgets and features
that are gated behind `flag.blockUx === true`. The P0 default shipping
surface is a plain grid (no BlockList, no Composer, no BlockCard), so any
test that depends on the block presentation layer lives here.

## Convention

Every test in this directory MUST enable the `blockUx` flag before
rendering. Either:

```ts
import { beforeEach } from 'vitest';
import { setFeatureFlag, resetFeatureFlags } from '../../shared/config/feature-flags.js';

beforeEach(() => {
  setFeatureFlag('blockUx', true);
});

afterEach(() => {
  resetFeatureFlags();
});
```

or — if the test renders `<TerminalPage />` and needs the flag read at
mount — make sure the `beforeEach` runs BEFORE the render call.

## What lives here

- BlockCard / BlockTagStrip tests
- BannerHost tests that assert shell_integration banner contents
- Composer submit E2E flows
- Command-correction / "did you mean?" hint flows
- AI explain flows (block-scoped)
- Any test that inspects `block.outputChunks`

## What does NOT live here

- Engine / VT emulator tests (always-on)
- SessionInputSurface + KeymapGuard (always-on)
- Grid mirror / cell renderer (always-on)
- Paste safety at the input-host layer (always-on)
- IME flows (always-on)

See `docs/plans/0005-sota-convergence/migration-checklist.md` §1 for the
full disposition matrix.

# check-no-block-chunks-in-render

Enforces the post-P0 block migration: `block.outputChunks` is owned by the
block entity and only read inside the P1 block-UX widgets.

## Modes

- **warn-only (default):** every hit outside the hard-allowed set is logged
  as a warning. CI does not fail. Pre-P0 codebase can still land.
- **strict** (`--strict`): every hit outside the hard-allowed set is an
  error. Flip to strict in CI once Epic δ has burned down the transitional
  list.

The rule partitions hits into two buckets in either mode:

- **FORBIDDEN** — a hit from a path that was never supposed to read
  `outputChunks`. If the tree is clean at strict time, this should be zero.
- **TRANSITIONAL** — a hit from a pre-approved migration-in-progress path.
  Expected to shrink to zero as Epic δ lands.

```sh
pnpm check:no-block-chunks              # warn-only
pnpm check:no-block-chunks -- --strict  # strict (CI after Epic δ)
```

## Allowlist

### Hard-allowed (always clean)

- `packages/ui/src/entities/block/**` — the entity owns the field.
- `packages/ui/src/widgets/block-card/**`
- `packages/ui/src/widgets/block-list/**`
- `packages/ui/src/widgets/block-filter-bar/**`
- Any `__tests__/**` directory and any `p1-block-ux` directory segment.

### Soft-allowed (flagged transitional)

- `packages/ui/src/features/block/**`
- `packages/ui/src/features/output-search/**`
- `packages/ui/src/features/ai-explain/**`
- `packages/ui/src/features/secret-detect/**`
- `packages/ui/src/features/compose/**`
- `packages/ui/src/features/block-filter/**`
- `packages/ui/src/features/command/**`
- `packages/ui/src/widgets/composer/**`

These are expected to shrink to zero as Epic δ lands.

## How to add allowlist entries

Edit `isHardAllowed` / `isSoftAllowed` in `index.mjs`. When moving a module
from soft to hard allowlist, leave a short note in the plan's migration
checklist referencing the commit.

## Self-test

```sh
node --test tools/check-no-block-chunks-in-render/__tests__/rule.test.mjs
```

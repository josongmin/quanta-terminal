/**
 * `features/open-url` — confirm-then-open flow for plain-text URLs detected
 * in block output. See `open-url.ts` for the call graph.
 */

export {
  openExternalUrl,
  canonicaliseForOpen,
  setOpenUrlConfirm,
} from './open-url.js';
export type {
  OpenUrlInput,
  OpenUrlOutcome,
  ConfirmFn,
} from './open-url.js';

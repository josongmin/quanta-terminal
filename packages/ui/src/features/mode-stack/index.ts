/**
 * Public surface for `features/mode-stack`.
 *
 * Plan 0005 §P1-D — ModeStack polish.
 *
 * Modules:
 *   - `mode-stack-store` — the zustand store + policy resolvers.
 *   - `drivers/*`        — one file per layer kind; each driver owns push/
 *                          pop of its kind in response to stream events.
 *   - `use-alt-screen-mode-shim` — backward-compatible hook that projects
 *                          the stack down to the legacy `{active, depth, ...}`
 *                          shape so pre-P1-D consumers keep working.
 */

export {
  useModeStackStore,
  useModeStack,
  useTopmostLayer,
  useResolvedPolicies,
} from './mode-stack-store.js';

export type {
  LayerKind,
  InputPolicy,
  MousePolicy,
  RenderHint,
  ModeLayer,
  ModeLayerHints,
  ModeStack,
  ModeStackState,
  ModeStackActions,
} from './mode-stack-store.js';

export { createAltScreenDriver } from './drivers/alt-screen-driver.js';
export { createMultiplexerDriver } from './drivers/multiplexer-driver.js';
export { createPagerDriver } from './drivers/pager-driver.js';
export { createReplDriver } from './drivers/repl-driver.js';
export { createNestedShellDriver } from './drivers/nested-shell-driver.js';

export type { Driver, ModeStackHandle } from './drivers/types.js';
export type {
  AltScreenDriverOptions,
} from './drivers/alt-screen-driver.js';
export type {
  MultiplexerDriver,
  MultiplexerDriverOptions,
} from './drivers/multiplexer-driver.js';
export type { PagerDriver, PagerDriverOptions } from './drivers/pager-driver.js';
export type { ReplDriverOptions } from './drivers/repl-driver.js';
export type {
  NestedShellDriver,
  NestedShellDriverOptions,
} from './drivers/nested-shell-driver.js';

export { useAltScreenModeFromStack } from './use-alt-screen-mode-shim.js';

export { installModeStack } from './install.js';
export type {
  InstallModeStackOptions,
  InstalledDrivers,
  ModeStackDriverFlag,
  ModeStackInstallHandle,
} from './install.js';

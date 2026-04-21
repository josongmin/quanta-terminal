/**
 * `features/command` — the command execution + output binding slice.
 *
 * Public surface:
 *   - `submitCommand`: dispatch a user submission → new block + pty write.
 *   - `installCommandRouter`: wire pty_data/pty_exit into the active block
 *     for a given SessionId.
 *   - `appendToActiveBlock` / `finalizeActiveBlock`: entry points called by
 *     `features/session/connect.ts` on each bridge event.
 *   - `bindBlockStore`: install the `entities/block` adapter (called once
 *     at bootstrap by the orchestrator).
 */

export { submitCommand } from './execute.js';
export type { SubmitCommandOptions, SubmitCommandResult } from './execute.js';

export {
  installCommandRouter,
  isCommandRouterInstalled,
  appendToActiveBlock,
  finalizeActiveBlock,
  getActiveBlockId,
  addRouterRawObserver,
  setRouterBlockSessionLookup,
  syncRouterHybridShellIntegration,
  IDLE_COMPLETE_MS,
} from './route-output.js';
export type { InstallCommandRouterOptions } from './route-output.js';

export {
  createMockBoundaryDetector,
} from './boundary-detector.js';
export type { BoundaryDetector, BoundaryFeedResult } from './boundary-detector.js';

export { createHybridBoundaryDetector } from './hybrid-detector.js';
export type {
  BoundaryEvent,
  BoundaryEventKind,
  BoundarySource,
  HybridBoundaryDetector,
  HybridBoundaryDetectorOptions,
} from './hybrid-detector-types.js';
export type { HybridRouterOptions } from './route-output.js';

export {
  bindBlockStore,
  getBlockStore,
  tryGetBlockStore,
} from './block-store-port.js';
export type { BlockStoreActions, StartBlockPortOptions } from './block-store-port.js';

export { bindBlockEntity } from './bind-block-entity.js';

export {
  installBoundaryListener,
  createBoundaryListener,
  mapSourceToConfidence,
} from './block-boundary-listener.js';
export type {
  BoundaryListenerHandle,
  BoundaryBlockStorePort,
  ScrollbackPinPort,
} from './block-boundary-listener.js';

/**
 * Public entry for `@quanta/ui`. Hosts depend on `bootstrapUi` and the
 * `HostBridge` re-exports; everything else is internal.
 */

export { bootstrapUi } from './app/bootstrap.js';
export type { BootstrapOptions } from './app/bootstrap.js';

export { setHostBridge, getHostBridge, tryGetHostBridge } from './shared/api/host-bridge.js';

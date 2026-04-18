/**
 * `features/tui` — alt-screen fallback orchestrator.
 *
 * Public surface:
 *   - `installTuiDetector`: wires the raw-chunk alt-screen detector into
 *     the command router and drives `entities/tui`. Page boots call this
 *     once alongside `installCommandRouter`.
 *   - `createAltScreenDetector`: factory for the byte-level FSM, re-
 *     exported so tests can exercise it directly without touching the
 *     store.
 */

export { installTuiDetector } from './install.js';
export type { TuiInstallHandle } from './install.js';
export { createAltScreenDetector } from './detect.js';
export type { AltScreenDetector } from './detect.js';

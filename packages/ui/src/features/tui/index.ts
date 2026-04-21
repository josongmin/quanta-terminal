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
 *   - `TuiRenderSurface`: alt-screen output painter. Its visibility
 *     follows `altScreen.active` per existing behavior; Epic δ will
 *     unify render into a single always-on surface.
 *
 * `TuiInputSurface` was removed in Epic β (Plan 0005 §4.β) and replaced
 * by the always-on `SessionInputSurface` in `features/session` — every
 * user event now funnels through `input-host` whenever a session is
 * active, not only during alt-screen mode.
 */

export { installTuiDetector } from './install.js';
export type { TuiInstallHandle } from './install.js';
export { createAltScreenDetector } from './detect.js';
export type { AltScreenDetector } from './detect.js';
export { TuiRenderSurface } from './TuiRenderSurface.js';
export type { TuiRenderSurfaceProps } from './TuiRenderSurface.js';

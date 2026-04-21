/**
 * Public surface of the byte-level VT emulator.
 *
 * The emulator takes raw PTY bytes and produces `GridEventEnvelope<GridPayload>`
 * updates shaped for `GridMirror`. Use it when you need cursor-addressable
 * rendering (vim, htop, less) — for linear log output, the simpler
 * `shared/lib/ansi-parser` is still preferable.
 */

export { VtEmulator } from './VtEmulator.js';
export type { RgbColor, VtEmulatorOptions } from './VtEmulator.js';
export type {
  InternalCell,
  Scrollback,
  ScrollbackRow,
} from './types.js';

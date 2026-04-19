/**
 * Event entity — runtime model of HostEvent for the UI.
 *
 * The canvas renderer consumes the `GridMirror` produced by the custom
 * VT engine; higher-level widgets (status bar, block list) subscribe to
 * their own projections. Kept intentionally thin.
 */

export type { HostEvent, HostEventKind } from '@quanta/host-common';
export { isEventOfKind } from '@quanta/host-common';

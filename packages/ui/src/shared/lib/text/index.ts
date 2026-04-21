/**
 * Public entry for `shared/lib/text` — plain-text projection helpers for
 * non-render consumers of the PTY byte stream (a11y announce, AI explain,
 * output search, block copy / export, compare diff, history indexing).
 *
 * These consumers must not reach into `shared/lib/ansi-parser` directly;
 * the `check-one-render-path` CI rule enforces that boundary. This module
 * is allowlisted as the one legitimate wrapper around `stripAnsi`.
 */

export { projectChunksToText, stripAnsi } from './project-output.js';

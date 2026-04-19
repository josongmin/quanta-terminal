export { SideBySideHarness } from './SideBySideHarness.js';
export type { SideBySideHarnessProps } from './SideBySideHarness.js';
export {
  diffFrames,
  countCellDiffs,
  buildSnapshot,
  blankSnapshot,
} from './side-by-side-diff.js';
export type {
  CellSnapshot,
  CursorSnapshot,
  ModeSnapshot,
  FrameSnapshot,
  CellDiff,
  CursorDiff,
  ModeDiff,
  InputByteDiff,
  Diff,
} from './side-by-side-diff.js';
export { SideBySideRecorder } from './side-by-side-recorder.js';
export type { DiffSnapshot, SideBySideRecorderOptions } from './side-by-side-recorder.js';

/**
 * EPIC-E — Input Encoder + IME feature slice.
 * Public surface: types, encoders, IME state machine, overlay, input-host.
 */
export type {
  EncoderDiagnostics,
  EncoderOutput,
  EncodingMode,
  FocusEvent,
  KeyEvent,
  MouseEvent,
  PasteEvent,
  Platform,
  TerminalModeSnapshot,
} from './types';

export { Focus } from './Focus';
export { KeyEncoder, selectEncodingMode } from './KeyEncoder';
export { MouseEncoder } from './MouseEncoder';
export { Paste } from './Paste';
export { createStubMirror, ModeSnapshot } from './ModeSnapshot';
export type { GridMirrorLike } from './ModeSnapshot';

export type {
  ImeEvent,
  ImeSideEffect,
  ImeState,
  ImeStateComposing,
  ImeStateIdle,
  ImeStateKind,
  PreeditOverlayProps,
  TransitionOpts,
} from './ime/ime-types';
export { classifyKeydown, IDLE, PreeditOverlay, transition } from './ime';

export { detectPlatform, mount } from './input-host';
export type { InputHostHandle, InputHostMountOptions } from './input-host';

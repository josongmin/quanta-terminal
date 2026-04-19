/**
 * `input-host.ts` — sole DOM attach-point for key/mouse/paste/focus/IME
 * events. EPIC-E §1. All events route through the encoder layer; bytes
 * are delivered via `onBytesOut` to the caller (EPIC-F host wiring).
 *
 * Invariant I-6: no other module in the UI package talks to the PTY
 * write bridge from a KeyboardEvent path. This file holds the only
 * reference to `onBytesOut` coming from keyboard handlers, and the
 * `tools/check-key-event-encoder-layer` grep rule will allow this
 * because the file lives under `features/input/`.
 */
import { createLogger } from '../../shared/lib/logger';

import type { Focus } from './Focus';
import type { KeyEncoder } from './KeyEncoder';
import type { MouseEncoder } from './MouseEncoder';
import type { Paste } from './Paste';
import type {
  ImeEvent,
  ImeSideEffect,
  ImeState,
  PreeditOverlayProps,
  TransitionOpts,
} from './ime/ime-types';
import { classifyKeydown, IDLE, transition } from './ime/ImeStateMachine';
import type {
  KeyEvent as QuantaKeyEvent,
  MouseEvent as QuantaMouseEvent,
  Platform,
} from './types';

const log = createLogger('input.host');

export interface InputHostMountOptions {
  keyEncoder: KeyEncoder;
  mouseEncoder: MouseEncoder;
  paste: Paste;
  focus: Focus;
  /** Optional: provide a platform override (defaults to navigator-sniffed). */
  platform?: Platform;
  /** Cell coordinate converter. EPIC-D provides the real one; stubbed here. */
  screenToCell?: (clientX: number, clientY: number) => { xCell: number; yCell: number };
  /**
   * Current cursor location in cell coords, for overlay anchoring.
   * EPIC-C supplies the cursor state; callers pass a getter so the
   * overlay can re-anchor after resize/focus.
   */
  getCursorCell?: () => { row: number; col: number };
  /** Cell-to-pixel converter for overlay positioning. EPIC-D supplies real geometry. */
  cellToScreen?: (cell: { row: number; col: number }) => { x: number; y: number };
  /** Called with encoded PTY bytes. EPIC-F wires this to `bridge.write`. */
  onBytesOut: (bytes: Uint8Array) => void;
  /** Called when the overlay should be mounted / updated / unmounted. */
  onOverlayUpdate?: (props: PreeditOverlayProps | null) => void;
  /** Called to show a UI banner (sidecar-restart message). */
  onBanner?: (message: string) => void;
  /** Emit telemetry events (EPIC-J wires this to the metrics bus). */
  onTelemetry?: (name: string, value?: number, labels?: Record<string, string>) => void;
  /** Override clock for deterministic tests. */
  now?: () => number;
  /** Override timer helpers for deterministic tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** Optional platform-disconnect signal source for sidecar-restart flow. */
  onSidecarDisconnectSubscribe?: (handler: () => void) => () => void;
}

export interface InputHostHandle {
  /** Pushes a synthetic IME event (used by the sidecar-restart wire-up). */
  pushImeEvent(event: ImeEvent): void;
  /** Returns the current `ImeState` (for tests + diagnostics). */
  state(): ImeState;
  /** Releases all listeners + timers. */
  unmount(): void;
}

/** Auto-detect the platform via `navigator.platform` / `navigator.userAgent`. */
export function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`.toLowerCase();
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  return 'linux';
}

function normalizeKey(ev: KeyboardEvent, kind: 'keydown' | 'keyup'): QuantaKeyEvent {
  return {
    key: ev.key,
    code: ev.code,
    ctrlKey: ev.ctrlKey,
    altKey: ev.altKey,
    metaKey: ev.metaKey,
    shiftKey: ev.shiftKey,
    repeat: ev.repeat,
    isComposing: ev.isComposing,
    kind,
  };
}

function buttonFromDom(ev: PointerEvent): QuantaMouseEvent['button'] {
  switch (ev.button) {
    case 0:
      return 'left';
    case 1:
      return 'middle';
    case 2:
      return 'right';
    default:
      return 'none';
  }
}

const PERSIST_TIMER_MS = 1000;

export function mount(container: HTMLElement, opts: InputHostMountOptions): InputHostHandle {
  const now = opts.now ?? (() => performance.now());
  const setT = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const platform: Platform = opts.platform ?? detectPlatform();
  const screenToCell = opts.screenToCell ?? (() => ({ xCell: 0, yCell: 0 }));
  const getCursorCell = opts.getCursorCell ?? (() => ({ row: 0, col: 0 }));
  const cellToScreen = opts.cellToScreen ?? (() => ({ x: 0, y: 0 }));

  let state: ImeState = IDLE;
  let persistTimer: unknown = null;
  let currentOverlay: PreeditOverlayProps | null = null;

  const emitOverlay = (o: PreeditOverlayProps | null): void => {
    currentOverlay = o;
    opts.onOverlayUpdate?.(o);
  };

  const emitTelemetry = (name: string, value?: number, labels?: Record<string, string>): void => {
    opts.onTelemetry?.(name, value, labels);
  };

  const applyEffects = (effects: ImeSideEffect[]): void => {
    for (const eff of effects) {
      switch (eff.kind) {
        case 'mount-overlay': {
          const cursor = getCursorCell();
          const xy = cellToScreen(cursor);
          emitOverlay({ text: eff.text, anchor: { ...cursor, ...xy } });
          break;
        }
        case 'update-overlay': {
          if (currentOverlay) {
            emitOverlay({ ...currentOverlay, text: eff.text });
          } else {
            const cursor = getCursorCell();
            const xy = cellToScreen(cursor);
            emitOverlay({ text: eff.text, anchor: { ...cursor, ...xy } });
          }
          break;
        }
        case 'unmount-overlay':
          emitOverlay(null);
          break;
        case 'dim-overlay':
          if (currentOverlay) emitOverlay({ ...currentOverlay, dimmed: true });
          break;
        case 'undim-overlay':
          if (currentOverlay) {
            const { dimmed: _d, ...rest } = currentOverlay;
            emitOverlay(rest);
          }
          break;
        case 'start-persist-timer':
          persistTimer = setT(() => {
            dispatchIme({ kind: 'persist-timer-expired' });
          }, PERSIST_TIMER_MS);
          break;
        case 'cancel-persist-timer':
          if (persistTimer !== null) {
            clearT(persistTimer);
            persistTimer = null;
          }
          break;
        case 'reanchor-overlay': {
          if (currentOverlay) {
            const cursor = getCursorCell();
            const xy = cellToScreen(cursor);
            emitOverlay({ ...currentOverlay, anchor: { ...cursor, ...xy } });
          }
          break;
        }
        case 'emit-commit-bytes': {
          const out = opts.paste.encode(eff.paste);
          if (out.bytes.length > 0) opts.onBytesOut(out.bytes);
          break;
        }
        case 'show-banner':
          opts.onBanner?.(eff.message);
          break;
        case 'telemetry':
          emitTelemetry(eff.name, eff.value, eff.labels);
          break;
      }
    }
  };

  const transitionOpts: TransitionOpts = { platform, now: 0 };

  const dispatchIme = (event: ImeEvent): void => {
    transitionOpts.now = now();
    const result = transition(state, event, transitionOpts);
    state = result.next;
    applyEffects(result.effects);
    log.debug('ime-transition', { event: event.kind, nextKind: state.kind });
  };

  // ---------------- DOM handlers ----------------

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.isComposing || state.kind === 'Composing') {
      // Route to IME SM; do NOT forward to encoder.
      dispatchIme({ kind: classifyKeydown(ev.key) });
      ev.preventDefault();
      return;
    }
    const normalized = normalizeKey(ev, 'keydown');
    const out = opts.keyEncoder.encode(normalized);
    if (out.bytes.length > 0) opts.onBytesOut(out.bytes);
  };

  const onKeyUp = (ev: KeyboardEvent): void => {
    if (state.kind === 'Composing') return;
    const normalized = normalizeKey(ev, 'keyup');
    // Only emit release for kitty ≥ L2 (encoder naturally empties if not).
    const out = opts.keyEncoder.encode(normalized);
    if (out.bytes.length > 0) opts.onBytesOut(out.bytes);
  };

  const onCompositionStart = (ev: CompositionEvent): void => {
    dispatchIme({ kind: 'compositionstart', data: ev.data ?? '' });
  };
  const onCompositionUpdate = (ev: CompositionEvent): void => {
    dispatchIme({ kind: 'compositionupdate', data: ev.data ?? '' });
  };
  const onCompositionEnd = (ev: CompositionEvent): void => {
    dispatchIme({ kind: 'compositionend', data: ev.data ?? '' });
  };

  const onBlur = (): void => {
    dispatchIme({ kind: 'blur' });
    const out = opts.focus.encode({ focused: false });
    if (out.bytes.length > 0) opts.onBytesOut(out.bytes);
  };
  const onFocus = (): void => {
    dispatchIme({ kind: 'focus' });
    const out = opts.focus.encode({ focused: true });
    if (out.bytes.length > 0) opts.onBytesOut(out.bytes);
  };

  const onPaste = (ev: ClipboardEvent): void => {
    const text = ev.clipboardData?.getData('text') ?? '';
    const out = opts.paste.encode({ text, length: text.length });
    if (out.bytes.length > 0) opts.onBytesOut(out.bytes);
    ev.preventDefault();
  };

  const pointerMouse = (ev: PointerEvent, kind: QuantaMouseEvent['kind']): void => {
    const cell = screenToCell(ev.clientX, ev.clientY);
    const me: QuantaMouseEvent = {
      xCell: cell.xCell,
      yCell: cell.yCell,
      button: kind === 'move' ? 'none' : buttonFromDom(ev),
      modifiers: {
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        shift: ev.shiftKey,
        meta: ev.metaKey,
      },
      kind,
    };
    const out = opts.mouseEncoder.encode(me);
    if (out.bytes.length > 0) opts.onBytesOut(out.bytes);
  };
  const onPointerDown = (ev: PointerEvent): void => pointerMouse(ev, 'press');
  const onPointerUp = (ev: PointerEvent): void => pointerMouse(ev, 'release');
  const onPointerMove = (ev: PointerEvent): void => {
    // Differentiate drag from hover by checking buttons held.
    const kind: QuantaMouseEvent['kind'] = ev.buttons > 0 ? 'drag' : 'move';
    pointerMouse(ev, kind);
  };

  const onWheel = (ev: WheelEvent): void => {
    const cell = screenToCell(ev.clientX, ev.clientY);
    const button: QuantaMouseEvent['button'] = ev.deltaY < 0 ? 'wheel-up' : 'wheel-down';
    const me: QuantaMouseEvent = {
      xCell: cell.xCell,
      yCell: cell.yCell,
      button,
      modifiers: {
        ctrl: ev.ctrlKey,
        alt: ev.altKey,
        shift: ev.shiftKey,
        meta: ev.metaKey,
      },
      kind: 'wheel',
    };
    const out = opts.mouseEncoder.encode(me);
    if (out.bytes.length > 0) opts.onBytesOut(out.bytes);
  };

  const onResize = (): void => dispatchIme({ kind: 'resize' });

  // Sidecar-disconnect subscription is optional.
  const unsubSidecar = opts.onSidecarDisconnectSubscribe?.(() => {
    dispatchIme({ kind: 'sidecar-disconnect' });
  });

  container.addEventListener('keydown', onKeyDown);
  container.addEventListener('keyup', onKeyUp);
  container.addEventListener('compositionstart', onCompositionStart);
  container.addEventListener('compositionupdate', onCompositionUpdate);
  container.addEventListener('compositionend', onCompositionEnd);
  container.addEventListener('blur', onBlur, true);
  container.addEventListener('focus', onFocus, true);
  container.addEventListener('paste', onPaste as EventListener);
  container.addEventListener('pointerdown', onPointerDown as EventListener);
  container.addEventListener('pointerup', onPointerUp as EventListener);
  container.addEventListener('pointermove', onPointerMove as EventListener);
  container.addEventListener('wheel', onWheel as EventListener);
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', onResize);
  }

  return {
    pushImeEvent(event) {
      dispatchIme(event);
    },
    state() {
      return state;
    },
    unmount() {
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('keyup', onKeyUp);
      container.removeEventListener('compositionstart', onCompositionStart);
      container.removeEventListener('compositionupdate', onCompositionUpdate);
      container.removeEventListener('compositionend', onCompositionEnd);
      container.removeEventListener('blur', onBlur, true);
      container.removeEventListener('focus', onFocus, true);
      container.removeEventListener('paste', onPaste as EventListener);
      container.removeEventListener('pointerdown', onPointerDown as EventListener);
      container.removeEventListener('pointerup', onPointerUp as EventListener);
      container.removeEventListener('pointermove', onPointerMove as EventListener);
      container.removeEventListener('wheel', onWheel as EventListener);
      if (typeof window !== 'undefined') {
        window.removeEventListener('resize', onResize);
      }
      if (persistTimer !== null) {
        clearT(persistTimer);
        persistTimer = null;
      }
      unsubSidecar?.();
    },
  };
}

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
import { getPlatform as sharedGetPlatform } from '../../shared/lib/platform';

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
  /**
   * Optional paste safety gate. When provided, every `paste` event is passed
   * through this predicate BEFORE the Paste encoder runs. Return `true` to
   * allow the paste (bytes emitted normally); return a promise that resolves
   * to `false` to abort. The host always calls `preventDefault()` on the
   * DOM event so the browser's default behavior is suppressed either way.
   *
   * Decoupling the decision is deliberate: the UI layer owns the modal and
   * the user's choice, the encoder layer only knows about bytes. The
   * promise contract lets the caller await a user confirmation dialog.
   */
  onPasteGate?: (text: string) => boolean | Promise<boolean>;
  /**
   * Pre-byte-delivery gate. Return `false` (or a promise resolving to
   * `false`) to DROP the encoded byte batch silently — the encoder still
   * ran and produced bytes, but `onBytesOut` is skipped for this emit.
   *
   * Called once per byte batch (per keystroke / mouse event / paste /
   * focus / IME commit), regardless of batch size. The `source` tag lets
   * callers attribute drops (e.g. the degraded-mode telemetry counter
   * cares whether the drop came from a keystroke vs a mouse move).
   *
   * Positioned AFTER the encoder (bytes are already formed) so degraded-
   * mode suppression composes with whatever mode state the encoder read.
   * This is intentional: degraded means "PTY is unreachable", the
   * encoder's view of DECCKM / mouse reporting is irrelevant at that
   * point — we just refuse to put bytes on the wire.
   *
   * Returning a promise is supported for symmetry with `onPasteGate`,
   * but the keystroke hot path calls the gate synchronously; async-false
   * still works but introduces a microtask for every key.
   */
  onByteGate?: (
    bytes: Uint8Array,
    source: 'keyboard' | 'mouse' | 'paste' | 'focus' | 'ime',
  ) => boolean | Promise<boolean>;
}

export interface InputHostHandle {
  /** Pushes a synthetic IME event (used by the sidecar-restart wire-up). */
  pushImeEvent(event: ImeEvent): void;
  /** Returns the current `ImeState` (for tests + diagnostics). */
  state(): ImeState;
  /** Releases all listeners + timers. */
  unmount(): void;
}

/**
 * Auto-detect the platform. Delegates to the shared memoized
 * `getPlatform()` helper so every call site inside the UI package agrees
 * on the same answer without each duplicating their own regex. Retained
 * as a re-export rather than inlined so existing callers (and the
 * `features/input` barrel) keep compiling.
 */
export function detectPlatform(): Platform {
  return sharedGetPlatform();
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

  /**
   * Gate + deliver helper. Runs `onByteGate` (if bound) with the source
   * attribution; on `false` the bytes are dropped silently (the caller
   * already observed them via the encoder layer). Zero-length batches
   * short-circuit — we never call the gate for empty emits, which means
   * callers can count "gate invocations" as a proxy for "intended wire
   * events" without worrying about noop encoder output.
   *
   * Async gates: the keystroke path should generally use synchronous
   * gates (see docs on `InputHostMountOptions.onByteGate`), but a
   * Promise<boolean> still works — the decision just lands a microtask
   * later. Errors from async gates are logged and treated as DROP to
   * match the paste-gate policy (fail-closed).
   */
  const deliverBytes = (
    bytes: Uint8Array,
    source: 'keyboard' | 'mouse' | 'paste' | 'focus' | 'ime',
  ): void => {
    if (bytes.length === 0) return;
    const gate = opts.onByteGate;
    if (!gate) {
      opts.onBytesOut(bytes);
      return;
    }
    const decision = gate(bytes, source);
    if (typeof decision === 'boolean') {
      if (decision) opts.onBytesOut(bytes);
      return;
    }
    // Async gate. Fail-closed on rejection matches the paste-gate policy.
    void decision
      .then((allowed) => {
        if (allowed) opts.onBytesOut(bytes);
      })
      .catch((err) => {
        log.warn('input-host: byte gate rejected', err);
      });
  };

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
          deliverBytes(out.bytes, 'ime');
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
    deliverBytes(out.bytes, 'keyboard');
  };

  const onKeyUp = (ev: KeyboardEvent): void => {
    if (state.kind === 'Composing') return;
    const normalized = normalizeKey(ev, 'keyup');
    // Only emit release for kitty ≥ L2 (encoder naturally empties if not).
    const out = opts.keyEncoder.encode(normalized);
    deliverBytes(out.bytes, 'keyboard');
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
    deliverBytes(out.bytes, 'focus');
  };
  const onFocus = (): void => {
    dispatchIme({ kind: 'focus' });
    const out = opts.focus.encode({ focused: true });
    deliverBytes(out.bytes, 'focus');
  };

  const onPaste = (ev: ClipboardEvent): void => {
    const text = ev.clipboardData?.getData('text') ?? '';
    // Always suppress the browser default so the gate's async decision
    // cannot race the native insertion. When there is no gate, we emit
    // synchronously; with a gate, we await the async decision before
    // emitting.
    ev.preventDefault();
    const gate = opts.onPasteGate;
    if (!gate) {
      const out = opts.paste.encode({ text, length: text.length });
      deliverBytes(out.bytes, 'paste');
      return;
    }
    const decision = gate(text);
    const emit = (allowed: boolean): void => {
      if (!allowed) return;
      const out = opts.paste.encode({ text, length: text.length });
      deliverBytes(out.bytes, 'paste');
    };
    if (typeof decision === 'boolean') {
      emit(decision);
      return;
    }
    // Bug 2 fix: surface gate errors via console.warn so the user knows
    // the paste was discarded instead of silently dropping it.
    void decision.then(emit).catch((err) => {
      log.warn('input-host: paste gate rejected', err);
      console.warn('[paste-gate] gate threw unexpectedly; paste discarded', err);
    });
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
    deliverBytes(out.bytes, 'mouse');
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
    // Approximate a line count for the alt-screen wheel→arrow fallback.
    // `deltaMode`: 0 = pixels, 1 = lines, 2 = pages. When pixels, divide
    // by a fixed ~16 px cell-height proxy; the encoder only needs a
    // rough count to multiply the arrow keystroke. Clamped to [1,10] so
    // one trackpad burst cannot spew dozens of arrows.
    const absDelta = Math.abs(ev.deltaY);
    let lines: number;
    if (ev.deltaMode === 1) {
      lines = Math.max(1, Math.floor(absDelta));
    } else if (ev.deltaMode === 2) {
      lines = Math.max(1, Math.floor(absDelta * 10));
    } else {
      const raw = Math.floor(absDelta / 16);
      lines = Math.max(1, raw || 1);
    }
    if (lines > 10) lines = 10;
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
      wheelLines: lines,
    };
    const out = opts.mouseEncoder.encode(me);
    deliverBytes(out.bytes, 'mouse');
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

/**
 * alt-screen-driver — DECSET 1049/1047/47 push/pop of a `tui` layer.
 *
 * Plan 0005 §P1-D. Each enter (`ESC[?1049h` / `?1047h` / `?47h`) pushes a
 * new `tui` layer; each exit (`...l`) pops the topmost `tui` layer. Nested
 * enters stack — the driver never collapses depth, in contrast to the
 * legacy `entities/tui` store that only tracked `{ depth, active }`.
 *
 * Byte FSM is a direct copy of `features/tui/detect.ts`'s subset. We could
 * share the detector, but `features/tui/install.ts` already writes to
 * `useTuiStore` (the legacy per-session boolean), so if this driver reused
 * the same primitive we'd be pushing two layers per enter. Keeping the FSM
 * local also keeps the ModeStack feature self-contained — no cross-slice
 * hop into `features/tui/` for core behaviour.
 *
 * Policy picked for the `tui` layer:
 *   - inputPolicy: 'passthrough' — alt-screen programs want every keystroke.
 *   - mousePolicy: 'innermost_wins' — vim / tmux in alt-screen already
 *     opt into mouse via DECSET 1002/1003; the arbitration is "innermost
 *     claimant wins", which matches the resolver's default.
 *   - renderHint: 'chrome' — the status bar / block chrome should switch
 *     to the full-viewport TUI painter.
 */

import type { Driver, ModeStackHandle } from './types.js';

const ESC = 0x1b;
const BEL = 0x07;

type FsmState = 'Ground' | 'Escape' | 'Csi' | 'IgnoreUntilSt';

export interface AltScreenDriverOptions {
  readonly stack: ModeStackHandle;
}

export function createAltScreenDriver(opts: AltScreenDriverOptions): Driver {
  const { stack } = opts;
  const ownedIds: string[] = [];
  let state: FsmState = 'Ground';
  let csiBuf = '';
  let stEscPending = false;

  const enter = (): void => {
    const id = stack.push({
      kind: 'tui',
      inputPolicy: 'passthrough',
      mousePolicy: 'innermost_wins',
      renderHint: 'chrome',
    });
    ownedIds.push(id);
  };
  const exit = (): void => {
    const id = ownedIds.pop();
    if (id !== undefined) stack.pop(id);
  };

  const handleCsi = (final: number): void => {
    if (final !== 0x68 /* h */ && final !== 0x6c /* l */) return;
    if (!csiBuf.startsWith('?')) return;
    const body = csiBuf.slice(1);
    let hasAltScreen = false;
    for (const raw of body.split(';')) {
      const trimmed = raw.trim();
      if (trimmed === '1049' || trimmed === '1047' || trimmed === '47') {
        hasAltScreen = true;
        break;
      }
    }
    if (!hasAltScreen) return;
    if (final === 0x68) enter();
    else exit();
  };

  const step = (b: number): void => {
    switch (state) {
      case 'Ground':
        if (b === ESC) state = 'Escape';
        return;
      case 'Escape':
        switch (b) {
          case 0x5b:
            state = 'Csi';
            csiBuf = '';
            return;
          case 0x5d /* ] */:
          case 0x50 /* P */:
          case 0x5f /* _ */:
          case 0x5e /* ^ */:
            state = 'IgnoreUntilSt';
            stEscPending = false;
            return;
          default:
            state = 'Ground';
            return;
        }
      case 'Csi':
        if (b >= 0x30 && b <= 0x3f) {
          csiBuf += String.fromCharCode(b);
          return;
        }
        if (b >= 0x20 && b <= 0x2f) {
          csiBuf += String.fromCharCode(b);
          return;
        }
        if (b >= 0x40 && b <= 0x7e) {
          handleCsi(b);
          state = 'Ground';
          csiBuf = '';
          return;
        }
        state = 'Ground';
        csiBuf = '';
        return;
      case 'IgnoreUntilSt':
        if (stEscPending) {
          stEscPending = false;
          state = 'Ground';
          return;
        }
        if (b === BEL) {
          state = 'Ground';
          return;
        }
        if (b === ESC) {
          stEscPending = true;
          return;
        }
        return;
    }
  };

  return {
    feed(bytes) {
      for (let i = 0; i < bytes.length; i += 1) {
        const b = bytes[i];
        if (b === undefined) continue;
        step(b);
      }
    },
    dispose() {
      while (ownedIds.length > 0) {
        const id = ownedIds.pop();
        if (id !== undefined) stack.pop(id);
      }
      state = 'Ground';
      csiBuf = '';
      stEscPending = false;
    },
  };
}

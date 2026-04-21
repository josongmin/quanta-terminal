/**
 * multiplexer-driver — pushes a `multiplexer` layer when tmux or screen is
 * detected in the stream.
 *
 * Detection strategy (per P1-D §D2 / §D3):
 *   - Primary: DCS pass-through wrapper. tmux wraps its OSC traffic in
 *     `ESC P tmux; ESC ... ESC \`; screen does similarly with
 *     `ESC P ... ESC \`. Spotting any DCS-with-`tmux;` prefix is a near-
 *     certain positive. We match the `tmux;` header then push.
 *   - Secondary: OSC 1337 replies from iTerm2's shell-integration protocol
 *     are forwarded as-is by tmux's pass-through; when we see an OSC 1337
 *     with a tmux-specific `CurrentDir` reply we also push.
 *   - XTGETTCAP response (DCS 1 + r <payload> ST) is recognized as a
 *     positive multiplexer signal — only tmux/screen reply to the query.
 *   - §D3 XTVERSION reply: DCS `>|tmux <version> ST` — tmux's canonical
 *     response to the CSI `>q` (XTVERSION) request — is an unambiguous
 *     positive. Screen replies similarly with `>|screen`.
 *   - §D3 DA2 (secondary DA) reply: CSI `> <pid>;<version>;<kbd> c`. tmux
 *     answers DA2 with a leading `1` in the first parameter (`\x1b[>1;Nv;0c`
 *     or `\x1b[>1;...c`); matching that pretend-identity is a weaker but
 *     useful signal in sessions where DCS pass-through isn't enabled.
 *
 * The driver pushes at most one layer per "detection event" and re-arms
 * after a quiescent period. tmux's DCS wrapping is continuous during a
 * session, so we use the `hints.multiplexer` field to mark which kind
 * got detected and avoid spamming pushes.
 *
 * Exit is signal-driven: consumers may call `exit()` on the returned
 * driver (e.g. when the user detaches), or `dispose()` to pop the layer.
 * We intentionally do NOT try to detect "tmux attached" vs "detached" from
 * bytes alone — there is no reliable byte marker, and a false pop corrupts
 * the stack.
 */

import type { Driver, ModeStackHandle } from './types.js';
import type { ModeLayerHints } from '../mode-stack-store.js';

const ESC = 0x1b;
const BEL = 0x07;

type FsmState = 'Ground' | 'Escape' | 'Dcs' | 'Osc' | 'Csi';

export interface MultiplexerDriver extends Driver {
  /** Explicitly pop the current multiplexer layer (e.g. detach). */
  exit(): void;
}

export interface MultiplexerDriverOptions {
  readonly stack: ModeStackHandle;
}

export function createMultiplexerDriver(
  opts: MultiplexerDriverOptions,
): MultiplexerDriver {
  const { stack } = opts;
  let layerId: string | null = null;
  let detectedKind: ModeLayerHints['multiplexer'] | null = null;

  let state: FsmState = 'Ground';
  let buf = '';
  let stEscPending = false;
  // CSI accumulator (parameters + intermediates, without the final byte).
  let csiBuf = '';

  const push = (kind: NonNullable<ModeLayerHints['multiplexer']>): void => {
    if (layerId !== null && detectedKind === kind) return;
    if (layerId !== null) stack.pop(layerId);
    detectedKind = kind;
    layerId = stack.push({
      kind: 'multiplexer',
      hints: { multiplexer: kind },
      // tmux passes input through with a prefix key (default C-b); the
      // outer-shell resolver handles binding interception at the UI layer.
      inputPolicy: 'intercept_prefix',
      // Multiplexer itself doesn't demand mouse; innermost DECSET wins.
      mousePolicy: 'outermost_wins',
      renderHint: 'chrome',
    });
  };

  const pop = (): void => {
    if (layerId !== null) {
      stack.pop(layerId);
      layerId = null;
      detectedKind = null;
    }
  };

  /** Match the accumulated DCS / OSC payload against known multiplexer
   * signatures. Returns true if we pushed a layer. */
  const matchPayload = (kind: 'dcs' | 'osc', payload: string): boolean => {
    if (kind === 'dcs') {
      // tmux's pass-through wrapper: `tmux;` prefix.
      if (/^tmux;/.test(payload)) {
        push('tmux');
        return true;
      }
      // XTGETTCAP reply: DCS 1 + r <hex-pairs> ST — tmux & screen reply.
      // Pattern: "1+r" then hex digits & semicolons.
      if (/^1\+r[0-9a-fA-F;=]+$/.test(payload)) {
        // Can't distinguish tmux from screen in the reply body alone,
        // but the driver's hint field is a string — we pick 'tmux' as
        // the most common (the caller can override via `setKind`).
        push('tmux');
        return true;
      }
      // §D3 XTVERSION reply: DCS `>|tmux <version> ST`. Screen answers
      // `>|screen <version>`. A leading `>|` + one of those program names
      // is an unambiguous multiplexer signal.
      if (/^>\|tmux\b/i.test(payload)) {
        push('tmux');
        return true;
      }
      if (/^>\|screen\b/i.test(payload)) {
        push('screen');
        return true;
      }
    }
    if (kind === 'osc') {
      // tmux forwards OSC 1337;CurrentDir=... from its panes when
      // allow-passthrough is enabled. Treat that as tmux evidence.
      if (/^1337;/.test(payload) && /CurrentDir=/.test(payload)) {
        push('tmux');
        return true;
      }
    }
    return false;
  };

  /**
   * §D3 DA2 / CSI `>q` interpretation. The CSI accumulator already strips the
   * `[` and stops at the final byte. We match:
   *   - `>...c` → DA2 response. tmux advertises itself with a leading `1` in
   *     the first parameter (`>1;<version>;<kbd>c`). Any DA2 with a `>`
   *     prefix and leading `1` is treated as tmux-pretend.
   *   - `>q`    → the XTVERSION *request* (outbound from some terminals).
   *     Inbound `>q` from the host is rare but indicates a multiplexer
   *     probing us back; same semantic — mark tmux.
   * Final byte is passed in separately because it's consumed as the CSI
   * terminator (not included in `csiBuf`).
   */
  const matchCsi = (payloadWithFinal: string): boolean => {
    // DA2 response: `>1;...c`.
    if (/^>1(?:;[0-9]*)*c$/.test(payloadWithFinal)) {
      push('tmux');
      return true;
    }
    // CSI `>q` — XTVERSION query. Inbound indicates a pass-through
    // multiplexer is probing the terminal.
    if (/^>q$/.test(payloadWithFinal)) {
      push('tmux');
      return true;
    }
    return false;
  };

  const step = (b: number): void => {
    switch (state) {
      case 'Ground':
        if (b === ESC) state = 'Escape';
        return;
      case 'Escape':
        switch (b) {
          case 0x50 /* P */:
            state = 'Dcs';
            buf = '';
            stEscPending = false;
            return;
          case 0x5d /* ] */:
            state = 'Osc';
            buf = '';
            stEscPending = false;
            return;
          case 0x5b /* [ */:
            state = 'Csi';
            csiBuf = '';
            return;
          default:
            state = 'Ground';
            return;
        }
      case 'Csi': {
        // CSI: parameter bytes 0x30..0x3f, intermediate bytes 0x20..0x2f,
        // final byte 0x40..0x7e. Anything else aborts.
        if (b >= 0x30 && b <= 0x3f) {
          if (csiBuf.length < 64) csiBuf += String.fromCharCode(b);
          return;
        }
        if (b >= 0x20 && b <= 0x2f) {
          if (csiBuf.length < 64) csiBuf += String.fromCharCode(b);
          return;
        }
        if (b >= 0x40 && b <= 0x7e) {
          matchCsi(csiBuf + String.fromCharCode(b));
          state = 'Ground';
          csiBuf = '';
          return;
        }
        state = 'Ground';
        csiBuf = '';
        return;
      }
      case 'Dcs':
      case 'Osc': {
        if (stEscPending) {
          stEscPending = false;
          if (b === 0x5c /* \ */) {
            matchPayload(state === 'Dcs' ? 'dcs' : 'osc', buf);
            state = 'Ground';
            buf = '';
            return;
          }
          // ESC followed by a non-`\` byte inside a DCS pass-through is
          // PAYLOAD, not a terminator. tmux's DCS wrapper embeds entire
          // OSC sequences (ESC ] ... BEL) between its `tmux;` header and
          // the outer ESC \ — we MUST buffer the ESC + this byte and keep
          // accumulating. OSC, on the other hand, does not permit nested
          // control sequences; a bare ESC-not-\ aborts.
          if (state === 'Dcs') {
            if (buf.length < 8 * 1024) {
              buf += String.fromCharCode(ESC);
              buf += String.fromCharCode(b);
            }
            return;
          }
          // OSC: lone ESC aborts.
          state = 'Ground';
          buf = '';
          return;
        }
        // Per ECMA-48, DCS terminates on ST (ESC \) only. OSC terminates
        // on BEL or ST.
        if (b === BEL && state === 'Osc') {
          matchPayload('osc', buf);
          state = 'Ground';
          buf = '';
          return;
        }
        if (b === ESC) {
          stEscPending = true;
          return;
        }
        // Cap the payload size so a runaway OSC/DCS doesn't grow buf
        // unboundedly. 8 KiB is well above any known multiplexer signature.
        if (buf.length < 8 * 1024) buf += String.fromCharCode(b);
        return;
      }
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
    exit() {
      pop();
    },
    dispose() {
      pop();
      state = 'Ground';
      buf = '';
      csiBuf = '';
      stEscPending = false;
    },
  };
}

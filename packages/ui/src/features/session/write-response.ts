/**
 * Protocol-layer response sink for terminal query bytes.
 *
 * Why this module exists
 * ----------------------
 * Some terminal programs ask the emulator questions through CSI/DCS/OSC
 * queries (DSR `CSI 6 n` for cursor position, DA `CSI c` for primary
 * attributes, OSC 10/11 for fg/bg color, CSI ? u for XTGETTCAP, …). The
 * emulator's answer is NOT user input — it's protocol-mandated reply
 * bytes that must land on the PTY's stdin for the asking program to make
 * progress (`vim`, `neovim`, `htop`, `less` with search, modern shells
 * with color-scheme detection all rely on these).
 *
 * The "one input path" invariant (Plan 0005 I-12) forbids arbitrary
 * callers from calling `bridge.write` / `connection.write`. The intent of
 * that invariant is "one user-input pipeline" — protocol replies sit on a
 * different conceptual plane, so this module is their single named sink.
 *
 * Allowlisting
 * ------------
 * `tools/check-one-input-path/index.mjs` allowlists this exact file. Other
 * modules MUST NOT duplicate its logic; they import `writeSessionResponse`
 * (or `encodeAndSendResponse` for the common Uint8Array shape) so every
 * query-response byte lands on a single auditable sink. The session
 * connection's `write()` wrapper still runs (so degraded-mode gating stays
 * uniform); when the connection map has not populated yet (very early
 * boot, or test harnesses that skip session-tabs) we fall through to the
 * raw host bridge.
 *
 * Failures are logged at debug and swallowed — a DSR reply that the PTY
 * rejects is not worth surfacing to the user; the asking program will
 * eventually time out on its own.
 */

import type { HostBridge, SessionId } from '@quanta/host-common';
import { createLogger } from '../../shared/lib/logger.js';
import { getSessionConnection } from '../session-tabs/index.js';

const log = createLogger('session.write-response');

/**
 * Decode protocol-reply bytes and dispatch them to the PTY. Prefers the
 * session-tabs connection wrapper (so degraded-mode gating applies) and
 * falls back to the raw host bridge when no connection has been registered
 * (mock bench, test harness, early-boot race). Returns nothing; errors are
 * logged at debug and otherwise swallowed.
 */
export async function writeSessionResponse(
  sessionId: SessionId,
  bridge: HostBridge,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.length === 0) return;
  // 7-bit ASCII round-trips through UTF-8 losslessly; the emulator's
  // DSR/OSC/DA reply encoders only emit ASCII so a non-fatal decoder is
  // sufficient. Encoders that ever emit UTF-8 (future `OSC 7` replies with
  // non-ASCII cwd segments) will still decode correctly because
  // TextEncoder already shaped those bytes as UTF-8 before we got here.
  const payload = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const conn = getSessionConnection(sessionId);
  try {
    if (conn) {
      await conn.write(payload);
    } else {
      await bridge.write(sessionId, payload);
    }
  } catch (err) {
    log.debug('protocol response write rejected', err);
  }
}

/**
 * Device Attributes (DA) — Primary, Secondary, Tertiary.
 *
 * Wire-level contract (see `executeDa` in VtEmulator.ts):
 *   - `CSI c` / `CSI 0 c`   → Primary DA   → `CSI ? 1 ; 2 c`
 *     (VT100 with Advanced Video Option — matches xterm default).
 *   - `CSI > c` / `CSI > 0 c` → Secondary DA → `CSI > 0 ; <version> ; 0 c`
 *     where `<version>` defaults to 0 and can be overridden via the
 *     `secondaryDaVersion` option.
 *   - `CSI = c` / `CSI = 0 c` → Tertiary DA  → silently dropped.
 *   - Any unknown DA variant (e.g. `CSI > 1 c`) → silently dropped.
 *
 * Responses are sent via the host-supplied `onRespond(Uint8Array)` hook.
 * Silent drop when `onRespond` is unset is covered by VtEmulator.test.ts.
 *
 * These tests add coverage NOT already in vt-spec-compliance.test.ts:
 *   - Explicit non-zero param to Primary DA (`CSI 1 c`) is dropped
 *     (only `0` is defined; other params are spec-invalid).
 *   - Explicit non-zero Secondary DA param is dropped.
 *   - Tertiary DA across default-param + explicit-zero is uniformly
 *     dropped — no reply, no crash.
 *   - Multi-DA in a single feed chunk produces ordered replies.
 */

import { describe, expect, it } from 'vitest';

import { VtEmulator } from '../VtEmulator.js';
import type {
  GridEventEnvelope,
  GridPayload,
} from '../../grid-mirror/types.js';

type Env = GridEventEnvelope<GridPayload>;

interface HarnessOpts {
  readonly rows?: number;
  readonly cols?: number;
  readonly secondaryDaVersion?: number;
}

class Harness {
  readonly envs: Env[] = [];
  readonly replies: string[] = [];
  readonly emulator: VtEmulator;

  constructor(opts: HarnessOpts = {}) {
    const { rows = 4, cols = 10, secondaryDaVersion } = opts;
    const base = {
      sessionId: 'da-test',
      rows,
      cols,
      onEnvelope: (env: Env) => this.envs.push(env),
      onRespond: (bytes: Uint8Array) => {
        this.replies.push(new TextDecoder().decode(bytes));
      },
    };
    this.emulator = new VtEmulator(
      secondaryDaVersion === undefined
        ? base
        : { ...base, secondaryDaVersion },
    );
  }

  feed(s: string | Uint8Array): void {
    const bytes = typeof s === 'string' ? new TextEncoder().encode(s) : s;
    this.emulator.feed(bytes);
  }

  consume(): string {
    const joined = this.replies.join('');
    this.replies.length = 0;
    return joined;
  }
}

describe('device-attributes — Primary DA (CSI c)', () => {
  it('CSI c replies CSI ? 1 ; 2 c', () => {
    // Invariant: VT100 + advanced video — matches xterm's default.
    const h = new Harness();
    h.feed('\x1b[c');
    expect(h.consume()).toBe('\x1b[?1;2c');
  });

  it('CSI 1 c (non-zero param) is silently dropped', () => {
    // Invariant: only param 0 (default) is a valid Primary DA request.
    // Non-zero values are spec-invalid and must not trigger a reply.
    const h = new Harness();
    h.feed('\x1b[1c');
    expect(h.consume()).toBe('');
  });
});

describe('device-attributes — Secondary DA (CSI > c)', () => {
  it('CSI > c with secondaryDaVersion=0 replies CSI > 0 ; 0 ; 0 c', () => {
    // Invariant: default version reports as 0; terminal-type 0 = VT100,
    // hardware option 0 = none.
    const h = new Harness({ secondaryDaVersion: 0 });
    h.feed('\x1b[>c');
    expect(h.consume()).toBe('\x1b[>0;0;0c');
  });

  it('CSI > c with secondaryDaVersion=9999 reports that version', () => {
    // Invariant: version is injected as-is (no clamp at the high end).
    const h = new Harness({ secondaryDaVersion: 9999 });
    h.feed('\x1b[>c');
    expect(h.consume()).toBe('\x1b[>0;9999;0c');
  });

  it('CSI > 1 c (non-zero first param) is silently dropped', () => {
    // Invariant: the only valid Secondary DA request is `>0`. Non-zero
    // leading params are dropped; no reply.
    const h = new Harness({ secondaryDaVersion: 7 });
    h.feed('\x1b[>1c');
    expect(h.consume()).toBe('');
  });
});

describe('device-attributes — Tertiary DA (CSI = c)', () => {
  it('CSI = c is silently dropped', () => {
    // Invariant: Tertiary DA is out of scope. No reply, no crash.
    const h = new Harness();
    h.feed('\x1b[=c');
    expect(h.consume()).toBe('');
  });

  it('CSI = 0 c is silently dropped (same as omitted param)', () => {
    // Invariant: explicit 0 is treated the same as default.
    const h = new Harness();
    h.feed('\x1b[=0c');
    expect(h.consume()).toBe('');
  });
});

describe('device-attributes — ordering under multi-query feeds', () => {
  it('feed with Primary then Secondary emits replies in order', () => {
    // Invariant: `onRespond` is called in dispatch order. Apps that probe
    // both DA layers in one transmit (common for terminfo negotiation)
    // receive the replies back in the same order.
    const h = new Harness({ secondaryDaVersion: 42 });
    h.feed('\x1b[c\x1b[>c');
    // Two separate replies — order preserved.
    expect(h.replies).toHaveLength(2);
    expect(h.replies[0]).toBe('\x1b[?1;2c');
    expect(h.replies[1]).toBe('\x1b[>0;42;0c');
  });
});

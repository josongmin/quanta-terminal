/**
 * Tests for `backpressure-classifier`. Covers each priority class, the
 * priority-merge policy, edge cases around partial CSI/OSC/DCS sequences,
 * and the verbose gate.
 */

import { describe, expect, it } from 'vitest';
import {
  __testing,
  classifyByteFrame,
  type ClassifyContext,
  type PriorityClass,
} from '../backpressure-classifier.js';

// ---------- Test helpers ----------

function bytes(...arr: number[]): Uint8Array {
  return new Uint8Array(arr);
}

function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

function ctx(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    inAltScreen: false,
    cursorY: 0,
    viewportRows: 24,
    verboseGateOpen: false,
    ...overrides,
  };
}

// ---------- Classes ----------

describe('backpressure-classifier', () => {
  // --------- control-class promotions ---------

  it('classifies OSC 133 (shell integration) as control', () => {
    // ESC ] 133 ; A BEL
    const frame = bytes(0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b, 0x41, 0x07);
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('control');
  });

  it('classifies OSC 7 (cwd) as control', () => {
    // ESC ] 7 ; file:///tmp BEL
    const frame = bytes(
      0x1b, 0x5d, 0x37, 0x3b, 0x66, 0x69, 0x6c, 0x65, 0x3a, 0x2f, 0x2f,
      0x2f, 0x74, 0x6d, 0x70, 0x07,
    );
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('control');
  });

  it('classifies OSC 8 (hyperlink) as control', () => {
    // ESC ] 8 ; ; url BEL
    const frame = bytes(0x1b, 0x5d, 0x38, 0x3b, 0x3b, 0x78, 0x07);
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('control');
  });

  it('classifies DECSET (CSI ? ... h) as control', () => {
    // ESC [ ? 1049 h — enter alt-screen
    const frame = bytes(
      0x1b, 0x5b, 0x3f, 0x31, 0x30, 0x34, 0x39, 0x68,
    );
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('control');
  });

  it('classifies DECRST (CSI ? ... l) as control', () => {
    // ESC [ ? 25 l — hide cursor
    const frame = bytes(0x1b, 0x5b, 0x3f, 0x32, 0x35, 0x6c);
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('control');
  });

  it('classifies DCS 2026 (synchronized update) as control', () => {
    // ESC P 2026 = 1 s ESC \ — synchronized update begin
    const frame = bytes(
      0x1b, 0x50, 0x32, 0x30, 0x32, 0x36, 0x3d, 0x31, 0x73, 0x1b, 0x5c,
    );
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('control');
  });

  it('classifies ENQ signal byte as control', () => {
    const frame = bytes(0x05, 0x41, 0x42); // ENQ, A, B
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('control');
  });

  // --------- visible-class default + promotions ---------

  it('classifies plain text at top of viewport as visible', () => {
    const frame = ascii('hello world');
    expect(
      classifyByteFrame(frame, ctx({ cursorY: 0, viewportRows: 24 })),
    ).toBe<PriorityClass>('visible');
  });

  it('classifies CSI SGR as visible (not control)', () => {
    // ESC [ 31 m — red
    const frame = bytes(0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x41, 0x42);
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('visible');
  });

  it('classifies alt-screen output as visible (no scrollback exists)', () => {
    const frame = ascii('long log line');
    expect(
      classifyByteFrame(
        frame,
        ctx({ inAltScreen: true, cursorY: 23, viewportRows: 24 }),
      ),
    ).toBe<PriorityClass>('visible');
  });

  // --------- scrollback-class default ---------

  it('classifies plain text at the last viewport row as scrollback', () => {
    const frame = ascii('cat big.log\n');
    expect(
      classifyByteFrame(frame, ctx({ cursorY: 23, viewportRows: 24 })),
    ).toBe<PriorityClass>('scrollback');
  });

  it('promotes a scrollback-default frame to control when an OSC 133 is present', () => {
    // Plain text at cursor=last row, but the frame also contains OSC 133.
    const frame = new Uint8Array([
      ...ascii('yes output... '),
      0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b, 0x41, 0x07, // OSC 133 ; A BEL
      ...ascii(' more'),
    ]);
    expect(
      classifyByteFrame(frame, ctx({ cursorY: 23, viewportRows: 24 })),
    ).toBe<PriorityClass>('control');
  });

  // --------- verbose-class gate ---------

  it('classifies plain data as verbose when the gate is open', () => {
    const frame = ascii('debug log: parsing token');
    expect(
      classifyByteFrame(frame, ctx({ verboseGateOpen: true })),
    ).toBe<PriorityClass>('verbose');
  });

  it('does not downgrade a control escape to verbose even with gate open', () => {
    // ESC ] 7 ; cwd BEL — control.
    const frame = bytes(
      0x1b, 0x5d, 0x37, 0x3b, 0x2f, 0x74, 0x6d, 0x70, 0x07,
    );
    expect(
      classifyByteFrame(frame, ctx({ verboseGateOpen: true })),
    ).toBe<PriorityClass>('control');
  });

  // --------- edge cases ---------

  it('classifies empty frame as scrollback (safe default)', () => {
    expect(classifyByteFrame(bytes(), ctx())).toBe<PriorityClass>('scrollback');
  });

  it('classifies a lone ESC without dispatch as visible (incomplete)', () => {
    // Under the self-contained-frame contract this wouldn't happen, but the
    // classifier must not crash if it does.
    const frame = bytes(0x1b);
    // Stays in `Esc` state — never promoted. The default (visible at top
    // of normal screen) wins.
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('visible');
  });

  it('classifies mixed-priority frames by picking the highest class touched', () => {
    // verbose gate open + CSI SGR (visible) + plain text → visible wins over verbose.
    const frame = new Uint8Array([
      ...ascii('log: '),
      0x1b, 0x5b, 0x33, 0x31, 0x6d, // ESC [ 31 m  — visible
      ...ascii('red text'),
    ]);
    expect(
      classifyByteFrame(frame, ctx({ verboseGateOpen: true })),
    ).toBe<PriorityClass>('visible');
  });

  it('does not promote on OSC numbers we do not recognise', () => {
    // ESC ] 999 ; foo BEL — unknown OSC, not control.
    const frame = bytes(
      0x1b, 0x5d, 0x39, 0x39, 0x39, 0x3b, 0x66, 0x6f, 0x6f, 0x07,
    );
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('visible');
  });

  it('classifies DCS with unknown number as visible, not control', () => {
    // ESC P 1234 foo ESC \ — unknown DCS.
    const frame = bytes(
      0x1b, 0x50, 0x31, 0x32, 0x33, 0x34, 0x66, 0x6f, 0x6f, 0x1b, 0x5c,
    );
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('visible');
  });

  it('handles APC string terminated by BEL as visible', () => {
    // ESC _ hello BEL — APC
    const frame = bytes(0x1b, 0x5f, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x07);
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('visible');
  });

  it('handles PM string terminated by ST as visible', () => {
    // ESC ^ x ESC \ — PM
    const frame = bytes(0x1b, 0x5e, 0x78, 0x1b, 0x5c);
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('visible');
  });

  it('does not overflow on absurd OSC numeric prefix lengths', () => {
    // ESC ] 1234567890 ; x BEL — classifier caps paramBuf at 5, so this
    // is treated as an unknown OSC number (visible).
    const frame = bytes(
      0x1b, 0x5d, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
      0x30, 0x3b, 0x78, 0x07,
    );
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('visible');
  });

  it('classifies a bare verbose-gate marker OSC 4242 as control', () => {
    // The batcher parses this OSC out-of-band to flip the gate, but the
    // byte-frame containing it must stay `control` so it's never dropped.
    const frame = bytes(
      0x1b, 0x5d, 0x34, 0x32, 0x34, 0x32, 0x3b, 0x31, 0x07,
    );
    expect(classifyByteFrame(frame, ctx())).toBe<PriorityClass>('control');
  });

  // --------- priority merge ---------

  describe('mergePriority', () => {
    it('picks control over visible', () => {
      expect(__testing.mergePriority('control', 'visible')).toBe('control');
      expect(__testing.mergePriority('visible', 'control')).toBe('control');
    });
    it('picks visible over scrollback', () => {
      expect(__testing.mergePriority('visible', 'scrollback')).toBe('visible');
    });
    it('picks scrollback over verbose', () => {
      expect(__testing.mergePriority('scrollback', 'verbose')).toBe(
        'scrollback',
      );
    });
  });

  // --------- default class rule ---------

  describe('computeDefaultDataClass', () => {
    it('returns visible on alt-screen regardless of cursorY', () => {
      expect(
        __testing.computeDefaultDataClass({
          inAltScreen: true,
          cursorY: 100,
          viewportRows: 24,
        }),
      ).toBe('visible');
    });
    it('returns scrollback at the last viewport row', () => {
      expect(
        __testing.computeDefaultDataClass({
          inAltScreen: false,
          cursorY: 23,
          viewportRows: 24,
        }),
      ).toBe('scrollback');
    });
    it('returns visible above the last row', () => {
      expect(
        __testing.computeDefaultDataClass({
          inAltScreen: false,
          cursorY: 5,
          viewportRows: 24,
        }),
      ).toBe('visible');
    });
    it('guards against zero/negative viewport rows', () => {
      expect(
        __testing.computeDefaultDataClass({
          inAltScreen: false,
          cursorY: 0,
          viewportRows: 0,
        }),
      ).toBe('visible');
    });
  });
});

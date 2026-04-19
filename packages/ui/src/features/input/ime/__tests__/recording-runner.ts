/**
 * Replays an IME recording through the pure state machine + Paste
 * encoder. Used by the Korean / JP / CN / deadkey recording tests.
 */
import { createStubMirror, ModeSnapshot } from '../../ModeSnapshot';
import { Paste } from '../../Paste';
import type { Platform } from '../../types';
import type { ImeEvent, ImeSideEffect, ImeState } from '../ime-types';
import { IDLE, classifyKeydown, transition } from '../ImeStateMachine';

export interface RecordingEvent {
  tMs: number;
  kind:
    | 'compositionstart'
    | 'compositionupdate'
    | 'compositionend'
    | 'keydown'
    | 'blur'
    | 'focus'
    | 'sidecar-disconnect'
    | 'persist-timer-expired'
    | 'resize';
  data?: string;
  key?: string;
}

export interface Recording {
  id: string;
  ime: string;
  platform: Platform;
  events: RecordingEvent[];
  expectedPtyBytesHex: string;
  expectedMidCompositionPtyBytes: string[];
  expectedOverlayStates: Array<{ afterTMs: number; visible: boolean; text: string; dimmed?: boolean }>;
  notes?: string;
}

export interface ReplayResult {
  ptyBytesHex: string;
  midCompositionBytesHex: string[];
  overlayTrace: Array<{ tMs: number; visible: boolean; text: string; dimmed: boolean }>;
  effects: ImeSideEffect[];
}

const utf8 = new TextEncoder();

function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function replay(recording: Recording, opts: { bracketedPaste?: boolean } = {}): ReplayResult {
  const mirror = createStubMirror({ bracketedPaste: opts.bracketedPaste ?? false });
  const paste = new Paste({ modeSnapshot: new ModeSnapshot(mirror) });
  let state: ImeState = IDLE;
  let overlayVisible = false;
  let overlayText = '';
  let overlayDimmed = false;
  const overlayTrace: ReplayResult['overlayTrace'] = [];
  const midBytes: string[] = [];
  const ptyParts: Uint8Array[] = [];
  const allEffects: ImeSideEffect[] = [];

  for (const rec of recording.events) {
    const imeEvent = mapToImeEvent(rec);
    if (!imeEvent) continue;
    const { next, effects } = transition(state, imeEvent, {
      platform: recording.platform,
      now: rec.tMs,
    });
    allEffects.push(...effects);
    state = next;

    for (const eff of effects) {
      switch (eff.kind) {
        case 'mount-overlay':
          overlayVisible = true;
          overlayText = eff.text;
          overlayDimmed = false;
          break;
        case 'update-overlay':
          overlayText = eff.text;
          break;
        case 'unmount-overlay':
          overlayVisible = false;
          overlayText = '';
          overlayDimmed = false;
          break;
        case 'dim-overlay':
          overlayDimmed = true;
          break;
        case 'undim-overlay':
          overlayDimmed = false;
          break;
        case 'emit-commit-bytes': {
          const out = paste.encode(eff.paste);
          ptyParts.push(out.bytes);
          break;
        }
        default:
          break;
      }
    }

    // If the state remains Composing and we emitted bytes, that's the
    // mid-composition bug. Record the hex of any bytes tied to non-commit
    // effects since entering Composing.
    if (state.kind === 'Composing') {
      for (const eff of effects) {
        if (eff.kind === 'emit-commit-bytes') {
          const out = paste.encode(eff.paste);
          midBytes.push(toHex(out.bytes));
        }
      }
    }

    overlayTrace.push({
      tMs: rec.tMs,
      visible: overlayVisible,
      text: overlayText,
      dimmed: overlayDimmed,
    });
  }

  const totalLen = ptyParts.reduce((a, p) => a + p.length, 0);
  const flat = new Uint8Array(totalLen);
  let off = 0;
  for (const p of ptyParts) {
    flat.set(p, off);
    off += p.length;
  }

  return {
    ptyBytesHex: toHex(flat),
    midCompositionBytesHex: midBytes,
    overlayTrace,
    effects: allEffects,
  };
}

function mapToImeEvent(rec: RecordingEvent): ImeEvent | null {
  switch (rec.kind) {
    case 'compositionstart':
      return { kind: 'compositionstart', data: rec.data ?? '' };
    case 'compositionupdate':
      return { kind: 'compositionupdate', data: rec.data ?? '' };
    case 'compositionend':
      return { kind: 'compositionend', data: rec.data ?? '' };
    case 'keydown':
      return { kind: classifyKeydown(rec.key ?? '') };
    case 'blur':
      return { kind: 'blur' };
    case 'focus':
      return { kind: 'focus' };
    case 'sidecar-disconnect':
      return { kind: 'sidecar-disconnect' };
    case 'persist-timer-expired':
      return { kind: 'persist-timer-expired' };
    case 'resize':
      return { kind: 'resize' };
  }
}

/** Utility to mass-convert UTF-8 strings to hex for recording authors. */
export function textToHex(s: string): string {
  return toHex(utf8.encode(s));
}

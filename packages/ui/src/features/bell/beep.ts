/**
 * Synthesised bell beep.
 *
 * We deliberately do not ship an audio asset. Instead a single
 * `AudioContext` is created lazily on first invocation, then reused for the
 * lifetime of the page. Each bell schedules a sine-wave oscillator (400 Hz,
 * 60 ms, 0.3 linear gain) and tears it down when done — no ongoing cost
 * between bells.
 *
 * The context is allocated lazily because browsers refuse to start an
 * AudioContext outside a user-gesture frame (Chrome autoplay policy). As
 * long as `playBeep()` is only ever called from the BEL trigger chain that
 * already originated in a user action (the user typed a command, or a
 * command they kicked off is writing BEL), this lazy path is safe. If the
 * context starts suspended anyway, we attempt `resume()` but give up
 * silently on failure — the visual bell still fires either way.
 */

/** Frequency of the bell tone in Hz. Roughly the xterm default region. */
export const BEEP_FREQ_HZ = 400;
/** Duration of the bell tone in milliseconds. */
export const BEEP_DURATION_MS = 60;
/** Linear peak gain of the bell tone (0..1). */
export const BEEP_GAIN = 0.3;

type Ctor = typeof AudioContext;

let shared: AudioContext | null = null;
let unsupported = false;

function getCtor(): Ctor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: Ctor;
    webkitAudioContext?: Ctor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function ensureContext(): AudioContext | null {
  if (unsupported) return null;
  if (shared !== null) return shared;
  const Ctor = getCtor();
  if (Ctor === null) {
    unsupported = true;
    return null;
  }
  try {
    shared = new Ctor();
  } catch {
    unsupported = true;
    return null;
  }
  return shared;
}

export function playBeep(): void {
  const ctx = ensureContext();
  if (ctx === null) return;
  if (ctx.state === 'suspended') {
    // Fire-and-forget. If resume fails (no user gesture yet), the oscillator
    // will simply not produce audible output — no error to surface.
    ctx.resume().catch(() => undefined);
  }
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(BEEP_FREQ_HZ, ctx.currentTime);
    gain.gain.setValueAtTime(BEEP_GAIN, ctx.currentTime);
    // Short linear fade so we don't emit an audible click on teardown.
    gain.gain.linearRampToValueAtTime(
      0,
      ctx.currentTime + BEEP_DURATION_MS / 1000,
    );
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + BEEP_DURATION_MS / 1000);
  } catch {
    // Hostile environment — don't let audio failure take down the UI.
  }
}

/** Test-only: drop the shared context so a fresh mock can be installed. */
export function _resetBeepForTests(): void {
  shared = null;
  unsupported = false;
}

/**
 * Minimal typed event bus. Used by features/widgets to broadcast intra-UI
 * events (e.g. "focus terminal") without forcing a prop-drilled callback.
 *
 * The event bus is NOT a replacement for the host bridge or Zustand store —
 * it exists for UI-affordance notifications, not for state.
 */

export type BusListener<T> = (payload: T) => void;

export interface BusHandle {
  readonly unsubscribe: () => void;
}

export class EventBus<Events> {
  readonly #listeners = new Map<keyof Events, Set<BusListener<unknown>>>();

  on<K extends keyof Events>(event: K, listener: BusListener<Events[K]>): BusHandle {
    const key = event;
    let set = this.#listeners.get(key);
    if (!set) {
      set = new Set();
      this.#listeners.set(key, set);
    }
    set.add(listener as BusListener<unknown>);
    return {
      unsubscribe: () => {
        const s = this.#listeners.get(key);
        if (!s) return;
        s.delete(listener as BusListener<unknown>);
        if (s.size === 0) this.#listeners.delete(key);
      },
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const l of set) (l as BusListener<Events[K]>)(payload);
  }
}

/** Global UI event bus. Events defined here are UI-only by convention. */
export type UiEvents = {
  'terminal.focus': void;
  'terminal.copy': void;
  'terminal.paste': void;
};

export const uiBus = new EventBus<UiEvents>();

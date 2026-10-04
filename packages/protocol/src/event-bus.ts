// The one way the runtime reports anything (data-models §10, ADR-015).
//
// Tiny on purpose: no dependencies, synchronous delivery, and one misbehaving
// subscriber cannot silence the others. There is no console output in library code
// (CODING_AGENT §7), so a handler that throws is reported through the optional
// `onError` callback and otherwise dropped — the emitter is never the thing that
// fails.

import type { BosEvent } from './events.js';

export type EventHandler = (event: BosEvent) => void;
export type EventType = BosEvent['type'];
export type Unsubscribe = () => void;

export interface EventBusOptions {
  /** Called when a handler throws. Without it, the error is swallowed by design. */
  onError?: (error: unknown, event: BosEvent) => void;
}

export class EventBus {
  readonly #handlers = new Map<EventType, Set<EventHandler>>();
  readonly #wildcard = new Set<EventHandler>();
  readonly #onError: ((error: unknown, event: BosEvent) => void) | undefined;

  constructor(opts: EventBusOptions = {}) {
    this.#onError = opts.onError;
  }

  /**
   * Subscribes to one event type, or to every type with '*'. Returns the
   * unsubscribe function — the only way to remove a handler.
   */
  on(type: EventType | '*', handler: EventHandler): Unsubscribe {
    const target = type === '*' ? this.#wildcard : this.#handlersOf(type);
    target.add(handler);
    return () => {
      target.delete(handler);
    };
  }

  #handlersOf(type: EventType): Set<EventHandler> {
    let set = this.#handlers.get(type);
    if (set === undefined) {
      set = new Set<EventHandler>();
      this.#handlers.set(type, set);
    }
    return set;
  }

  /** Delivers synchronously to every matching handler. */
  emit(event: BosEvent): void {
    // Iterate snapshots: a handler may subscribe or unsubscribe while we deliver.
    const targeted = [...(this.#handlers.get(event.type) ?? [])];
    const wildcard = [...this.#wildcard];
    for (const handler of [...targeted, ...wildcard]) {
      try {
        handler(event);
      } catch (error) {
        this.#onError?.(error, event);
      }
    }
  }

  /** Number of handlers for one type, or for all types when `type` is omitted. */
  listenerCount(type?: EventType | '*'): number {
    if (type === '*') return this.#wildcard.size;
    if (type !== undefined) return this.#handlers.get(type)?.size ?? 0;
    let total = this.#wildcard.size;
    for (const set of this.#handlers.values()) total += set.size;
    return total;
  }
}

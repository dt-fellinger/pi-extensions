/**
 * Typed internal event bus for pi-investigate.
 *
 * Minimal mitt-style implementation — no external dependency required.
 */

import type { InvestigateEventBus, InvestigateEvents } from "./types.js";

type Handler<K extends keyof InvestigateEvents> = (...args: InvestigateEvents[K]) => void;

export function createEventBus(): InvestigateEventBus {
  const listeners = new Map<keyof InvestigateEvents, Set<Handler<keyof InvestigateEvents>>>();

  function getSet<K extends keyof InvestigateEvents>(event: K): Set<Handler<K>> {
    if (!listeners.has(event)) {
      listeners.set(event, new Set());
    }
    return listeners.get(event) as Set<Handler<K>>;
  }

  return {
    emit<K extends keyof InvestigateEvents>(event: K, ...args: InvestigateEvents[K]) {
      for (const handler of getSet(event)) {
        (handler as (...a: InvestigateEvents[K]) => void)(...args);
      }
    },
    on<K extends keyof InvestigateEvents>(event: K, handler: Handler<K>) {
      getSet(event).add(handler);
    },
    off<K extends keyof InvestigateEvents>(event: K, handler: Handler<K>) {
      getSet(event).delete(handler);
    },
  };
}

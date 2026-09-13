// The observable state store: events in, derived state out, subscribers told.
//
// This is the path the failure autopsy found unguarded. Every synchronisation
// requirement constrained how data moves *between* devices; none constrained
// how it moves from a device's own state to its own screen. A phone that syncs
// perfectly, merges correctly and still shows yesterday's list is, to the
// person holding it, identical to one that never received the tick.
//
// FR-SYNC-7, ARCHITECTURE.md §11.1. Pure: no DOM, no storage, no network.

import { merge } from './merge.js';

const snapshotOf = (state) =>
  JSON.stringify([...state].map(([k, v]) => [k, v.value]).sort());

export function createStore(initial = []) {
  const byId = new Map();
  let state = new Map();
  let signature = snapshotOf(state);
  let version = 0;
  const subscribers = new Set();

  function recompute() {
    state = merge([...byId.values()]);
    const next = snapshotOf(state);
    const changed = next !== signature;
    signature = next;
    if (changed) version += 1;
    return changed;
  }

  const store = {
    get version() { return version; },
    get events() { return [...byId.values()]; },
    get state() { return state; },

    /** Resolved value of one register, or undefined. */
    get(key) { return state.get(key)?.value; },

    /**
     * Take in events from anywhere — this device, a sync, a snapshot — and
     * notify if the answer changed.
     *
     * Events already held are ignored, so the same event arriving twice does
     * not cause a spurious re-render. Notification happens *after* state is
     * updated, so a subscriber that reads `store.state` while being notified
     * sees the new value. There is no window in which a subscriber can observe
     * the old answer.
     */
    apply(events) {
      let added = false;
      for (const e of [].concat(events)) {
        if (byId.has(e.id)) continue;
        byId.set(e.id, e);
        added = true;
      }
      if (!added) return false;
      if (!recompute()) return false;      // events arrived but changed nothing
      for (const fn of [...subscribers]) fn(state, version);
      return true;
    },

    /**
     * Subscribe to changes. The subscriber is called immediately with current
     * state, so there is no way to write a view that reads once at mount and
     * then drifts — which is the shape the autopsy's cause (c) takes in
     * practice. Returns an unsubscribe function.
     */
    subscribe(fn) {
      subscribers.add(fn);
      fn(state, version);
      return () => subscribers.delete(fn);
    },
  };

  store.apply(initial);
  return store;
}

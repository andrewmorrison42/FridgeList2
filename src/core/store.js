// The observable state store: events in, derived state out, subscribers told.
//
// This is the path the failure autopsy found unguarded (FR-SYNC-7): a phone
// that syncs perfectly, merges correctly and still shows yesterday's list is,
// to the person holding it, one that never received the tick.
//
// Incremental since review #6. It used to re-merge every event on every tick —
// about 1,100 events for this household, most of them library events that
// cannot change during a shop — at 22 ms a tick before anything was drawn. Now
// only the registers a new event touches are re-resolved. It must still equal a
// full merge exactly; test/store.test.js asserts that for any delivery order
// and any batching.
//
// Pure: no DOM, no storage, no network. ARCHITECTURE.md §11.1.

import { resolveGroup } from './merge.js';
import { tryKeyOf } from './keys.js';

/**
 * What a subscriber can observe of a register: its value, and which events
 * decided it. Value alone is not enough — a second concurrent lock leaves the
 * lock register `true` but changes the shop's list, because the lists are
 * unioned. Comparing values alone missed that and left the screen stale.
 */
const signatureOf = (r) => JSON.stringify([r.value, r.by.map((e) => e.id).sort()]);

export function createStore(initial = []) {
  const byId = new Map();              // every event, in arrival order
  const groups = new Map();            // register key -> its events
  const state = new Map();             // register key -> resolved
  const signatures = new Map();        // register key -> what subscribers can observe
  let version = 0;
  const subscribers = new Set();
  const eventListeners = new Set();

  const store = {
    /** Advances exactly once per observable change. Derivations cache on it. */
    get version() { return version; },
    get events() { return [...byId.values()]; },
    /** Resolved registers. Read-only to callers; replaced in place as events arrive. */
    get state() { return state; },

    /** Resolved value of one register, or undefined. */
    get(key) { return state.get(key)?.value; },

    /**
     * Take in events from anywhere — this device, a sync, a snapshot — and
     * notify if anything observable changed.
     *
     * Events already held are ignored, so the same event arriving twice causes
     * no spurious re-render. Notification happens *after* state is updated, so
     * a subscriber reading `store.state` while being notified sees the new
     * value. There is no window in which it can observe the old answer.
     */
    apply(events) {
      const added = [];
      const dirty = new Set();
      for (const e of [].concat(events)) {
        if (byId.has(e.id)) continue;
        byId.set(e.id, e);
        added.push(e);
        // An event this version cannot key is kept and synced onward, but
        // interpreted by nothing here (see groupByKey in merge.js).
        const key = tryKeyOf(e);
        if (key === null) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(e);
        dirty.add(key);
      }
      if (added.length === 0) return false;

      // Every new event, whether or not it changes anything: persistence and
      // the device clock hang off this, and history not saved is history lost.
      for (const fn of [...eventListeners]) fn(added);

      let changed = false;
      for (const key of dirty) {
        const resolved = resolveGroup(groups.get(key));
        state.set(key, resolved);
        const sig = signatureOf(resolved);
        if (sig !== signatures.get(key)) { signatures.set(key, sig); changed = true; }
      }
      if (!changed) return false;          // events arrived but changed nothing observable

      version += 1;
      for (const fn of [...subscribers]) fn(state, version);
      return true;
    },

    /**
     * Subscribe to observable changes. Called immediately with current state,
     * so there is no way to write a view that reads once at mount and then
     * drifts — the shape the autopsy's cause (c) takes. Returns unsubscribe.
     */
    subscribe(fn) {
      subscribers.add(fn);
      fn(state, version);
      return () => subscribers.delete(fn);
    },

    /** Every batch of genuinely new events, changed state or not. Returns unsubscribe. */
    onEvents(fn) {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
  };

  store.apply(initial);
  return store;
}

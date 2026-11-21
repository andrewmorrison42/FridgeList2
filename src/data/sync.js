// The sync engine: local-first writes, deferred upload, delta polling,
// compaction. ARCHITECTURE.md §7.
//
// Every user action is applied locally and persisted before any network call.
// The UI reads local state. Upload happens afterwards and may fail without the
// user losing anything (FR-SYNC-6). A dead spot by the freezers costs
// propagation delay, never data.

import { currentShop } from '../core/shop.js';
import { NOT_MODIFIED } from './storage.js';

const BACKOFF_MS = [2000, 4000, 8000, 16000, 30000];

/** Which file an event belongs in: shop-scoped, or the long-lived state log. */
export function pathFor(event, deviceId) {
  const shopId = event.payload?.shopId;
  const shopScoped = shopId && ['line.done', 'line.added', 'line.suppressed',
    'carryover.dismissed', 'shop.locked', 'shop.closed'].includes(event.type);
  return shopScoped
    ? `shops/${shopId}/log/${deviceId}.jsonl`
    : `state/log/${deviceId}.jsonl`;
}

// `persist` saves events on this device (IndexedDB). It is called with every
// event that arrives — this device's own and those read from the folder —
// whether or not it changed the answer: an own event left unsaved would be
// lost at the next reload, and its id handed out again to a different event,
// which every other phone would then ignore.
export function createSync({ storage, store, deviceId, now = () => Date.now(), persist = () => {} }) {
  const etags = new Map();          // path -> last etag seen
  let cursor = undefined;
  // Events emitted here, not yet confirmed up. It starts with every event this
  // device has ever made, not empty: the queue lives in memory, so anything
  // not uploaded before the app last closed — a failed write, a change made
  // before connecting — would otherwise stay on this phone for good. Writing
  // a device's own files again is harmless (push rewrites each whole), so the
  // first tick of every session makes sure the folder has all of them.
  let unsent = store.events.filter((e) => e.dev === deviceId);
  let failures = 0;
  let lastPullAt = null;
  let lastPushAt = null;
  let lastError = null;

  /** Record a locally created event: local state first, upload afterwards. */
  function record(events) {
    const list = [].concat(events);
    persist(list);
    store.apply(list);              // FR-SYNC-7 — the screen updates now
    unsent.push(...list);
    return list;
  }

  /** Everything this device has that belongs in `path`. */
  function ownEventsFor(path) {
    return store.events.filter((e) => e.dev === deviceId && pathFor(e, deviceId) === path);
  }

  /**
   * Write this device's own files. Never anyone else's — that rule is what
   * removes the lost-update window entirely (§4).
   */
  async function push() {
    const paths = new Set(unsent.map((e) => pathFor(e, deviceId)));
    if (paths.size === 0) return { pushed: 0 };
    let pushed = 0;
    for (const path of paths) {
      const events = ownEventsFor(path);
      try {
        await storage.write(path, events.map((e) => JSON.stringify(e)).join('\n'));
        // Only events actually written are cleared from the queue. A failed
        // write leaves them queued, and the file's previous version intact.
        unsent = unsent.filter((e) => pathFor(e, deviceId) !== path);
        pushed += events.length;
        failures = 0;
        lastError = null;
      } catch (err) {
        failures += 1;
        lastError = err.message;
      }
    }
    lastPushAt = now();
    return { pushed };
  }

  /** Fetch what changed elsewhere and merge it. */
  async function pull() {
    let changed;
    try {
      const d = await storage.delta(cursor);
      cursor = d.cursor;
      changed = d.changes;
    } catch (err) {
      failures += 1;
      lastError = err.message;
      return { applied: 0, ok: false };
    }

    let applied = 0;
    for (const path of changed) {
      // Only the phones' logs. The folder is shared with the earlier app and
      // holds its files too (recipes-data.json, shopping-list.json, backups),
      // and a snapshot duplicates a log that is rewritten alongside it.
      if (!/(^|\/)log\/[^/]+\.jsonl$/.test(path)) continue;
      if (path.endsWith(`${deviceId}.jsonl`)) continue;      // our own writing
      if (path.includes('/presence/')) continue;             // handled by presence.js
      try {
        const got = await storage.read(path, etags.get(path));
        if (got === NOT_MODIFIED || got === null) continue;
        etags.set(path, got.etag);
        const events = got.content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
        persist(events);
        if (store.apply(events)) applied += events.length;
      } catch (err) {
        lastError = err.message;                             // one bad file must
        continue;                                            // not stop the rest
      }
    }
    lastPullAt = now();
    failures = 0;
    return { applied, ok: true };
  }

  // No compaction yet. A version that wrote compacted snapshots was undone by
  // the next upload (the store still held every event) and so ran again on
  // every tick once a log was big enough. It comes back only together with a
  // store that drops what it compacts. ARCHITECTURE.md §7.5.

  /**
   * How current is this device? FR-SYNC-2 — never present stale data
   * indistinguishably from current data.
   */
  function status() {
    const { phase } = currentShop(store.events);
    return {
      deviceId,
      phase,
      unsent: unsent.length,
      // Separated because they mean different things to a person: ticks not yet
      // shared are urgent, a recipe edit is not.
      unsentShop: unsent.filter((e) => pathFor(e, deviceId).startsWith('shops/')).length,
      lastPullAt,
      lastPushAt,
      lastError,
      ageMs: lastPullAt === null ? null : now() - lastPullAt,
      // A device with a backoff pending or unsent events says so rather than
      // implying it is up to date.
      /** Why the last upload failed, while it is still failing. */
      pushError: unsent.length > 0 ? lastError : null,
      healthy: failures === 0 && unsent.length === 0,
      retryInMs: failures === 0 ? 0 : BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)],
    };
  }

  /** One cycle. The app drives this on an interval; tests drive it directly. */
  async function tick() {
    return { ...(await pull()), ...(await push()) };
  }

  /**
   * Poll fast while shopping, lazily otherwise. Ticks propagate in a few
   * seconds; a recipe edit at the kitchen table is not urgent. §7.3.
   */
  function intervalMs() {
    return currentShop(store.events).phase === 'open' ? 3000 : 15000;
  }

  return { record, push, pull, tick, status, intervalMs, pathFor };
}

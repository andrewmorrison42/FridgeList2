// The sync engine: local-first writes, deferred upload, delta polling,
// compaction. ARCHITECTURE.md §7.
//
// Every user action is applied locally and persisted before any network call.
// The UI reads local state. Upload happens afterwards and may fail without the
// user losing anything (FR-SYNC-6). A dead spot by the freezers costs
// propagation delay, never data.

import { compact } from '../core/merge.js';
import { currentShop } from '../core/shop.js';
import { NOT_MODIFIED } from './storage.js';

const COMPACT_BYTES = 256 * 1024;
const COMPACT_EVENTS = 2000;
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

export function createSync({ storage, store, deviceId, now = () => Date.now() }) {
  const etags = new Map();          // path -> last etag seen
  const snapshotSeq = new Map();    // path prefix -> n
  let cursor = undefined;
  let unsent = [];                  // events emitted here, not yet confirmed up
  let failures = 0;
  let lastPullAt = null;
  let lastPushAt = null;
  let lastError = null;

  /** Record a locally created event: local state first, upload afterwards. */
  function record(events) {
    const list = [].concat(events);
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
      if (path.endsWith(`${deviceId}.jsonl`)) continue;      // our own writing
      if (path.includes('/presence/')) continue;             // handled by presence.js
      try {
        const got = await storage.read(path, etags.get(path));
        if (got === NOT_MODIFIED || got === null) continue;
        etags.set(path, got.etag);
        const events = got.content.split('\n').filter(Boolean).map((l) => JSON.parse(l));
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

  /**
   * Compaction: a log with dead events removed, written as a per-device
   * snapshot. Never a shared file — two devices compacting at once cannot
   * collide, and a device deletes only its own older snapshots. §7.5.
   */
  async function maybeCompact(path) {
    const events = ownEventsFor(path);
    const bytes = events.reduce((n, e) => n + JSON.stringify(e).length, 0);
    if (bytes < COMPACT_BYTES && events.length < COMPACT_EVENTS) return false;

    const kept = compact(events);
    if (kept.length === events.length) return false;
    const prefix = path.replace(/log\/.*$/, 'snapshot/');
    const n = (snapshotSeq.get(prefix) ?? 0) + 1;
    await storage.write(`${prefix}${deviceId}-${n}.json`, JSON.stringify(kept));
    await storage.write(path, kept.map((e) => JSON.stringify(e)).join('\n'));
    if (n > 1) await storage.remove(`${prefix}${deviceId}-${n - 1}.json`).catch(() => {});
    snapshotSeq.set(prefix, n);
    return true;
  }

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
      lastPullAt,
      lastPushAt,
      lastError,
      ageMs: lastPullAt === null ? null : now() - lastPullAt,
      // A device with a backoff pending or unsent events says so rather than
      // implying it is up to date.
      healthy: failures === 0 && unsent.length === 0,
      retryInMs: failures === 0 ? 0 : BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)],
    };
  }

  /** One cycle. The app drives this on an interval; tests drive it directly. */
  async function tick() {
    const out = { ...(await pull()), ...(await push()) };
    for (const path of new Set(store.events.filter((e) => e.dev === deviceId).map((e) => pathFor(e, deviceId)))) {
      await maybeCompact(path);
    }
    return out;
  }

  /**
   * Poll fast while shopping, lazily otherwise. Ticks propagate in a few
   * seconds; a recipe edit at the kitchen table is not urgent. §7.3.
   */
  function intervalMs() {
    return currentShop(store.events).phase === 'open' ? 3000 : 60000;
  }

  return { record, push, pull, tick, status, intervalMs, maybeCompact, pathFor };
}

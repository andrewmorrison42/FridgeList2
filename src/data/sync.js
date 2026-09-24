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
  // Peer files that could not be read, by path. Persists across pulls: delta
  // only reports a file when it changes, so a damaged file that is never
  // rewritten would otherwise be forgotten after one pull — and that peer's
  // ticks would be missing while this device said it was current.
  const unreadable = new Map();
  // Events emitted here and not yet confirmed written. Seeded with every event
  // this device holds of its own: the queue used to live only in memory, so a
  // tick made in a dead spot, then the app killed in a pocket, was never
  // uploaded after reopening — and the device reported healthy. Rewriting our
  // own files is idempotent (§4), so treating everything as unconfirmed until
  // the first successful write costs one write per file and loses nothing.
  let unsent = store.events.filter((e) => e.dev === deviceId);
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
    if (paths.size === 0) return { pushed: 0, written: [] };
    let pushed = 0;
    const written = [];
    for (const path of paths) {
      const events = ownEventsFor(path);
      try {
        await storage.write(path, events.map((e) => JSON.stringify(e)).join('\n'));
        // Only events actually written are cleared from the queue. A failed
        // write leaves them queued, and the file's previous version intact.
        unsent = unsent.filter((e) => pathFor(e, deviceId) !== path);
        pushed += events.length;
        written.push(path);
        failures = 0;
        lastError = null;
      } catch (err) {
        failures += 1;
        lastError = err.message;
      }
    }
    lastPushAt = now();
    return { pushed, written };
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
      let got;
      try {
        got = await storage.read(path, etags.get(path));
      } catch (err) {
        lastError = err.message;                             // one bad file must
        continue;                                            // not stop the rest
      }
      if (got === NOT_MODIFIED || got === null) continue;
      etags.set(path, got.etag);

      // Parse line by line. A damaged file — truncated by a non-atomic write,
      // or corrupted any other way — still yields every intact event, so the
      // ticks we *can* read are kept; only the damage is reported.
      const events = [];
      let bad = 0;
      for (const line of got.content.split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch { bad += 1; }
      }
      if (bad > 0) {
        unreadable.set(path, { path, deviceId: deviceOf(path), badLines: bad });
        lastError = `could not read ${bad} line(s) of ${path}`;
      } else {
        unreadable.delete(path);
      }
      if (events.length && store.apply(events)) applied += events.length;
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

  /** The device that owns a file, from its path — every data file is named for its writer (§4). */
  function deviceOf(path) {
    const m = /\/([^/]+?)(?:-\d+)?\.jsonl?$/.exec(path);
    return m ? m[1] : path;
  }

  /**
   * How current is this device? FR-SYNC-2 — never present stale data
   * indistinguishably from current data.
   */
  function status() {
    const { phase } = currentShop(store.state);
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
      // Files we could not read mean another device's ticks may be missing
      // here. That is not "up to date", however recently we polled.
      unreadable: [...unreadable.values()],
      // A device with a backoff pending, unsent events, or unreadable peer
      // files says so rather than implying it is up to date.
      healthy: failures === 0 && unsent.length === 0 && unreadable.size === 0,
      retryInMs: failures === 0 ? 0 : BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)],
    };
  }

  /** One cycle. The app drives this on an interval; tests drive it directly. */
  async function tick() {
    const pulled = await pull();
    const pushed = await push();
    // A log only grows when this device writes it, so compaction only needs
    // checking for files just written — not every file, every three seconds.
    for (const path of pushed.written) await maybeCompact(path);
    return { ...pulled, ...pushed };
  }

  /**
   * Poll fast while shopping, lazily otherwise. Ticks propagate in a few
   * seconds; a recipe edit at the kitchen table is not urgent. §7.3.
   */
  function intervalMs() {
    return currentShop(store.state).phase === 'open' ? 3000 : 60000;
  }

  return { record, push, pull, tick, status, intervalMs, maybeCompact, pathFor };
}

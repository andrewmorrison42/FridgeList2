// The merge rules: how a set of events becomes one shared answer.
//
// This is the file FR-SYNC-1 lives in. Every resolution decision belongs here
// and nowhere else — a decision made elsewhere is a decision no property test
// is watching. ARCHITECTURE.md §5.4, §5.5, §11.

import { maximal } from './events.js';
import { K, keyOf, tryKeyOf, parseKey } from './keys.js';

export { keyOf };

// ---------------------------------------------------------------------------
// Keying lives in keys.js — both building keys and reading them back.
// ---------------------------------------------------------------------------

/** Which payload field carries this event's value. */
const FIELD = {
  'line.done': 'done',
  'line.added': 'present',
  'line.suppressed': 'suppressed',
  'menu.selection': 'present',
  'menu.cooked': 'cooked',
  'waitlist.item': 'present',
  'carryover.dismissed': 'dismissed',
  'recipe.upsert': 'recipe',
  'ingredient.upsert': 'ingredient',
  'history.imported': 'trips',
  'shop.locked': 'locked',
  'shop.closed': 'closed',
};

// Every register in this system biases towards `true` on concurrency, and they
// are all the same underlying guarantee: a tick, an addition, a lock and a
// close are all facts that someone asserted, and a concurrent event — made by
// someone who could not see that assertion — must not erase it. §5.4, §5.5.
const TRUE_WINS = new Set(Object.keys(FIELD));

// Library edits are the one exception: last-save-wins, deterministically
// tie-broken. Edits are rare and made in the moment by whoever is cooking, and
// the failure mode is a field value someone can retype — not a vanished tick.
// This is also the one place where `ts` legitimately decides an outcome, which
// is why test/harness.js says a last-save-wins field must be projected out of
// the invariance comparison rather than the harness being loosened. §5.5, §14.1.
TRUE_WINS.delete('recipe.upsert');
TRUE_WINS.delete('ingredient.upsert');
TRUE_WINS.delete('history.imported');

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Deterministic ordering for last-save-wins. Every device computes the same. */
export function lwwCompare(a, b) {
  if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
  if (a.dev !== b.dev) return a.dev < b.dev ? -1 : 1;
  return a.seq - b.seq;
}

/**
 * Resolve one register from the events about it.
 *
 * The rule, in one sentence: **if any event in the maximal set says true, the
 * answer is true.** Only if every maximal event says false is it false.
 *
 * Read what that means for a tick. An untick takes effect only when it is
 * causally after *every* tick on that line — that is, only when the person
 * unticking had already seen the tick they were undoing. A concurrent untick,
 * made by someone who could not see it, leaves the tick standing. That is
 * precisely FR-SYNC-1's "a distinct, later, explicit action", with "later"
 * meaning what the user could see rather than what their phone thought the
 * time was.
 */
export function resolve(events, { trueWins = true } = {}) {
  if (events.length === 0) return { value: undefined, conflict: false, by: [] };

  const top = maximal(events);
  const field = FIELD[top[0].type];
  const values = top.map((e) => e.payload[field]);
  const conflict = new Set(values.map((v) => JSON.stringify(v))).size > 1;

  if (trueWins && values.some((v) => v === true)) {
    return { value: true, conflict, by: top.filter((e) => e.payload[field] === true) };
  }
  if (trueWins) {
    return { value: values[0] ?? false, conflict, by: top };
  }
  const winner = [...top].sort(lwwCompare).at(-1);
  return { value: winner.payload[field], conflict, by: [winner] };
}

/**
 * Group events by the register they address.
 *
 * An event that cannot be keyed is skipped, never fatal. Phones update at
 * different times: a phone on a newer version may emit an event type this one
 * has never heard of, and that must not take down this phone's whole list.
 * Such events are kept in the log and synced onward untouched — only this
 * version declines to interpret them.
 */
export function groupByKey(events) {
  const out = new Map();
  for (const e of events) {
    const k = tryKeyOf(e);
    if (k === null) continue;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(e);
  }
  return out;
}

/**
 * Merge an event set into resolved registers.
 *
 * Order-independent and idempotent by construction: the answer depends only on
 * the causal relationships between events, not on the order they arrived or
 * how many times. §14 P2.
 */
export function merge(events) {
  const state = new Map();
  for (const [key, group] of groupByKey(events)) state.set(key, resolveGroup(group));
  return state;
}

/**
 * Resolve one register's events, choosing true-wins or last-save-wins by type.
 * The one place that choice is made: the full merge above and the incremental
 * store both call this, so they cannot disagree about how anything resolves.
 */
export function resolveGroup(group) {
  return resolve(group, { trueWins: TRUE_WINS.has(group[0].type) });
}

/**
 * Every derivation in core accepts either raw events or an already-merged
 * state, and calls this first. Tests pass events; the app passes the store's
 * state so nothing is merged twice. One rule, applied everywhere, rather than
 * two parallel sets of functions.
 */
export const stateOf = (x) => (x instanceof Map ? x : merge(x));

/** Convenience: is this line ticked? */
export function isDone(events, shopId, ingredientId) {
  const r = stateOf(events).get(K.lineDone(shopId, ingredientId));
  return r?.value === true;
}

/**
 * Lines independently ticked on more than one device — informational, not an
 * error. Someone bought it twice, or picked it up and forgot to say. FR-SYNC-4.2.
 */
export function doubleTicked(events) {
  const out = [];
  for (const [key, group] of groupByKey(events)) {
    if (parseKey(key)?.kind !== 'lineDone') continue;
    const r = resolve(group, { trueWins: true });
    if (r.value === true && new Set(r.by.map((e) => e.dev)).size > 1) {
      out.push({ key, devices: [...new Set(r.by.map((e) => e.dev))] });
    }
  }
  return out;
}

/**
 * Lines where a tick and an untick are genuinely concurrent — the two people
 * disagreed without seeing each other. Surfaced at reconcile rather than
 * silently resolved, so they can settle it out loud. §8.4.
 */
export function disagreements(events) {
  const out = [];
  for (const [key, group] of groupByKey(events)) {
    if (parseKey(key)?.kind !== 'lineDone') continue;
    const r = resolve(group, { trueWins: true });
    if (r.conflict) out.push({ key, events: maximal(group) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Drop events that can no longer affect the answer.
 *
 * A compacted set is *an event log with dead events removed* — not a different
 * kind of thing — so merging snapshots and logs uses this same code, and
 * compaction adds no new place for a tick to disappear.
 *
 * Only non-maximal events go: an event superseded by one that causally follows
 * it cannot change any future merge, because causality is computed from version
 * vectors (by sequence number) rather than by pointing at events that must
 * still exist. §7.5, §14 P5.
 */
export function compact(events) {
  const kept = [];
  for (const group of groupByKey(events).values()) kept.push(...maximal(group));
  return kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

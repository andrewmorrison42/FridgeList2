// The merge rules: how a set of events becomes one shared answer.
//
// This is the file FR-SYNC-1 lives in. Every resolution decision belongs here
// and nowhere else — a decision made elsewhere is a decision no property test
// is watching. ARCHITECTURE.md §5.4, §5.5, §11.

import { maximal } from './events.js';

// ---------------------------------------------------------------------------
// Keying: which thing does an event talk about?
// ---------------------------------------------------------------------------

// A line is identified by (shopId, ingredientId) — never by name, position, or
// a per-device id. Two devices adding the same ingredient produce events about
// the *same* line, which merge, rather than two lines needing de-duplication
// later, which would have to decide whose tick to keep. §5.6.
const lineKey = (p) => `line:${p.shopId}:${p.ingredientId}`;

export function keyOf(event) {
  const p = event.payload;
  switch (event.type) {
    case 'line.done':      return `${lineKey(p)}:done`;
    case 'line.added':     return `${lineKey(p)}:present`;
    case 'line.suppressed':return `${lineKey(p)}:suppressed`;
    case 'menu.selection': return `menu:${p.recipeId}:present`;
    case 'menu.cooked':    return `menu:${p.recipeId}:cooked`;
    case 'waitlist.item':  return `waitlist:${p.itemId}:present`;
    case 'carryover.dismissed': return `carryover:${p.shopId}:${p.ingredientId}`;
    case 'shop.locked':    return `shop:${p.shopId}:locked`;
    case 'shop.closed':    return `shop:${p.shopId}:closed`;
    default: throw new Error(`unkeyed event type: ${event.type}`);
  }
}

/** Which payload field carries this event's value. */
const FIELD = {
  'line.done': 'done',
  'line.added': 'present',
  'line.suppressed': 'suppressed',
  'menu.selection': 'present',
  'menu.cooked': 'cooked',
  'waitlist.item': 'present',
  'carryover.dismissed': 'dismissed',
  'shop.locked': 'locked',
  'shop.closed': 'closed',
};

// Every register in this system biases towards `true` on concurrency, and they
// are all the same underlying guarantee: a tick, an addition, a lock and a
// close are all facts that someone asserted, and a concurrent event — made by
// someone who could not see that assertion — must not erase it. §5.4, §5.5.
const TRUE_WINS = new Set(Object.keys(FIELD));

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Deterministic ordering for last-save-wins. Every device computes the same. */
function lwwCompare(a, b) {
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

/** Group events by the register they address. */
export function groupByKey(events) {
  const out = new Map();
  for (const e of events) {
    const k = keyOf(e);
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
  for (const [key, group] of groupByKey(events)) {
    const trueWins = TRUE_WINS.has(group[0].type);
    state.set(key, resolve(group, { trueWins }));
  }
  return state;
}

/** Convenience: is this line ticked? */
export function isDone(events, shopId, ingredientId) {
  const r = merge(events).get(`line:${shopId}:${ingredientId}:done`);
  return r?.value === true;
}

/**
 * Lines independently ticked on more than one device — informational, not an
 * error. Someone bought it twice, or picked it up and forgot to say. FR-SYNC-4.2.
 */
export function doubleTicked(events) {
  const out = [];
  for (const [key, group] of groupByKey(events)) {
    if (!key.endsWith(':done')) continue;
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
    if (!key.endsWith(':done')) continue;
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

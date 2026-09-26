// Event construction, device clocks, and causality.
//
// Everything in this system is an append-only event; state is derived by
// merging (see merge.js). Ordering is established by *causality* — what a
// device had actually seen when it acted — never by wall-clock time.
// ARCHITECTURE.md §5.1–§5.3.

/** Event types, and the shop phase in which each may be created. §5.9 */
export const PHASES = ['draft', 'open', 'closed'];

// The `open` column of §5.9's table contains no destructive operation at all.
// That is the point of it: a removal racing a tick cannot happen, because
// removals do not exist in the only window where ticks do.
const PERMITTED = {
  'menu.selection':  ['draft'],           // add AND remove — locked by FR-SHOP-3
  'menu.cooked':     ['draft', 'open'],   // not a menu change (FR-MENU-2)
  'menu.carried':    ['draft'],           // set membership, not a counter (§9.1)
  'line.added':      ['draft', 'open'],   // FR-SHOP-1
  'line.suppressed': ['draft'],           // the pantry check (FR-LIST-3)
  'line.done':       ['open'],            // FR-LIST-5
  'waitlist.item':   ['draft', 'open'],   // additions only while open — see below
  'carryover.dismissed': ['draft', 'open'],
  // Any user may edit any recipe at any time (FR-REC-2, absolute). An open
  // shop is unaffected because it holds its own resolved lines (§6), so
  // whoever is cooking cannot alter a list someone is shopping from.
  'recipe.upsert':     ['draft', 'open', 'closed'],
  'ingredient.upsert': ['draft', 'open', 'closed'],
  'shop.locked':     ['draft'],
  'shop.closed':     ['open'],
};

/**
 * Is this event permitted in this phase? §5.9, FR-SHOP-3.
 * Rejected at creation, never filtered during merge: an invalid event that can
 * exist will eventually arrive in an order nobody planned for (§8.5).
 */
export function isPermitted(type, phase, payload = {}) {
  const allowed = PERMITTED[type];
  if (!allowed || !allowed.includes(phase)) return false;
  // A Wait List item may be added during a shop but never removed — the
  // addition is a deliberate, purely additive decision (§8.1).
  if (type === 'waitlist.item' && phase === 'open' && payload.present === false) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Version vectors
// ---------------------------------------------------------------------------

/** How far along device `dev` a vector has seen. Absent means nothing. */
export const vvGet = (vv, dev) => vv[dev] ?? 0;

/** Pointwise maximum — everything either vector has seen. */
export function vvMerge(a, b) {
  const out = { ...a };
  for (const dev of Object.keys(b)) {
    if (vvGet(b, dev) > vvGet(out, dev)) out[dev] = b[dev];
  }
  return out;
}

/** Does `a` cover everything `b` has seen? */
export function vvCovers(a, b) {
  return Object.keys(b).every((dev) => vvGet(a, dev) >= vvGet(b, dev));
}

/** Record that `dev` has now been seen up to `seq`. */
export function vvAdvance(vv, dev, seq) {
  return seq > vvGet(vv, dev) ? { ...vv, [dev]: seq } : vv;
}

// ---------------------------------------------------------------------------
// Causality
// ---------------------------------------------------------------------------

/**
 * Did `a` happen before `b`? True when b's creator had already seen a.
 *
 * A device's own `deps` include its own prior events, so this single rule
 * covers same-device ordering too. Note what is absent: no comparison of
 * timestamps. Phone clocks disagree, and an ordering that trusts them lets a
 * device with a lagging clock revert a tick it never saw — the exact silent
 * loss FR-SYNC-1 forbids. §5.3.
 */
export function happenedBefore(a, b) {
  if (a.id === b.id) return false;
  return a.seq <= vvGet(b.deps, a.dev);
}

/** Neither event saw the other. */
export function concurrent(a, b) {
  return !happenedBefore(a, b) && !happenedBefore(b, a);
}

/**
 * The maximal set: events not superseded by any other in the group.
 *
 * This is the whole of the merge rule's machinery. Everything in merge.js is
 * a question about what this set contains. §5.4.
 */
export function maximal(events) {
  return events.filter((e) => !events.some((other) => happenedBefore(e, other)));
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

/**
 * A device: a monotonic sequence, and a version vector of everything it has
 * seen. Both are what make an event's causal position meaningful.
 *
 * `now` is injected so tests can control it — and so that nothing in this
 * module can accidentally start depending on the real clock for ordering.
 */
export function createDevice(id, { now = () => new Date().toISOString() } = {}) {
  let seq = 0;
  let seen = {};

  return {
    id,
    get seq() { return seq; },
    get seen() { return { ...seen }; },

    /** Create an event, refusing any not permitted in this phase. */
    emit(type, payload, phase = 'draft') {
      if (!isPermitted(type, phase, payload)) {
        throw new Error(`${type} is not permitted while a shop is ${phase}`);
      }
      seq += 1;
      seen = vvAdvance(seen, id, seq);
      return {
        id: `${id}-${String(seq).padStart(4, '0')}`,
        dev: id,
        seq,
        deps: { ...seen },   // includes our own seq: one causality rule, not two
        ts: now(),           // display only — never used for ordering (§5.3)
        type,
        payload,
      };
    },

    /**
     * Take note of events from elsewhere, so later emissions depend on them —
     * and of this device's own, from before the app last closed, so its
     * sequence carries on from where it was. Starting again at 1 reissued old
     * ids, and the store, rightly ignoring an id it already has, dropped every
     * change made after a reload until the count caught up.
     */
    observe(events) {
      for (const e of [].concat(events)) {
        seen = vvAdvance(seen, e.dev, e.seq);
        if (e.dev === id && e.seq > seq) seq = e.seq;
      }
      return this;
    },
  };
}

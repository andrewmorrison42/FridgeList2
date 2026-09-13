// Scenario harness for the property tests.
//
// The habit this encodes: **never assert a property against one run.** Assert
// it against the same scenario replayed under every environmental variation
// that must not matter — different per-device clocks, different delivery
// orders, compacted or not. If any variation changes the answer, that is the
// defect, and it is one no single-run test would have shown you.
//
// This exists because the clock-skew property caught the exact failure class
// the household reported, and there was no reason for that to be one property
// rather than the way all of them are written.

import { createDevice } from '../src/core/events.js';
import { merge, compact } from '../src/core/merge.js';

export const LINES = ['flour', 'olives', 'capers'];

/**
 * Replay a scenario. Each device holds only what it emitted or was synced;
 * `sync` delivers one device's events to another in one direction, which is
 * what produces the partitions worth testing.
 */
export function run({ nDevices, ops, skew = [0, 0, 0, 0] }) {
  let tickMs = 0;
  const devices = [];
  const logs = [];
  for (let i = 0; i < nDevices; i++) {
    devices.push(createDevice(`d${i}`, {
      now: () => new Date(1_700_000_000_000 + (tickMs += 1000) + (skew[i] ?? 0)).toISOString(),
    }));
    logs.push([]);
  }

  for (const op of ops) {
    const i = op.dev % nDevices;
    if (op.kind === 'sync') {
      const j = op.other % nDevices;
      if (i === j) continue;
      devices[i].observe(logs[j]);
      const have = new Set(logs[i].map((e) => e.id));
      for (const e of logs[j]) if (!have.has(e.id)) logs[i].push(e);
      continue;
    }
    const base = { shopId: 's1', ingredientId: op.line };
    logs[i].push(
      op.kind === 'add'
        ? devices[i].emit('line.added', { ...base, present: true }, 'open')
        : devices[i].emit('line.done', { ...base, done: op.kind === 'tick' }, 'open'),
    );
  }

  const all = [];
  const seen = new Set();
  for (const log of logs) for (const e of log) if (!seen.has(e.id)) { seen.add(e.id); all.push(e); }
  return { devices, logs, all };
}

/** Deterministic shuffle, so a failure reproduces. */
export function shuffle(xs, seed) {
  const a = [...xs];
  let r = (seed || 1) >>> 0;
  for (let i = a.length - 1; i > 0; i--) {
    r = (Math.imul(r, 1103515245) + 12345) & 0x7fffffff;
    const j = r % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Comparable snapshot of merged state — values only, sorted. */
export const snapshot = (events) =>
  JSON.stringify([...merge(events)].map(([k, v]) => [k, v.value]).sort());

// Clocks that disagree by up to a minute in both directions, including one
// that runs behind everything else. A design that orders by timestamp fails
// here; one that orders by causality cannot notice.
const SKEWS = [
  [0, 0, 0, 0],
  [0, 30000, -30000, 15000],
  [-60000, 60000, 0, -20000],
];
const ORDERS = [1, 7, 99];

/**
 * Every view of a scenario that must agree.
 *
 * Caveat worth knowing before extending this: invariance under clock skew
 * holds for causally-resolved registers, which is all of them today. A
 * last-save-wins field is *permitted* to depend on `ts` (§5.5), so if one is
 * added, it must be projected out here rather than this harness being
 * loosened — the point is to keep the guarantee visible, not to keep the
 * suite green.
 */
export function variations(scenario, project = snapshot) {
  const out = [];
  for (const skew of SKEWS) {
    const { all } = run({ ...scenario, skew });
    for (const seed of ORDERS) {
      const shuffled = shuffle(all, seed);
      out.push({ label: `skew=${skew[1]} order=${seed}`, value: project(shuffled) });
      out.push({ label: `skew=${skew[1]} order=${seed} compacted`, value: project(compact(shuffled)) });
    }
  }
  return out;
}

/**
 * Assert the scenario gives one answer across every variation, then hand that
 * answer to `check` for the property's own assertions.
 *
 * This is the entry point properties should use. Using `run` directly gets you
 * a single-run test, which is what this file exists to discourage.
 */
export function stable(scenario, check, project = snapshot) {
  const views = variations(scenario, project);
  const first = views[0];
  for (const v of views) {
    if (v.value !== first.value) {
      throw new Error(
        `answer changed with the environment, which it must not:\n` +
        `  ${first.label}: ${first.value}\n  ${v.label}: ${v.value}`,
      );
    }
  }
  if (check) check(run(scenario));
  return first.value;
}

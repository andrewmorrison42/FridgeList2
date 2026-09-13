// Property-based tests for the merge engine.
//
// Unit tests prove almost nothing here: the defects in a merge engine live in
// the orderings nobody thought to write down. So instead we generate thousands
// of random scenarios — several devices, arbitrary interleavings of ticks,
// unticks and additions, arbitrary sync partitions — and assert the invariants
// hold in every one. ARCHITECTURE.md §14.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDevice, happenedBefore, isPermitted } from '../src/core/events.js';
import { merge, compact, isDone } from '../src/core/merge.js';

const LINES = ['flour', 'olives', 'capers'];
const RECIPES = ['laksa', 'adobo'];

/** An operation in a generated scenario. */
const opArb = fc.oneof(
  fc.record({ kind: fc.constant('tick'),   dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
  fc.record({ kind: fc.constant('untick'), dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
  fc.record({ kind: fc.constant('add'),    dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
  fc.record({ kind: fc.constant('sync'),   dev: fc.nat(3), other: fc.nat(3) }),
);

const scenarioArb = fc.record({
  nDevices: fc.integer({ min: 2, max: 4 }),
  ops: fc.array(opArb, { minLength: 1, maxLength: 40 }),
  // Clocks that disagree, drift and run backwards. Nothing may depend on them.
  skew: fc.array(fc.integer({ min: -60000, max: 60000 }), { minLength: 4, maxLength: 4 }),
});

/**
 * Run a scenario. Each device holds only the events it has emitted or been
 * synced; `sync` delivers one device's events to another, one direction only,
 * which is what produces the partitions that make this worth testing.
 */
function run({ nDevices, ops, skew }) {
  let tickMs = 0;
  const devices = [];
  const logs = [];
  for (let i = 0; i < nDevices; i++) {
    devices.push(createDevice(`d${i}`, {
      now: () => new Date(1_700_000_000_000 + (tickMs += 1000) + skew[i]).toISOString(),
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
    const payload = { shopId: 's1', ingredientId: op.line };
    const e =
      op.kind === 'add'
        ? devices[i].emit('line.added', { ...payload, present: true }, 'open')
        : devices[i].emit('line.done', { ...payload, done: op.kind === 'tick' }, 'open');
    logs[i].push(e);
  }

  const all = [];
  const seen = new Set();
  for (const log of logs) for (const e of log) if (!seen.has(e.id)) { seen.add(e.id); all.push(e); }
  return { devices, logs, all };
}

/** Comparable snapshot of merged state. */
const snapshot = (events) =>
  JSON.stringify([...merge(events)].map(([k, v]) => [k, v.value]).sort());

const shuffle = (xs, seed) => {
  const a = [...xs];
  let r = seed || 1;
  for (let i = a.length - 1; i > 0; i--) {
    r = (r * 1103515245 + 12345) & 0x7fffffff;
    const j = r % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

describe('P1 — tick durability (FR-SYNC-1)', () => {
  it('a tick survives unless an untick causally follows every tick on that line', () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      const { all } = run(s);
      for (const line of LINES) {
        const about = all.filter(
          (e) => e.type === 'line.done' && e.payload.ingredientId === line,
        );
        const ticks = about.filter((e) => e.payload.done === true);
        const unticks = about.filter((e) => e.payload.done === false);
        // A tick nobody informedly undid must still be true, everywhere.
        const undefeated = ticks.some(
          (t) => !unticks.some((u) => happenedBefore(t, u)),
        );
        if (undefeated) expect(isDone(all, 's1', line)).toBe(true);
      }
    }), { numRuns: 2000 });
  });

  it('an untick only takes effect when it saw the tick', () => {
    const a = createDevice('a');
    const b = createDevice('b');
    const tick = a.emit('line.done', { shopId: 's', ingredientId: 'x', done: true }, 'open');
    // b never saw it
    const blind = b.emit('line.done', { shopId: 's', ingredientId: 'x', done: false }, 'open');
    expect(isDone([tick, blind], 's', 'x')).toBe(true);
    // b did see it
    const c = createDevice('c').observe([tick]);
    const informed = c.emit('line.done', { shopId: 's', ingredientId: 'x', done: false }, 'open');
    expect(isDone([tick, informed], 's', 'x')).toBe(false);
  });
});

describe('P2 — convergence (FR-SYNC-3)', () => {
  it('the same events in any order give the same state', () => {
    fc.assert(fc.property(scenarioArb, fc.nat(), (s, seed) => {
      const { all } = run(s);
      expect(snapshot(shuffle(all, seed + 1))).toBe(snapshot(all));
    }), { numRuns: 1000 });
  });

  it('merging is idempotent', () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      const { all } = run(s);
      expect(snapshot([...all, ...all])).toBe(snapshot(all));
    }), { numRuns: 500 });
  });

  it('state does not depend on wall clocks, however skewed (§5.3)', () => {
    // The same scenario run with wildly different per-device clocks — including
    // clocks that run backwards relative to each other — must give the same
    // answer. This is the test for the failure mode that ordering by timestamp
    // would have introduced: a lagging phone reverting a tick it never saw.
    fc.assert(fc.property(scenarioArb, fc.array(fc.integer({ min: -60000, max: 60000 }), { minLength: 4, maxLength: 4 }), (s, otherSkew) => {
      expect(snapshot(run({ ...s, skew: otherSkew }).all)).toBe(snapshot(run(s).all));
    }), { numRuns: 500 });
  });
});

describe('P3 — addition durability (FR-SYNC-1, FR-WAIT-2)', () => {
  it('an added line is never lost', () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      const { all } = run(s);
      const added = new Set(
        all.filter((e) => e.type === 'line.added').map((e) => e.payload.ingredientId),
      );
      const state = merge(all);
      for (const line of added) {
        expect(state.get(`line:s1:${line}:present`).value).toBe(true);
      }
    }), { numRuns: 1000 });
  });
});

describe('P5 — compaction safety (§7.5)', () => {
  it('compacting never changes the answer', () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      const { all } = run(s);
      expect(snapshot(compact(all))).toBe(snapshot(all));
    }), { numRuns: 1000 });
  });

  it('compaction is stable under further merging', () => {
    fc.assert(fc.property(scenarioArb, fc.nat(), (s, seed) => {
      const { all } = run(s);
      const half = shuffle(all, seed + 7).slice(0, Math.ceil(all.length / 2));
      expect(snapshot([...compact(half), ...all])).toBe(snapshot(all));
    }), { numRuns: 500 });
  });
});

describe('P6 — phase integrity (FR-SHOP-3, §5.9)', () => {
  it('the open phase permits no destructive operation', () => {
    expect(isPermitted('menu.selection', 'open', { present: true })).toBe(false);
    expect(isPermitted('menu.selection', 'open', { present: false })).toBe(false);
    expect(isPermitted('line.suppressed', 'open', { suppressed: true })).toBe(false);
    expect(isPermitted('waitlist.item', 'open', { present: false })).toBe(false);
    // ...but additions and ticks are fine
    expect(isPermitted('line.added', 'open', { present: true })).toBe(true);
    expect(isPermitted('waitlist.item', 'open', { present: true })).toBe(true);
    expect(isPermitted('line.done', 'open', { done: true })).toBe(true);
    expect(isPermitted('menu.cooked', 'open', { cooked: true })).toBe(true);
  });

  it('a device refuses to create a forbidden event rather than filtering later', () => {
    const d = createDevice('d');
    expect(() => d.emit('menu.selection', { recipeId: 'r', present: false }, 'open')).toThrow();
    expect(() => d.emit('line.done', { shopId: 's', ingredientId: 'i', done: true }, 'draft')).toThrow();
    expect(d.seq).toBe(0); // a refused emission consumes no sequence number
  });

  it('draft permits the pantry check that open forbids', () => {
    expect(isPermitted('line.suppressed', 'draft', { suppressed: true })).toBe(true);
    expect(isPermitted('menu.selection', 'draft', { present: false })).toBe(true);
  });
});

// Property-based tests for the merge engine.
//
// Unit tests prove almost nothing here: the defects in a merge engine live in
// the orderings nobody thought to write down. So every property below is
// asserted through `stable()` (test/harness.js), which replays each generated
// scenario under every environmental variation that must not matter — skewed
// clocks, shuffled delivery, compacted or not — and fails if any of them
// changes the answer. ARCHITECTURE.md §14.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDevice, happenedBefore, isPermitted } from '../src/core/events.js';
import { merge, compact, isDone } from '../src/core/merge.js';
import { run, stable, shuffle, snapshot, LINES } from './harness.js';

const opArb = fc.oneof(
  fc.record({ kind: fc.constant('tick'),   dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
  fc.record({ kind: fc.constant('untick'), dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
  fc.record({ kind: fc.constant('add'),    dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
  fc.record({ kind: fc.constant('sync'),   dev: fc.nat(3), other: fc.nat(3) }),
);

const scenarioArb = fc.record({
  nDevices: fc.integer({ min: 2, max: 4 }),
  ops: fc.array(opArb, { minLength: 1, maxLength: 40 }),
});

describe('P1 — tick durability (FR-SYNC-1)', () => {
  it('a tick survives unless an untick causally follows every tick on that line', () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      stable(s, ({ all }) => {
        for (const line of LINES) {
          const about = all.filter((e) => e.type === 'line.done' && e.payload.ingredientId === line);
          const ticks = about.filter((e) => e.payload.done === true);
          const unticks = about.filter((e) => e.payload.done === false);
          const undefeated = ticks.some((t) => !unticks.some((u) => happenedBefore(t, u)));
          if (undefeated) expect(isDone(all, 's1', line)).toBe(true);
        }
      });
    }), { numRuns: 1500 });
  });

  it('an untick only takes effect when it saw the tick', () => {
    const a = createDevice('a');
    const tick = a.emit('line.done', { shopId: 's', ingredientId: 'x', done: true }, 'open');

    const blind = createDevice('b')
      .emit('line.done', { shopId: 's', ingredientId: 'x', done: false }, 'open');
    expect(isDone([tick, blind], 's', 'x')).toBe(true);

    const informed = createDevice('c').observe([tick])
      .emit('line.done', { shopId: 's', ingredientId: 'x', done: false }, 'open');
    expect(isDone([tick, informed], 's', 'x')).toBe(false);
  });

  it('a tick after an informed untick wins again', () => {
    const a = createDevice('a');
    const tick = a.emit('line.done', { shopId: 's', ingredientId: 'x', done: true }, 'open');
    const b = createDevice('b').observe([tick]);
    const untick = b.emit('line.done', { shopId: 's', ingredientId: 'x', done: false }, 'open');
    const retick = createDevice('c').observe([tick, untick])
      .emit('line.done', { shopId: 's', ingredientId: 'x', done: true }, 'open');
    expect(isDone([tick, untick, retick], 's', 'x')).toBe(true);
  });
});

describe('P2 — convergence (FR-SYNC-3)', () => {
  it('merging is idempotent', () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      stable(s, ({ all }) => expect(snapshot([...all, ...all])).toBe(snapshot(all)));
    }), { numRuns: 500 });
  });

  // Order-independence and clock-independence are no longer separate tests:
  // `stable()` asserts both on every property in this file. This one remains
  // as the explicit statement of the guarantee, so it is findable by name.
  it('neither delivery order nor wall clocks change the answer (§5.3)', () => {
    fc.assert(fc.property(scenarioArb, (s) => { stable(s); }), { numRuns: 1000 });
  });
});

describe('P3 — addition durability (FR-SYNC-1, FR-WAIT-2)', () => {
  it('an added line is never lost', () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      stable(s, ({ all }) => {
        const added = new Set(all.filter((e) => e.type === 'line.added').map((e) => e.payload.ingredientId));
        const state = merge(all);
        for (const line of added) expect(state.get(`line:s1:${line}:present`).value).toBe(true);
      });
    }), { numRuns: 1000 });
  });
});

describe('P5 — compaction safety (§7.5)', () => {
  it('compacting never changes the answer', () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      stable(s, ({ all }) => expect(snapshot(compact(all))).toBe(snapshot(all)));
    }), { numRuns: 1000 });
  });

  it('a compacted log still merges correctly with later events', () => {
    fc.assert(fc.property(scenarioArb, fc.nat(), (s, seed) => {
      stable(s, ({ all }) => {
        const half = shuffle(all, seed + 7).slice(0, Math.ceil(all.length / 2));
        expect(snapshot([...compact(half), ...all])).toBe(snapshot(all));
      });
    }), { numRuns: 500 });
  });
});

describe('P6 — phase integrity (FR-SHOP-3, §5.9)', () => {
  it('the open phase permits no destructive operation', () => {
    expect(isPermitted('menu.selection', 'open', { present: true })).toBe(false);
    expect(isPermitted('menu.selection', 'open', { present: false })).toBe(false);
    expect(isPermitted('line.suppressed', 'open', { suppressed: true })).toBe(false);
    expect(isPermitted('waitlist.item', 'open', { present: false })).toBe(false);

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

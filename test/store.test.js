// Tests for FR-SYNC-7 — a merged change must reach the screen.
//
// The property suite exercises the merge engine and never the path out of it.
// These tests cover that path: not whether the answer is right, but whether
// anything watching is told about it. See FAILURE-AUTOPSY.md F2 cause (c).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createStore } from '../src/core/store.js';
import { createDevice } from '../src/core/events.js';
import { run, shuffle, snapshot, LINES } from './harness.js';

const tick = (d, line, done = true) =>
  d.emit('line.done', { shopId: 's1', ingredientId: line, done }, 'open');

describe('FR-SYNC-7 — display currency', () => {
  it('notifies a subscriber when a merged change alters state', () => {
    const store = createStore();
    const seen = [];
    store.subscribe((s) => seen.push(s.get('line:s1:flour:done')?.value));

    expect(seen).toEqual([undefined]);            // called immediately on subscribe
    store.apply(tick(createDevice('a'), 'flour'));
    expect(seen).toEqual([undefined, true]);      // and again on the change
  });

  it('a subscriber reading state during notification sees the new value, never the old', () => {
    const store = createStore();
    let observed;
    store.subscribe(() => { observed = store.get('line:s1:flour:done'); });
    store.apply(tick(createDevice('a'), 'flour'));
    expect(observed).toBe(true);
  });

  it('does not notify for an event it already holds', () => {
    const store = createStore();
    const e = tick(createDevice('a'), 'flour');
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.apply(e);
    const after = calls;
    store.apply(e);
    store.apply([e, e]);
    expect(calls).toBe(after);
  });

  it('does not notify for events that arrive but change nothing', () => {
    // A concurrent untick that loses to the tick (§5.4) is a real new event
    // that must not cause a re-render, because the answer is unchanged.
    const store = createStore();
    const a = createDevice('a');
    const t = tick(a, 'flour');
    store.apply(t);
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.apply(tick(createDevice('b'), 'flour', false));   // blind untick, loses
    expect(calls).toBe(1);                                  // only the subscribe call
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore();
    let calls = 0;
    const off = store.subscribe(() => { calls += 1; });
    off();
    store.apply(tick(createDevice('a'), 'flour'));
    expect(calls).toBe(1);
  });

  it('a subscriber never ends up holding stale state, whatever order events arrive in', () => {
    const opArb = fc.oneof(
      fc.record({ kind: fc.constant('tick'),   dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
      fc.record({ kind: fc.constant('untick'), dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
      fc.record({ kind: fc.constant('add'),    dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
      fc.record({ kind: fc.constant('sync'),   dev: fc.nat(3), other: fc.nat(3) }),
    );
    fc.assert(fc.property(
      fc.record({ nDevices: fc.integer({ min: 2, max: 4 }), ops: fc.array(opArb, { maxLength: 30 }) }),
      fc.nat(), fc.integer({ min: 1, max: 5 }),
      (scenario, seed, chunk) => {
        const { all } = run(scenario);
        const store = createStore();
        // What the last notification told us — i.e. what a view would show.
        let rendered = snapshot([]);
        store.subscribe((s) => {
          rendered = JSON.stringify([...s].map(([k, v]) => [k, v.value]).sort());
        });
        const order = shuffle(all, seed + 3);
        for (let i = 0; i < order.length; i += chunk) {
          store.apply(order.slice(i, i + chunk));
        }
        // The screen agrees with the truth, with nothing further to do.
        expect(rendered).toBe(snapshot(all));
      },
    ), { numRuns: 800 });
  });

  it('version advances exactly once per observable change', () => {
    const store = createStore();
    const a = createDevice('a');
    expect(store.version).toBe(0);
    store.apply(tick(a, 'flour'));
    expect(store.version).toBe(1);
    store.apply(tick(createDevice('b'), 'flour', false));  // blind untick, loses
    expect(store.version).toBe(1);                         // nothing observable changed
    store.apply(tick(createDevice('c').observe(store.events), 'flour', false));
    expect(store.version).toBe(2);                         // informed untick, does change
  });
});

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

describe('incremental store (review #6)', () => {
  const opArb = fc.oneof(
    fc.record({ kind: fc.constant('tick'),   dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
    fc.record({ kind: fc.constant('untick'), dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
    fc.record({ kind: fc.constant('add'),    dev: fc.nat(3), line: fc.constantFrom(...LINES) }),
    fc.record({ kind: fc.constant('sync'),   dev: fc.nat(3), other: fc.nat(3) }),
  );
  // Registers compared by value AND by which events decided them: derivations
  // such as the lock snapshot read the deciding events, not just the value.
  const full = (state) => JSON.stringify([...state].map(([k, r]) => [k, r.value, r.by.map((e) => e.id).sort()]).sort());

  it('P10 — the incremental store equals a full merge, for any delivery order and any batching', async () => {
    const { merge } = await import('../src/core/merge.js');
    fc.assert(fc.property(
      fc.record({ nDevices: fc.integer({ min: 2, max: 4 }), ops: fc.array(opArb, { maxLength: 40 }) }),
      fc.nat(), fc.integer({ min: 1, max: 7 }),
      (scenario, seed, chunk) => {
        const { all } = run(scenario);
        const store = createStore();
        const order = shuffle(all, seed + 1);
        for (let i = 0; i < order.length; i += chunk) store.apply(order.slice(i, i + chunk));
        expect(full(store.state)).toBe(full(merge(all)));
      },
    ), { numRuns: 800 });
  });

  it('notifies when a register gains a deciding event, even if its value is unchanged', () => {
    // A second, concurrent "Menu is settled" leaves the lock register true —
    // but its list is unioned into the shop's, so the list changes. A store
    // that compared values alone would leave every cached list stale.
    const a = createDevice('a');
    const b = createDevice('b');
    const store = createStore([a.emit('shop.locked', { shopId: 's1', locked: true, lines: [] }, 'draft')]);
    const before = store.version;
    store.apply(b.emit('shop.locked', { shopId: 's1', locked: true, lines: [{ ingredientId: 'x' }] }, 'draft'));
    expect(store.version).toBe(before + 1);
  });

  it('hands every new event to onEvents, including ones that change nothing', () => {
    // Persistence hangs off this. An event that changes nothing today is still
    // part of the history, and history that is not saved is history lost.
    const store = createStore();
    const seen = [];
    store.onEvents((added) => seen.push(...added.map((e) => e.id)));
    const t = tick(createDevice('a'), 'flour');
    store.apply(t);
    const blind = tick(createDevice('b'), 'flour', false);     // loses; changes nothing
    store.apply(blind);
    store.apply(blind);                                         // duplicate: not new
    expect(seen).toEqual([t.id, blind.id]);
  });
});

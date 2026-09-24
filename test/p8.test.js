// P8 — Wait List closure, as a property. FR-LIST-7, FR-WAIT-2.
//
// The first P8 tests were three examples on one device, each run once — the
// exact shape §14.1 forbids. This generates households of 2-4 phones that add
// to the Wait List before, during and after a shop, tick and untick, lock and
// complete concurrently, and sync in any pattern — including ticks that arrive
// after the shop was completed elsewhere.
//
// The oracle is computed from what each phone had *seen* when it acted, which
// the generator records directly. It never consults version vectors, so it is
// an independent account of "added before the close" and "still ticked", not a
// second copy of openWaitList's logic.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDevice } from '../src/core/events.js';
import { compact } from '../src/core/merge.js';
import { openWaitList } from '../src/core/generate.js';
import { shuffle } from './harness.js';

const SHOP = 'shop-0001';
const INGS = ['prawns', 'mayo', null];          // null: free text, not an ingredient

const opArb = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant('wait'), dev: fc.nat(3), ing: fc.constantFrom(...INGS) }) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constantFrom('tick', 'tick', 'untick'), dev: fc.nat(3), pick: fc.nat(5) }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant('sync'), dev: fc.nat(3), other: fc.nat(3) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('lock'), dev: fc.nat(3) }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('close'), dev: fc.nat(3) }) },
);
const scenarioArb = fc.record({
  nDevices: fc.integer({ min: 2, max: 4 }),
  ops: fc.array(opArb, { minLength: 1, maxLength: 80, size: 'large' }),
});

function play({ nDevices, ops }, skew = []) {
  let clock = 0;
  const phones = Array.from({ length: nDevices }, (_, i) => ({
    device: createDevice(`d${i}`, { now: () => new Date(1_700_000_000_000 + (clock += 1000) + (skew[i] ?? 0)).toISOString() }),
    log: [],
  }));
  const sees = (p, type) => p.log.some((e) => e.type === type);
  const items = [];                 // { itemId, lineId, add }
  const closes = [];                // { event, sawItems }
  const ticks = [];                 // { event, lineId }
  const unticks = [];               // { lineId, sawTicks }
  let n = 0;

  for (const op of ops) {
    const p = phones[op.dev % nDevices];
    const locked = sees(p, 'shop.locked');
    const closed = sees(p, 'shop.closed');
    if (op.kind === 'sync') {
      const q = phones[op.other % nDevices];
      if (p === q) continue;
      p.device.observe(q.log);
      const have = new Set(p.log.map((e) => e.id));
      for (const e of q.log) if (!have.has(e.id)) p.log.push(e);
    } else if (op.kind === 'wait') {
      const itemId = `w${++n}`;
      // After the close this phone is planning the next shop: a draft.
      const phase = locked && !closed ? 'open' : 'draft';
      const add = p.device.emit('waitlist.item', { itemId, ingredientId: op.ing, name: op.ing ? null : `thing ${n}`, present: true }, phase);
      p.log.push(add);
      items.push({ itemId, lineId: op.ing ?? `wl-${itemId}`, add });
    } else if (op.kind === 'tick' || op.kind === 'untick') {
      if (!locked || closed) continue;            // ticking is only for an open shop, as this phone sees it
      const lines = ['prawns', 'mayo', ...items.filter((i) => p.log.includes(i.add) && i.lineId.startsWith('wl-')).map((i) => i.lineId)];
      const lineId = lines[op.pick % lines.length];
      const event = p.device.emit('line.done', { shopId: SHOP, ingredientId: lineId, done: op.kind === 'tick' }, 'open');
      if (op.kind === 'tick') ticks.push({ event, lineId });
      else unticks.push({ lineId, sawTicks: new Set(p.log.map((e) => e.id)) });
      p.log.push(event);
    } else if (op.kind === 'lock') {
      if (locked) continue;
      p.log.push(p.device.emit('shop.locked', { shopId: SHOP, locked: true, selections: [], lines: [] }, 'draft'));
    } else if (op.kind === 'close') {
      if (!locked || closed) continue;
      // Completing a shop never throws, whatever has been ticked (P8).
      const event = p.device.emit('shop.closed', { shopId: SHOP, closed: true, nextShopId: 'shop-0002', selections: [] }, 'open');
      closes.push({ event, sawItems: new Set(p.log.map((e) => e.id)) });
      p.log.push(event);
    }
  }

  const all = [...new Map(phones.flatMap((p) => p.log).map((e) => [e.id, e])).values()];
  // Oracle. A line is done if some tick was not seen by every later untick of
  // it — the P1 rule, judged from what each unticking phone had seen.
  const done = (lineId) => ticks.some((t) => t.lineId === lineId
    && !unticks.some((u) => u.lineId === lineId && u.sawTicks.has(t.event.id)));
  const expected = items
    .filter((i) => !(closes.some((c) => c.sawItems.has(i.add.id)) && done(i.lineId)))
    .map((i) => i.itemId).sort();
  return { all, expected, closed: closes.length > 0 };
}

const openIds = (events) => openWaitList(events).map((i) => i.itemId ?? i.id).sort();

describe('P8 — Wait List closure, across phones, clocks and delivery orders', () => {
  it('an item is gone after a completed shop exactly when it was added before the close and its line stayed ticked', () => {
    let exercised = 0;
    fc.assert(fc.property(scenarioArb, (s) => {
      const { all, expected, closed } = play(s);
      if (closed && expected.length < all.filter((e) => e.type === 'waitlist.item').length) exercised++;
      for (const skew of [[], [0, 30000, -30000, 15000], [-60000, 60000, 0, -20000]]) {
        const { all: skewed } = play(s, skew);
        for (const seed of [1, 7, 99]) {
          const shuffled = shuffle(skewed, seed);
          expect(openIds(shuffled)).toEqual(expected);
          expect(openIds(compact(shuffled))).toEqual(expected);
        }
      }
    }), { numRuns: 800 });
    // The generator must actually produce fulfilments, or this proves nothing.
    expect(exercised).toBeGreaterThan(200);
  });
});

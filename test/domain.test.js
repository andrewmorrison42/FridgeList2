// Worked examples for the pure domain functions: conversion, generation, the
// carry-over state machine, and the shop chain. These are ordinary unit tests
// because these are pure functions with known answers (§14) — the property
// suite covers the merge engine, which is the part with no known answers.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDevice } from '../src/core/events.js';
import { toShoppingUnit, scaleForServings, formatQuantity, describeRecipeLine } from '../src/core/units.js';
import { selections, PLANNED, CARRIED, FLAGGED, COOKED } from '../src/core/carryover.js';
import { generate, groupForDisplay } from '../src/core/generate.js';
import { currentShop, nextShopId, permissions, explainRefusal, GENESIS_SHOP } from '../src/core/shop.js';
import { shuffle } from './harness.js';

const flour  = { id: 'flour',  name: 'Flour (Plain)', shoppingUnit: 'g',  category: 'Pantry', aisle: 'Baking', conversions: { cup: 250 } };
const basil  = { id: 'basil',  name: 'Basil',         shoppingUnit: 'g',  category: 'Fruit and Vegetables', aisle: 'Vegetables', conversions: { cup: 250 } };
const milk   = { id: 'milk',   name: 'Milk',          shoppingUnit: 'mL', category: 'Cold',   aisle: 'Dairy', isStaple: true, stapleQty: 6000 };
const capsicum = { id: 'capsicum', name: 'Capsicum',  shoppingUnit: 'qty', category: 'Fruit and Vegetables', aisle: 'Vegetables' };

const library = {
  ingredients: new Map([flour, basil, milk, capsicum].map((i) => [i.id, i])),
  recipes: new Map([
    ['cake',  { id: 'cake',  name: 'Cake',  servings: 8, lines: [{ ingredientId: 'flour', quantity: 2, cookingUnit: 'cup' }] }],
    ['pesto', { id: 'pesto', name: 'Pesto', servings: 4, lines: [{ ingredientId: 'basil', quantity: 1, cookingUnit: 'cup' }, { ingredientId: 'capsicum', quantity: 2 }] }],
  ]),
};

describe('units (FR-ING-1)', () => {
  it('converts cooking units to shopping units', () => {
    expect(toShoppingUnit(2, 'cup', flour)).toBe(500);
  });

  it('needs no conversion when cooked in the unit it is bought in', () => {
    expect(toShoppingUnit(3, null, capsicum)).toBe(3);
    expect(toShoppingUnit(3, 'qty', capsicum)).toBe(3);
  });

  it('throws rather than guessing at a missing conversion', () => {
    // A plausible wrong number nobody questions is worse than an error.
    expect(() => toShoppingUnit(1, 'tsp', flour)).toThrow(/no conversion/);
  });

  it('scales for servings', () => {
    expect(scaleForServings(2, 12, 8)).toBe(3);
  });

  it('formats for a supermarket, not a laboratory', () => {
    expect(formatQuantity(2, 'qty')).toBe('2');
    expect(formatQuantity(63.2, 'g')).toBe('63 g');
    expect(formatQuantity(430, 'mL')).toBe('430 mL');
  });

  it('reads large amounts the way they are bought: litres and kilograms (glitch #11)', () => {
    expect(formatQuantity(6000, 'mL')).toBe('6 L');        // not "6000 mL" of milk
    expect(formatQuantity(15880, 'mL')).toBe('15.9 L');
    expect(formatQuantity(1500, 'g')).toBe('1.5 kg');
    expect(formatQuantity(1013.4, 'g')).toBe('1 kg');
    expect(formatQuantity(950, 'g')).toBe('950 g');        // under a kilo stays in grams
  });

  it('counted things are bought whole: 1.35 lemons is 2 lemons (glitch #13)', () => {
    expect(formatQuantity(1.35, 'qty')).toBe('2');
    expect(formatQuantity(0.75, 'qty')).toBe('1');
    expect(formatQuantity(36.21, 'qty')).toBe('37');
    expect(formatQuantity(3, 'qty')).toBe('3');
  });

  it('a recipe line reads the way the recipe was written (glitch #12)', () => {
    const leek = { id: 'leek', name: 'Leek', shoppingUnit: 'qty' };
    const mush = { id: 'mush', name: 'Mushrooms', shoppingUnit: 'g' };
    const wine = { id: 'wine', name: 'Wine: white', shoppingUnit: 'mL' };
    expect(describeRecipeLine({ ingredientId: 'leek', quantity: 1 }, leek)).toBe('1 Leek');           // not "1  Leek"
    expect(describeRecipeLine({ ingredientId: 'mush', quantity: 300 }, mush)).toBe('300 g Mushrooms'); // unit shown
    expect(describeRecipeLine({ ingredientId: 'wine', quantity: 500, displayQty: '2', displayUnit: 'cup' }, wine)).toBe('2 cup Wine: white');
    expect(describeRecipeLine({ ingredientId: 'x', quantity: 0, garnish: true }, leek)).toBe('Leek, to serve');
  });
});

describe('shop chain (§8.1, P7)', () => {
  it('starts in draft with no events at all', () => {
    expect(currentShop([])).toEqual({ id: GENESIS_SHOP, phase: 'draft' });
  });

  it('successors are deterministic, so concurrent closes cannot fork the chain', () => {
    expect(nextShopId('shop-0001')).toBe('shop-0002');
    expect(nextShopId('shop-0099')).toBe('shop-0100');
  });

  // P7, rewritten in review #4. The first version filtered the set of shop ids
  // down to those equal to currentShop().id and asserted at most one remained —
  // true by construction, so it passed against a currentShop() that never
  // advanced at all. It also let every device see every event before acting,
  // so there was no concurrency to test. This version gives each device its
  // own partial view, and checks currentShop() against an independent model
  // built from the raw events, never from the code under test.
  it('P7 — one shop at a time, and the chain never forks, under real concurrency', () => {
    const opArb = fc.oneof(
      fc.record({ kind: fc.constant('act'),  dev: fc.nat(3) }),
      fc.record({ kind: fc.constant('sync'), dev: fc.nat(3), from: fc.nat(3) }),
    );
    fc.assert(fc.property(fc.integer({ min: 2, max: 4 }), fc.array(opArb, { maxLength: 40 }), (n, ops) => {
      const devices = Array.from({ length: n }, (_, i) => createDevice(`d${i}`));
      const logs = devices.map(() => []);
      for (const op of ops) {
        const i = op.dev % n;
        if (op.kind === 'sync') {
          const j = op.from % n;
          const have = new Set(logs[i].map((e) => e.id));
          for (const e of logs[j]) if (!have.has(e.id)) logs[i].push(e);
          devices[i].observe(logs[i]);
          continue;
        }
        // Each device acts on its own — possibly stale — view: lock the
        // current shop if it is being planned, close it if it is open.
        const { id, phase } = currentShop(logs[i]);
        if (phase === 'draft') logs[i].push(devices[i].emit('shop.locked', { shopId: id, locked: true }, 'draft'));
        else if (phase === 'open') logs[i].push(devices[i].emit('shop.closed', { shopId: id, closed: true, nextShopId: nextShopId(id) }, 'open'));
      }

      const all = [...new Map(logs.flat().map((e) => [e.id, e])).values()];

      // The independent model: read the raw events, not shopPhases().
      const closed = new Set(all.filter((e) => e.type === 'shop.closed').map((e) => e.payload.shopId));
      const locked = new Set(all.filter((e) => e.type === 'shop.locked').map((e) => e.payload.shopId));
      let expected = GENESIS_SHOP;
      while (closed.has(expected)) expected = nextShopId(expected);

      // 1. Every view agrees with the model about which shop is current —
      //    whatever order the events arrive in, since phones receive them in
      //    any order. (An order-dependent phase rule survived the first
      //    version of this test for exactly that reason.)
      expect(currentShop(all).id).toBe(expected);
      for (const seed of [1, 7, 99]) expect(currentShop(shuffle(all, seed)).id).toBe(expected);
      for (const log of logs) {
        const c = new Set(log.filter((e) => e.type === 'shop.closed').map((e) => e.payload.shopId));
        let exp = GENESIS_SHOP;
        while (c.has(exp)) exp = nextShopId(exp);
        expect(currentShop(log).id).toBe(exp);
      }
      // 2. At most one shop is open: locked and not yet closed.
      expect([...locked].filter((s) => !closed.has(s)).length).toBeLessThanOrEqual(1);
      // 3. Closed shops are a contiguous run from genesis — no gaps.
      let walk = GENESIS_SHOP;
      for (let k = 0; k < closed.size; k++) { expect(closed.has(walk)).toBe(true); walk = nextShopId(walk); }
      // 4. The chain never forks: every close of a shop names the same successor.
      for (const e of all.filter((x) => x.type === 'shop.closed')) {
        expect(e.payload.nextShopId).toBe(nextShopId(e.payload.shopId));
      }
    }), { numRuns: 500 });
  });

  it('refusing an action names the shop and offers the remedy (FR-SHOP-4)', () => {
    const d = createDevice('a');
    const events = [d.emit('shop.locked', { shopId: GENESIS_SHOP, locked: true }, 'draft')];
    expect(permissions(events).canEditMenu).toBe(false);
    const refusal = explainRefusal(events, 'canEditMenu');
    expect(refusal.shopId).toBe(GENESIS_SHOP);
    expect(refusal.remedyAction).toBe('closeShop');   // never a bare refusal
    // Words for a person, not internal ids (glitch #16).
    expect(`${refusal.reason} ${refusal.remedy}`).not.toMatch(/shop-\d/);
  });
});

describe('carry-over (FR-MENU-3 to FR-MENU-5, §9.1)', () => {
  // Derived from the shop chain: how many shops have closed since the meal was
  // planned. There are no carry-over events any more, so there is nothing to
  // emit at the wrong moment and nothing two devices could double-count.
  const plan = (device, recipeId, shopId, servings = 4) =>
    device.emit('menu.selection', { recipeId, present: true, servings, plannedFor: shopId }, 'draft');
  const statusIn = (events, recipeId, shopId) =>
    [...selections(events, shopId).values()].find((s) => s.recipeId === recipeId)?.status;

  it('an uncooked selection is carried in the next shop', () => {
    const events = [plan(createDevice('a'), 'cake', 'shop-0001')];
    expect(statusIn(events, 'cake', 'shop-0001')).toBe(PLANNED);
    expect(statusIn(events, 'cake', 'shop-0002')).toBe(CARRIED);
  });

  it('carries at most once, then demands a decision', () => {
    const events = [plan(createDevice('a'), 'cake', 'shop-0001')];
    expect(statusIn(events, 'cake', 'shop-0003')).toBe(FLAGGED);
  });

  it('a meal cooked in an earlier week has left the menu', () => {
    const d = createDevice('a');
    const events = [plan(d, 'cake', 'shop-0001'),
      d.emit('menu.cooked', { recipeId: 'cake', plannedFor: 'shop-0001', cooked: true, cookedIn: 'shop-0001' }, 'draft')];
    expect(statusIn(events, 'cake', 'shop-0001')).toBe(COOKED);
    expect(statusIn(events, 'cake', 'shop-0002')).toBe(undefined);
  });

  it('the same plan made on two devices is one entry, not two', () => {
    const a = createDevice('a');
    const b = createDevice('b');
    const events = [plan(a, 'cake', 'shop-0001', 4), plan(b, 'cake', 'shop-0001', 6)];
    const sels = [...selections(events, 'shop-0001').values()];
    expect(sels).toHaveLength(1);
    // ...and every device agrees on its servings, whatever order they arrived in.
    expect([...selections([...events].reverse(), 'shop-0001').values()][0].servings).toBe(sels[0].servings);
  });
});

/** The library as events, so tests derive exactly as the app does. */
function gen(lib, { events, shopId }) {
  const d = createDevice('lib');
  const libEvents = [
    ...[...lib.ingredients.values()].map((i) => d.emit('ingredient.upsert', { ingredientId: i.id, ingredient: i }, 'draft')),
    ...[...lib.recipes.values()].map((r) => d.emit('recipe.upsert', { recipeId: r.id, recipe: r }, 'draft')),
  ];
  return generate({ events: [...libEvents, ...events], shopId });
}

describe('generation (FR-LIST-1/2, FR-MENU-7, §10)', () => {
  const d = createDevice('a');
  const planned = [d.emit('menu.selection', { recipeId: 'cake', present: true, servings: 8, plannedFor: 'shop-0001' }, 'draft')];

  it('converts, scales, and includes staples automatically', () => {
    const { lines } = gen(library, { events: planned, shopId: 'shop-0001' });
    const byId = Object.fromEntries(lines.map((l) => [l.ingredientId, l]));
    expect(byId.flour.qty).toBe(500);            // 2 cups at 250 g
    expect(byId.milk.qty).toBe(6000);            // staple, never selected (FR-STA-1)
  });

  it('sums one line per ingredient across sources, not one per source', () => {
    const events = [...planned,
      d.emit('menu.selection', { recipeId: 'cake', present: true, servings: 16, plannedFor: 'shop-0001' }, 'draft')];
    const { lines } = gen(library, { events, shopId: 'shop-0001' });
    expect(lines.filter((l) => l.ingredientId === 'flour')).toHaveLength(1);
  });

  it('a carried-over entry goes to the check-before-buying section, not the list', () => {
    const c = createDevice('c');
    let events = [c.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft')];
    const { lines, carryOver } = gen(library, { events, shopId: 'shop-0002' });
    expect(lines.map((l) => l.ingredientId)).toEqual(['milk']);        // staple only
    expect(carryOver.map((l) => l.ingredientId).sort()).toEqual(['basil', 'capsicum']);
  });

  it('an ingredient also needed by a planned entry is bought regardless, so is not flagged', () => {
    // FR-MENU-7.3 — there is nothing to check about something already on the list.
    const c = createDevice('c');
    let events = [c.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft')];
    events = [...events, c.emit('menu.selection', { recipeId: 'pesto2', present: true, servings: 4, plannedFor: 'shop-0002' }, 'draft')];
    const lib = {
      ...library,
      recipes: new Map([...library.recipes, ['pesto2', { id: 'pesto2', name: 'More pesto', servings: 4, lines: [{ ingredientId: 'basil', quantity: 1, cookingUnit: 'cup' }] }]]),
    };
    const { lines, carryOver } = gen(lib, { events, shopId: 'shop-0002' });
    expect(lines.map((l) => l.ingredientId)).toContain('basil');
    expect(carryOver.map((l) => l.ingredientId)).not.toContain('basil');
  });

  it('dismissing an item affects only this shop', () => {
    const c = createDevice('c');
    let events = [c.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft')];
    events = [...events, c.emit('carryover.dismissed', { shopId: 'shop-0002', ingredientId: 'basil', dismissed: true }, 'draft')];
    const { carryOver } = gen(library, { events, shopId: 'shop-0002' });
    expect(carryOver.map((l) => l.ingredientId)).toEqual(['capsicum']);
  });

  it('groups by category then aisle, never alphabetically (FR-LIST-6)', () => {
    const { lines } = gen(library, {
      events: [d.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft')],
      shopId: 'shop-0001',
    });
    const grouped = groupForDisplay(lines, {
      categoryOrder: ['Fruit and Vegetables', 'Meat', 'Cold', 'Pantry'],
      aisleOrder: ['Vegetables', 'Fruit', 'Dairy'],
    });
    expect(grouped[0].category).toBe('Fruit and Vegetables');
    expect(grouped[0].aisles[0].aisle).toBe('Vegetables');
    expect(grouped.at(-1).category).toBe('Cold');
  });
});

describe('garnish lines (A6)', () => {
  it('a zero-quantity "to serve" line never reaches the shopping list', async () => {
    const lettuce = { id: 'lettuce', name: 'Lettuce', shoppingUnit: 'qty', category: 'Fruit and Vegetables', aisle: 'Vegetables' };
    const lib = {
      ingredients: new Map([['lettuce', lettuce], ['flour', flour]]),
      recipes: new Map([['tacos', { id: 'tacos', name: 'Tacos', servings: 4, lines: [
        { ingredientId: 'flour', quantity: 1, cookingUnit: 'cup' },
        { ingredientId: 'lettuce', quantity: 0, garnish: true },
      ] }]]),
    };
    const d = createDevice('g');
    const events = [d.emit('menu.selection', { recipeId: 'tacos', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft')];
    const { lines } = gen(lib, { events, shopId: 'shop-0001' });
    expect(lines.map((l) => l.ingredientId)).toEqual(['flour']);
  });
});

describe('imported trip history (FR-REC-4, FR-HIST-2)', () => {
  it('reaches the picker: a recipe chosen on an imported trip is not "never"', async () => {
    const { cookHistory } = await import('../src/core/library.js');
    const d = createDevice('import');
    const trips = [
      { shopId: 'trip:2026-08-29T05:16:33.687Z:dgv50avwy', closedAt: '2026-08-29T05:19:01.576Z', selections: ['cake'] },
      { shopId: 'trip:2026-09-12T01:58:55.758Z:x', closedAt: '2026-09-12T01:58:55.758Z', selections: ['cake', 'pesto'] },
    ];
    const events = [d.emit('history.imported', { trips }, 'draft')];
    const history = cookHistory(events);
    expect(history.get('cake')).toBe('2026-09-12T01:58:55.758Z');    // the most recent
    expect(history.get('pesto')).toBe('2026-09-12T01:58:55.758Z');
  });

  it('a shop closed in the app counts alongside imported history', async () => {
    const { cookHistory } = await import('../src/core/library.js');
    const d = createDevice('a');
    const events = [
      d.emit('history.imported', { trips: [{ shopId: 't', closedAt: '2026-08-01T00:00:00.000Z', selections: ['cake'] }] }, 'draft'),
      d.emit('shop.locked', { shopId: GENESIS_SHOP, locked: true }, 'draft'),
      d.emit('shop.closed', { shopId: GENESIS_SHOP, closed: true, nextShopId: 'shop-0002',
        selections: ['cake'], closedAt: '2026-09-20T00:00:00.000Z' }, 'open'),
    ];
    expect(cookHistory(events).get('cake')).toBe('2026-09-20T00:00:00.000Z');
  });
});

describe('reading amounts as people write them', () => {
  it('one parser for the migration and the recipe editor', async () => {
    const { parseAmount } = await import('../src/core/units.js');
    expect(parseAmount('500')).toBe(500);
    expect(parseAmount('0.5')).toBe(0.5);
    expect(parseAmount('1/3')).toBeCloseTo(1 / 3);
    expect(parseAmount('½')).toBe(0.5);
    expect(parseAmount('2 ¼')).toBe(2.25);
    expect(parseAmount('1 1/2')).toBe(1.5);          // the old parser returned nothing
    expect(parseAmount('0')).toBe(0);                 // "to serve" — a value, not a failure
    expect(parseAmount('two')).toBe(null);
    expect(parseAmount('')).toBe(null);
  });
});

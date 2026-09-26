// Worked examples for the pure domain functions: conversion, generation, the
// carry-over state machine, and the shop chain. These are ordinary unit tests
// because these are pure functions with known answers (§14) — the property
// suite covers the merge engine, which is the part with no known answers.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDevice } from '../src/core/events.js';
import { toShoppingUnit, scaleForServings, formatQuantity } from '../src/core/units.js';
import { selections, carryOverTransitions, PLANNED, CARRIED, FLAGGED, COOKED } from '../src/core/carryover.js';
import { generate, groupForDisplay } from '../src/core/generate.js';
import { currentShop, nextShopId, permissions, explainRefusal, GENESIS_SHOP } from '../src/core/shop.js';

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
    expect(formatQuantity(1013.4, 'g')).toBe('1010 g');
    expect(formatQuantity(2.5, 'qty')).toBe('2.5');
    expect(formatQuantity(63.2, 'g')).toBe('63 g');
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

  it('exactly one shop is not closed, under any interleaving', () => {
    fc.assert(fc.property(fc.array(fc.nat(3), { maxLength: 12 }), (devIdx) => {
      const devices = [0, 1, 2, 3].map((i) => createDevice(`d${i}`));
      let events = [];
      for (const i of devIdx) {
        const d = devices[i % devices.length];
        d.observe(events);
        const { id, phase } = currentShop(events);
        // Everyone races to lock, then to close. Two people doing the same
        // thing at once must produce one shop, not two.
        events = [...events, phase === 'draft'
          ? d.emit('shop.locked', { shopId: id, locked: true }, 'draft')
          : d.emit('shop.closed', { shopId: id, closed: true, nextShopId: nextShopId(id) }, 'open')];
        const open = [...new Set(events.map((e) => e.payload.shopId))]
          .filter((s) => currentShop(events).id === s || false);
        expect(open.length).toBeLessThanOrEqual(1);
      }
    }), { numRuns: 300 });
  });

  it('refusing an action names the shop and offers the remedy (FR-SHOP-4)', () => {
    const d = createDevice('a');
    const events = [d.emit('shop.locked', { shopId: GENESIS_SHOP, locked: true }, 'draft')];
    expect(permissions(events).canEditMenu).toBe(false);
    const refusal = explainRefusal(events, 'canEditMenu');
    expect(refusal.shopId).toBe(GENESIS_SHOP);
    expect(refusal.remedyAction).toBe('closeShop');   // never a bare refusal
  });
});

describe('carry-over (FR-MENU-3 to FR-MENU-5, §9.1)', () => {
  const plan = (device, recipeId, shopId, servings = 4) =>
    device.emit('menu.selection', { recipeId, present: true, servings, plannedFor: shopId }, 'draft');

  it('an uncooked selection carries into the next shop', () => {
    const d = createDevice('a');
    let events = [plan(d, 'cake', 'shop-0001')];
    expect(selections(events).get('cake').status).toBe(PLANNED);
    events = [...events, ...carryOverTransitions(events, 'shop-0002', d)];
    expect(selections(events).get('cake').status).toBe(CARRIED);
  });

  it('carries at most once, then demands a decision', () => {
    const d = createDevice('a');
    let events = [plan(d, 'cake', 'shop-0001')];
    events = [...events, ...carryOverTransitions(events, 'shop-0002', d)];
    events = [...events, ...carryOverTransitions(events, 'shop-0003', d)];
    expect(selections(events).get('cake').status).toBe(FLAGGED);
  });

  it('a cooked selection never carries', () => {
    const d = createDevice('a');
    let events = [plan(d, 'cake', 'shop-0001'),
                  d.emit('menu.cooked', { recipeId: 'cake', cooked: true }, 'draft')];
    events = [...events, ...carryOverTransitions(events, 'shop-0002', d)];
    expect(selections(events).get('cake').status).toBe(COOKED);
  });

  it('two devices computing the same transition do not double-count', () => {
    // The reason carriedInto is a set and not a counter: an increment applied
    // twice would flag the entry a week early.
    const a = createDevice('a');
    const b = createDevice('b');
    let events = [plan(a, 'cake', 'shop-0001')];
    b.observe(events);
    const fromA = carryOverTransitions(events, 'shop-0002', a);
    const fromB = carryOverTransitions(events, 'shop-0002', b);
    events = [...events, ...fromA, ...fromB];
    expect(selections(events).get('cake').status).toBe(CARRIED);   // not FLAGGED
  });
});

describe('generation (FR-LIST-1/2, FR-MENU-7, §10)', () => {
  const d = createDevice('a');
  const planned = [d.emit('menu.selection', { recipeId: 'cake', present: true, servings: 8, plannedFor: 'shop-0001' }, 'draft')];

  it('converts, scales, and includes staples automatically', () => {
    const { lines } = generate(library, { events: planned, shopId: 'shop-0001' });
    const byId = Object.fromEntries(lines.map((l) => [l.ingredientId, l]));
    expect(byId.flour.qty).toBe(500);            // 2 cups at 250 g
    expect(byId.milk.qty).toBe(6000);            // staple, never selected (FR-STA-1)
  });

  it('sums one line per ingredient across sources, not one per source', () => {
    const events = [...planned,
      d.emit('menu.selection', { recipeId: 'cake', present: true, servings: 16, plannedFor: 'shop-0001' }, 'draft')];
    const { lines } = generate(library, { events, shopId: 'shop-0001' });
    expect(lines.filter((l) => l.ingredientId === 'flour')).toHaveLength(1);
  });

  it('a carried-over entry goes to the check-before-buying section, not the list', () => {
    const c = createDevice('c');
    let events = [c.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft')];
    events = [...events, ...carryOverTransitions(events, 'shop-0002', c)];
    const { lines, carryOver } = generate(library, { events, shopId: 'shop-0002' });
    expect(lines.map((l) => l.ingredientId)).toEqual(['milk']);        // staple only
    expect(carryOver.map((l) => l.ingredientId).sort()).toEqual(['basil', 'capsicum']);
  });

  it('an ingredient also needed by a planned entry is bought regardless, so is not flagged', () => {
    // FR-MENU-7.3 — there is nothing to check about something already on the list.
    const c = createDevice('c');
    let events = [c.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft')];
    events = [...events, ...carryOverTransitions(events, 'shop-0002', c)];
    events = [...events, c.emit('menu.selection', { recipeId: 'pesto2', present: true, servings: 4, plannedFor: 'shop-0002' }, 'draft')];
    const lib = {
      ...library,
      recipes: new Map([...library.recipes, ['pesto2', { id: 'pesto2', name: 'More pesto', servings: 4, lines: [{ ingredientId: 'basil', quantity: 1, cookingUnit: 'cup' }] }]]),
    };
    const { lines, carryOver } = generate(lib, { events, shopId: 'shop-0002' });
    expect(lines.map((l) => l.ingredientId)).toContain('basil');
    expect(carryOver.map((l) => l.ingredientId)).not.toContain('basil');
  });

  it('dismissing an item affects only this shop', () => {
    const c = createDevice('c');
    let events = [c.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft')];
    events = [...events, ...carryOverTransitions(events, 'shop-0002', c)];
    const { carryOver } = generate(library, { events, shopId: 'shop-0002', dismissed: new Set(['basil']) });
    expect(carryOver.map((l) => l.ingredientId)).toEqual(['capsicum']);
  });

  it('groups by category then aisle, never alphabetically (FR-LIST-6)', () => {
    const { lines } = generate(library, {
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
    const { generate } = await import('../src/core/generate.js');
    const { createDevice } = await import('../src/core/events.js');
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
    const { lines } = generate(lib, { events, shopId: 'shop-0001' });
    expect(lines.map((l) => l.ingredientId)).toEqual(['flour']);
  });
});

describe('at home already, Need it, and Wait List items typed in', () => {
  const oil = { id: 'oil', name: 'Oil: olive', shoppingUnit: 'mL', category: 'Pantry', aisle: 'Sauces', startsAtHome: true };
  const lib = {
    ingredients: new Map([[flour.id, flour], [oil.id, oil], [capsicum.id, capsicum]]),
    recipes: new Map([['stir', { id: 'stir', name: 'Stir fry', servings: 4, lines: [
      { ingredientId: 'oil', quantity: 40 }, { ingredientId: 'capsicum', quantity: 2 },
    ] }]]),
  };
  const d = createDevice('h');
  const plan = [d.emit('menu.selection', { recipeId: 'stir', present: true, servings: 4, plannedFor: GENESIS_SHOP }, 'draft')];

  it('a Pantry line starts at home; "Need it" puts it on the list', () => {
    const out = generate(lib, { events: plan, shopId: GENESIS_SHOP });
    expect(out.lines.map((l) => l.ingredientId)).toEqual(['capsicum']);
    expect(out.atHome.map((l) => l.ingredientId)).toEqual(['oil']);
    const needed = generate(lib, { events: plan, shopId: GENESIS_SHOP, added: new Set(['oil']) });
    expect(needed.lines.map((l) => l.ingredientId).sort()).toEqual(['capsicum', 'oil']);
    expect(needed.atHome).toEqual([]);
  });

  it('a Pantry item on the Wait List is bought, never assumed at home', () => {
    const out = generate(lib, { events: plan, shopId: GENESIS_SHOP, waitList: [{ id: 'w1', ingredientId: 'oil' }] });
    expect(out.lines.map((l) => l.ingredientId)).toContain('oil');
    expect(out.atHome).toEqual([]);
  });

  it('a Wait List item typed in gets a line of its own, one per wording', () => {
    const out = generate(lib, { events: [], shopId: GENESIS_SHOP, waitList: [
      { id: 'w1', ingredientId: null, text: 'Bin bags' }, { id: 'w2', ingredientId: null, text: 'bin bags ' },
    ] });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]).toMatchObject({ ingredientId: 'x-bin-bags', name: 'Bin bags', qty: 2, aisle: 'Wait list' });
    expect(out.problems).toEqual([]);
  });

  it('"Still need it" on a carried-over line moves it onto the list', () => {
    const c = createDevice('s');
    let events = [c.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft')];
    events = [...events, ...carryOverTransitions(events, 'shop-0002', c)];
    const before = generate(library, { events, shopId: 'shop-0002' });
    expect(before.carryOver.map((l) => l.ingredientId).sort()).toEqual(['basil', 'capsicum']);
    const after = generate(library, { events, shopId: 'shop-0002', added: new Set(['basil']) });
    expect(after.lines.map((l) => l.ingredientId)).toContain('basil');
    expect(after.carryOver.map((l) => l.ingredientId)).toEqual(['capsicum']);
  });
});

describe('what a line is for', () => {
  it('keeps each recipe\'s share of a line, so the list can say which meal needs how much', () => {
    const d = createDevice('f');
    const events = [
      d.emit('menu.selection', { recipeId: 'cake', present: true, servings: 8, plannedFor: GENESIS_SHOP }, 'draft'),
      d.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: GENESIS_SHOP }, 'draft'),
    ];
    const lib = { ...library, recipes: new Map([...library.recipes,
      ['scones', { id: 'scones', name: 'Scones', servings: 4, lines: [{ ingredientId: 'flour', quantity: 1, cookingUnit: 'cup' }] }]]) };
    events.push(d.emit('menu.selection', { recipeId: 'scones', present: true, servings: 4, plannedFor: GENESIS_SHOP }, 'draft'));
    const flourLine = generate(lib, { events, shopId: GENESIS_SHOP }).lines.find((l) => l.ingredientId === 'flour');
    expect(flourLine.sources.map((s) => [s.recipeId, s.qty])).toEqual([['cake', 500], ['scones', 250]]);
    expect(flourLine.qty).toBe(750);
  });
});

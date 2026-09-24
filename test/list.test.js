// The shopping list as a person sees it. Review #2.
//
// P3 asserted that an added line's *register* was true, and passed while the
// line never appeared on anyone's list. These tests assert on the list itself —
// the thing a person reads in the aisle — because that is where every failure
// the household reported was actually observed.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDevice } from '../src/core/events.js';
import { generate } from '../src/core/generate.js';
import { lockEvent } from '../src/core/shop.js';

const ING = {
  flour:  { id: 'flour',  name: 'Flour',  shoppingUnit: 'g',   category: 'Pantry', aisle: 'Baking', conversions: { cup: 250 } },
  eggs:   { id: 'eggs',   name: 'Eggs',   shoppingUnit: 'qty', category: 'Cold',   aisle: 'Dairy' },
  basil:  { id: 'basil',  name: 'Basil',  shoppingUnit: 'g',   category: 'Fruit and Vegetables', aisle: 'Vegetables', conversions: { cup: 250 } },
  mayo:   { id: 'mayo',   name: 'Mayo',   shoppingUnit: 'qty', category: 'Pantry', aisle: 'Sauces' },
  milk:   { id: 'milk',   name: 'Milk',   shoppingUnit: 'mL',  category: 'Cold',   aisle: 'Dairy', isStaple: true, stapleQty: 2000 },
};
const RECIPES = {
  cake:  { id: 'cake',  name: 'Cake',  servings: 8, lines: [{ ingredientId: 'flour', quantity: 2, cookingUnit: 'cup' }, { ingredientId: 'eggs', quantity: 3 }] },
  pesto: { id: 'pesto', name: 'Pesto', servings: 4, lines: [{ ingredientId: 'basil', quantity: 1, cookingUnit: 'cup' }] },
};
const S = 'shop-0001';

/** Library as events, so a recipe edit is just another event — as it is in the app. */
function libraryEvents(d) {
  return [
    ...Object.values(ING).map((i) => d.emit('ingredient.upsert', { ingredientId: i.id, ingredient: i }, 'draft')),
    ...Object.values(RECIPES).map((r) => d.emit('recipe.upsert', { recipeId: r.id, recipe: r }, 'draft')),
  ];
}
const plan = (d, recipeId, servings = 8) =>
  d.emit('menu.selection', { recipeId, present: true, servings, plannedFor: S }, 'draft');
const ids = (lines) => lines.map((l) => l.ingredientId).sort();

/** Lock the shop the way the app does: from this device's own view of the list. */
function lock(d, events) {
  const { lines } = generate({ events, shopId: S });
  return lockEvent(d, S, lines, events);
}

describe('the list, as a person sees it (review #2)', () => {
  it('a line suppressed in the pantry check is not on the list, and not reported as missed', () => {
    const d = createDevice('a');
    let ev = [...libraryEvents(d), plan(d, 'cake')];
    ev.push(d.emit('line.suppressed', { shopId: S, ingredientId: 'flour', suppressed: true }, 'draft'));
    expect(ids(generate({ events: ev, shopId: S }).lines)).toEqual(['eggs', 'milk']);
  });

  it('a mid-shop addition appears on the list (FR-SHOP-1)', () => {
    const d = createDevice('a');
    let ev = [...libraryEvents(d), plan(d, 'cake')];
    ev.push(lock(d, ev));
    ev.push(d.emit('line.added', { shopId: S, ingredientId: 'mayo', present: true }, 'open'));
    expect(ids(generate({ events: ev, shopId: S }).lines)).toContain('mayo');
  });

  it('"Still need it" moves a carried-over item onto the list and out of the check section', () => {
    const d = createDevice('a');
    let ev = [...libraryEvents(d),
      d.emit('menu.selection', { recipeId: 'pesto', present: true, servings: 4, plannedFor: 'shop-0000' }, 'draft'),
      d.emit('menu.carried', { recipeId: 'pesto', shopId: S, carried: true }, 'draft')];
    expect(ids(generate({ events: ev, shopId: S }).carryOver)).toEqual(['basil']);
    ev.push(d.emit('line.added', { shopId: S, ingredientId: 'basil', present: true }, 'draft'));
    const after = generate({ events: ev, shopId: S });
    expect(ids(after.lines)).toContain('basil');
    expect(after.carryOver).toEqual([]);
  });

  it('a recipe edited mid-shop does not change the list someone is shopping from (§6)', () => {
    const d = createDevice('a');
    let ev = [...libraryEvents(d), plan(d, 'cake')];
    ev.push(lock(d, ev));
    ev.push(d.emit('line.done', { shopId: S, ingredientId: 'eggs', done: true }, 'open'));
    // Whoever is cooking removes eggs from the recipe. FR-REC-2 permits it.
    const cook = createDevice('cook').observe(ev);
    ev.push(cook.emit('recipe.upsert', { recipeId: 'cake',
      recipe: { ...RECIPES.cake, lines: RECIPES.cake.lines.filter((l) => l.ingredientId !== 'eggs') } }, 'open'));
    expect(ids(generate({ events: ev, shopId: S }).lines)).toContain('eggs');
  });

  it('a menu addition in flight as the list locks lands on the list as an addition (§8.1)', () => {
    const a = createDevice('a');
    const b = createDevice('b');
    const lib = libraryEvents(a);
    b.observe(lib);
    let ev = [...lib, plan(a, 'cake')];
    const inFlight = plan(b, 'pesto', 4);           // b has not seen the lock
    ev.push(lock(a, ev));
    ev.push(inFlight);
    const { lines } = generate({ events: ev, shopId: S });
    expect(ids(lines)).toContain('basil');
    expect(lines.find((l) => l.ingredientId === 'basil').addedAfterLock).toBe(true);
  });

  it('two people locking at once with different lists: the union, never one of them', () => {
    const a = createDevice('a');
    const b = createDevice('b');
    const lib = libraryEvents(a);
    b.observe(lib);
    const evA = [...lib, plan(a, 'cake')];
    const evB = [...lib, plan(b, 'pesto', 4)];
    const all = [...lib, evA.at(-1), evB.at(-1), lock(a, evA), lock(b, evB)];
    const { lines } = generate({ events: all, shopId: S });
    expect(ids(lines)).toEqual(['basil', 'eggs', 'flour', 'milk']);
    // Both lists were *locked* lists. Found by `npm run mutate`: keeping only
    // one lock still produced these ids, because the dropped list's recipe was
    // re-derived as an in-flight addition — so the ids alone cannot tell a
    // union from a replacement. What can: those lines must not read as added
    // during the shop...
    expect(lines.filter((l) => l.addedAfterLock).map((l) => l.ingredientId)).toEqual([]);

    // ...and, the case that matters, a recipe edited after the lock must not
    // take a line off either locked list. Re-derivation would use the edited
    // recipe, and the ticked eggs would vanish (§6).
    const cook = createDevice('cook').observe(all);
    const edited = [...all, cook.emit('recipe.upsert', { recipeId: 'cake',
      recipe: { ...RECIPES.cake, lines: RECIPES.cake.lines.filter((l) => l.ingredientId !== 'eggs') } }, 'open')];
    expect(ids(generate({ events: edited, shopId: S }).lines)).toContain('eggs');
  });

  it('once a shop is open, no line ever leaves the list — whatever anyone does', () => {
    // The user-visible form of FR-SYNC-1: a line disappearing takes its tick
    // with it, as far as the person holding the phone can tell.
    const opArb = fc.oneof(
      fc.record({ kind: fc.constant('tick'),   line: fc.constantFrom(...Object.keys(ING)) }),
      fc.record({ kind: fc.constant('add'),    line: fc.constantFrom(...Object.keys(ING)) }),
      fc.record({ kind: fc.constant('wait'),   line: fc.constantFrom(...Object.keys(ING)) }),
      fc.record({ kind: fc.constant('edit'),   recipe: fc.constantFrom('cake', 'pesto'), keep: fc.nat(2) }),
      fc.record({ kind: fc.constant('unstaple') }),
    );
    fc.assert(fc.property(fc.array(opArb, { maxLength: 25 }), (ops) => {
      const d = createDevice('a');
      let ev = [...libraryEvents(d), plan(d, 'cake')];
      ev.push(lock(d, ev));
      let seen = new Set(ids(generate({ events: ev, shopId: S }).lines));
      for (const op of ops) {
        d.observe(ev);
        if (op.kind === 'tick') ev.push(d.emit('line.done', { shopId: S, ingredientId: op.line, done: true }, 'open'));
        if (op.kind === 'add')  ev.push(d.emit('line.added', { shopId: S, ingredientId: op.line, present: true }, 'open'));
        if (op.kind === 'wait') ev.push(d.emit('waitlist.item', { itemId: `w${ev.length}`, ingredientId: op.line, present: true }, 'open'));
        if (op.kind === 'edit') ev.push(d.emit('recipe.upsert', { recipeId: op.recipe,
          recipe: { ...RECIPES[op.recipe], lines: RECIPES[op.recipe].lines.slice(0, op.keep) } }, 'open'));
        if (op.kind === 'unstaple') ev.push(d.emit('ingredient.upsert', { ingredientId: 'milk',
          ingredient: { ...ING.milk, isStaple: false } }, 'open'));
        const now = new Set(ids(generate({ events: ev, shopId: S }).lines));
        for (const line of seen) expect(now.has(line)).toBe(true);
        seen = now;
      }
    }), { numRuns: 300 });
  });
});

describe('a recipe line the list cannot convert (review #5)', () => {
  it('is reported as a problem, and the rest of the list still renders', () => {
    // "tbsp" where the data says "TBsp" — one edit by whoever is cooking.
    const d = createDevice('a');
    const bad = { ...RECIPES.cake, lines: [...RECIPES.cake.lines, { ingredientId: 'flour', quantity: 1, cookingUnit: 'tbsp' }] };
    const ev = [...libraryEvents(d),
      d.emit('recipe.upsert', { recipeId: 'cake', recipe: bad }, 'draft'),
      plan(d, 'cake')];
    let result;
    expect(() => { result = generate({ events: ev, shopId: S }); }).not.toThrow();
    expect(result.problems).toContainEqual(expect.objectContaining({
      kind: 'missing-conversion', recipeId: 'cake', ingredientId: 'flour', unit: 'tbsp' }));
    expect(ids(result.lines)).toEqual(['eggs', 'flour', 'milk']);   // everything else intact
  });

  it('a recipe with no servings baseline is reported too, not thrown', () => {
    const d = createDevice('a');
    const ev = [...libraryEvents(d),
      d.emit('recipe.upsert', { recipeId: 'cake', recipe: { ...RECIPES.cake, servings: 0 } }, 'draft'),
      plan(d, 'cake')];
    let result;
    expect(() => { result = generate({ events: ev, shopId: S }); }).not.toThrow();
    expect(result.problems).toContainEqual(expect.objectContaining({ kind: 'no-servings', recipeId: 'cake' }));
  });
});

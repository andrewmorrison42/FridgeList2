// A household over several weeks, driven through the app's own actions.
// Glitches #2, #3, #10.
//
// Every test before this one stopped at week one, and the weekly routine is
// where the household actually lives. Walking two weeks found three glitches in
// minutes: a favourite cooked last week could never be planned again; last
// week's uncooked meal sat on the main list all through planning and only moved
// to "check before buying" when the menu locked — after the pantry check it
// exists for; and cooked meals never left the plan.

import { describe, it, expect, beforeEach } from 'vitest';
import fc from 'fast-check';
import { createApp } from '../src/ui/app.js';
import { createMemoryStorage } from '../src/data/storage.js';
import { PLANNED, CARRIED, FLAGGED, COOKED } from '../src/core/carryover.js';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const LIBRARY = {
  ingredients: [
    { id: 'noodles', name: 'Noodles', shoppingUnit: 'g', category: 'Pantry', aisle: 'Rice/pasta' },
    { id: 'prawns',  name: 'Prawns',  shoppingUnit: 'g', category: 'Meat',   aisle: 'Fish' },
    { id: 'pasta',   name: 'Pasta',   shoppingUnit: 'g', category: 'Pantry', aisle: 'Rice/pasta' },
    { id: 'eggplant',name: 'Eggplant',shoppingUnit: 'qty', category: 'Fruit and Vegetables', aisle: 'Vegetables' },
    { id: 'lamb',    name: 'Lamb',    shoppingUnit: 'g', category: 'Meat',   aisle: 'Meat' },
  ],
  recipes: [
    { id: 'laksa',     name: 'Fish Laksa',          servings: 4, lines: [{ ingredientId: 'noodles', quantity: 400 }, { ingredientId: 'prawns', quantity: 300 }] },
    { id: 'spaghetti', name: 'Sicilian Spaghetti',  servings: 4, lines: [{ ingredientId: 'pasta', quantity: 500 }, { ingredientId: 'eggplant', quantity: 2 }] },
    { id: 'lamb',      name: 'Roast Lamb',          servings: 6, lines: [{ ingredientId: 'lamb', quantity: 2000 }] },
  ],
};

async function household() {
  const app = await createApp({ storage: createMemoryStorage() });
  await app.loadLibrary(LIBRARY);
  const plan = () => [...app.selections.values()].map((s) => `${s.recipeId}:${s.status}`).sort();
  const onList = (ingredientId) => app.list().lines.some((l) => l.ingredientId === ingredientId);
  const toCheck = (ingredientId) => app.list().carryOver.some((l) => l.ingredientId === ingredientId);
  const sel = (recipeId) => [...app.selections.values()].find((s) => s.recipeId === recipeId);
  const shop = async () => { app.lockShop(); await app.closeShop(); };
  return { app, plan, onList, toCheck, sel, shop };
}

describe('a household over several weeks', () => {
  let h;
  beforeEach(async () => { h = await household(); });

  it('#10 — a meal cooked last week has left this week\'s plan', async () => {
    h.app.planRecipe('laksa', 4);
    h.app.lockShop();
    h.app.markCooked('laksa', h.sel('laksa').plannedFor);
    await h.app.closeShop();
    expect(h.plan()).toEqual([]);
  });

  it('#2 — a favourite cooked last week can be planned again, and is bought for again', async () => {
    h.app.planRecipe('laksa', 4);
    h.app.lockShop();
    h.app.markCooked('laksa', h.sel('laksa').plannedFor);
    await h.app.closeShop();

    h.app.planRecipe('laksa', 4);
    expect(h.plan()).toEqual(['laksa:planned']);
    expect(h.onList('noodles')).toBe(true);
  });

  it('#3 — last week\'s uncooked meal is carried over *during planning*, in the check section', async () => {
    h.app.planRecipe('spaghetti', 4);
    await h.shop();                                   // not cooked

    // Week 2, before anyone presses "Menu is settled":
    expect(h.plan()).toEqual(['spaghetti:carried']);
    expect(h.onList('pasta')).toBe(false);            // not bought by default (FR-MENU-7)
    expect(h.toCheck('pasta')).toBe(true);            // but there to check, now, in the pantry
  });

  it('carries once, then is flagged for a decision (FR-MENU-5)', async () => {
    h.app.planRecipe('spaghetti', 4);
    await h.shop();
    await h.shop();
    expect(h.plan()).toEqual(['spaghetti:flagged']);
  });

  it('re-planning a carried meal resolves it: one entry, planned, bought for', async () => {
    h.app.planRecipe('spaghetti', 4);
    await h.shop();
    await h.shop();                                   // flagged
    h.app.planRecipe('spaghetti', 4);                 // "deliberately re-plan it"
    expect(h.plan()).toEqual(['spaghetti:planned']);
    expect(h.onList('pasta')).toBe(true);
  });

  it('cooking a carried meal after the shop settles it (FR-MENU-2)', async () => {
    h.app.planRecipe('spaghetti', 4);
    await h.shop();
    h.app.markCooked('spaghetti', h.sel('spaghetti').plannedFor);
    // Cooked this week, so it stays visible as cooked until this shop closes...
    expect(h.plan()).toEqual(['spaghetti:cooked']);
    expect(h.toCheck('pasta')).toBe(false);
    await h.shop();
    expect(h.plan()).toEqual([]);                     // ...then leaves.
  });

  it('over any run of weeks: no recipe twice on a plan, and nothing cooked in a past week lingers', async () => {
    const weekArb = fc.record({
      plan: fc.subarray(['laksa', 'spaghetti', 'lamb']),
      cook: fc.subarray(['laksa', 'spaghetti', 'lamb']),
    });
    await fc.assert(fc.asyncProperty(fc.array(weekArb, { minLength: 1, maxLength: 6 }), async (weeks) => {
      const w = await household();
      for (const week of weeks) {
        for (const r of week.plan) w.app.planRecipe(r, 4);
        w.app.lockShop();
        for (const r of week.cook) { const s = w.sel(r); if (s) w.app.markCooked(r, s.plannedFor); }
        await w.app.closeShop();
        const plan = [...w.app.selections.values()];
        const ids = plan.map((s) => s.recipeId);
        expect(new Set(ids).size).toBe(ids.length);
        expect(plan.filter((s) => s.status === COOKED)).toEqual([]);   // a shop just closed
        for (const s of plan) expect([CARRIED, FLAGGED]).toContain(s.status);
      }
    }), { numRuns: 60 });
  });
});

describe('servings (FR-MENU-1 — unbuilt until v0.6)', () => {
  it('changing a planned meal\'s servings scales what is bought for it', async () => {
    const h = await household();
    h.app.planRecipe('laksa', 4);
    const qty = () => h.app.list().lines.find((l) => l.ingredientId === 'noodles').qty;
    expect(qty()).toBe(400);
    h.app.setServings('laksa', h.sel('laksa').plannedFor, 8);
    expect(h.sel('laksa').servings).toBe(8);
    expect(qty()).toBe(800);
  });

  it('servings are part of the menu, so they lock with it (FR-SHOP-3)', async () => {
    const h = await household();
    h.app.planRecipe('laksa', 4);
    h.app.lockShop();
    expect(h.app.can.canEditMenu).toBe(false);
    // The specific refusal, not just any error — a bare toThrow() passed here
    // before setServings existed at all.
    expect(() => h.app.setServings('laksa', h.sel('laksa').plannedFor, 8)).toThrow(/not permitted while a shop is open/);
  });
});

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

  it('P11 — over any run of weeks: no recipe twice on a plan, and nothing cooked in a past week lingers', async () => {
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

describe('glitches found on the screenshot sheet', () => {
  it('#17 — a phone nobody has named has no name, not a random id', async () => {
    const { deviceIdentity } = await import('../src/data/persist.js');
    expect(deviceIdentity().nickname).toBe('');
  });

  it('#18 — loading the library again never overwrites a recipe edited in the app', async () => {
    const h = await household();
    const edited = { ...h.app.library.recipes.get('laksa'), name: 'Fish Laksa (our way)', servings: 6 };
    h.app.store.apply(
      (await import('../src/core/events.js')).createDevice('cook').observe(h.app.store.events)
        .emit('recipe.upsert', { recipeId: 'laksa', recipe: edited }, 'draft'),
    );
    await h.app.loadLibrary(LIBRARY);                 // e.g. the first-run bootstrap, run again
    expect(h.app.library.recipes.get('laksa').name).toBe('Fish Laksa (our way)');
  });

  it('#18 — ...but a recipe the device does not have yet is still added', async () => {
    const h = await household();
    await h.app.loadLibrary({ ...LIBRARY, recipes: [...LIBRARY.recipes,
      { id: 'soup', name: 'Soup', servings: 4, lines: [{ ingredientId: 'noodles', quantity: 100 }] }] });
    expect(h.app.library.recipes.has('soup')).toBe(true);
  });
});

describe('the Wait List (FR-WAIT-1 — the note was unbuilt until v0.6)', () => {
  it('an item carries an optional note, and the shopping list shows it', async () => {
    const h = await household();
    h.app.addWaitList('prawns', { note: 'the big bag' });
    expect(h.app.waitList()[0].note).toBe('the big bag');
    const line = h.app.list().lines.find((l) => l.ingredientId === 'prawns');
    expect(line.notes).toEqual(['the big bag']);
  });

  it('something that is not an ingredient can still go on the Wait List, and reaches the list', async () => {
    // Searching for "birthday candles" used to end at "0 matches" and a dead end.
    const h = await household();
    h.app.addWaitList(null, { name: 'Birthday candles' });
    expect(h.app.waitList().map((i) => i.name)).toEqual(['Birthday candles']);
    const line = h.app.list().lines.find((l) => l.name === 'Birthday candles');
    expect(line).toBeTruthy();
    expect(line.category).toBe('Other');
  });

  it('...and, once bought, comes off the Wait List like anything else (FR-LIST-7)', async () => {
    const h = await household();
    h.app.addWaitList(null, { name: 'Birthday candles' });
    h.app.lockShop();
    const line = h.app.list().lines.find((l) => l.name === 'Birthday candles');
    h.app.setDone(line.ingredientId, true);
    await h.app.closeShop();
    expect(h.app.waitList()).toEqual([]);
  });
});

describe('P8 — Wait List closure (FR-LIST-7, FR-WAIT-2)', () => {
  // Listed in ARCHITECTURE §14 from v0.3 and never written — so completing a
  // shop in which any Wait List item had been ticked threw, and the shop could
  // not be completed at all. Found while building the Wait List note.
  it('P8 — a Wait List item ticked in a shop is gone once the shop is completed, and completing never throws', async () => {
    const h = await household();
    h.app.addWaitList('prawns');
    h.app.lockShop();
    h.app.setDone('prawns', true);
    await expect(h.app.closeShop()).resolves.toBeTruthy();
    expect(h.app.shop.id).toBe('shop-0002');
    expect(h.app.waitList()).toEqual([]);
  });

  it('P8 — one not ticked is still there next week (FR-WAIT-2)', async () => {
    const h = await household();
    h.app.addWaitList('prawns');
    await h.shop();
    expect(h.app.waitList().map((i) => i.ingredientId)).toEqual(['prawns']);
  });

  it('P8 — a tick in an earlier shop does not fulfil an item added after it', async () => {
    const h = await household();
    h.app.planRecipe('laksa', 4);                     // laksa needs prawns
    h.app.lockShop();
    h.app.setDone('prawns', true);
    await h.app.closeShop();
    h.app.addWaitList('prawns');                      // running low again, the week after
    expect(h.app.waitList().map((i) => i.ingredientId)).toEqual(['prawns']);
  });
});

describe('P4 — deriving the list never writes anything (FR-SHOP-2)', () => {
  it('P4 — generating, at any point in any run of weeks, leaves the store exactly as it was', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({
      plan: fc.subarray(['laksa', 'spaghetti', 'lamb']), tick: fc.boolean(), close: fc.boolean(),
    }), { maxLength: 5 }), async (weeks) => {
      const w = await household();
      const unchanged = () => {
        const before = [w.app.store.version, w.app.store.events.length];
        w.app.generateList(); w.app.list(); w.app.outstanding();
        expect([w.app.store.version, w.app.store.events.length]).toEqual(before);
      };
      for (const week of weeks) {
        // Only what the app permits at that point: a week that was not closed
        // leaves its shop open, and the next cannot plan or lock.
        if (w.app.can.canEditMenu) for (const r of week.plan) w.app.planRecipe(r, 4);
        unchanged();
        if (w.app.can.canLock) w.app.lockShop();
        unchanged();
        if (week.tick) { const l = w.app.list().lines[0]; if (l) w.app.setDone(l.ingredientId, true); }
        unchanged();
        if (week.close) await w.app.closeShop();
        unchanged();
      }
    }), { numRuns: 40 });
  });
});

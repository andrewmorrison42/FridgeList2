// Editing and creating recipes. FR-REC-2 — "any user may create or edit any
// recipe at any time" — unbuilt until v0.6.

import { describe, it, expect } from 'vitest';
import { draftFromRecipe, recipeFromDraft, unitsFor } from '../src/core/library.js';
import { createApp, STALE_RECIPE } from '../src/ui/app.js';
import { createMemoryStorage } from '../src/data/storage.js';

globalThis.localStorage ??= { getItem: () => null, setItem: () => {}, removeItem: () => {} };

const ING = new Map([
  ['stock', { id: 'stock', name: 'Stock: vegetable', shoppingUnit: 'mL', conversions: { cup: 250 } }],
  ['rice',  { id: 'rice',  name: 'Rice: arborio',   shoppingUnit: 'g',  conversions: { cup: 250 } }],
  ['leek',  { id: 'leek',  name: 'Leek',            shoppingUnit: 'qty', conversions: {} }],
]);
// As imported: quantities already in shopping units, the cup amounts for display.
const RISOTTO = {
  id: 'mushroom-risotto', name: 'Mushroom Risotto', servings: 4,
  lines: [
    { ingredientId: 'stock', quantity: 1500, cookingUnit: null, displayQty: '6', displayUnit: 'cup' },
    { ingredientId: 'rice', quantity: 563, cookingUnit: null, displayQty: '2 ¼', displayUnit: 'cup' },
    { ingredientId: 'leek', quantity: 1, cookingUnit: null, displayQty: null, displayUnit: null },
  ],
  method: ['Heat the oil.', 'Add the rice.'],
};

describe('recipe editing (FR-REC-2)', () => {
  it('saving without changing anything gives back exactly the recipe', () => {
    const { recipe, errors } = recipeFromDraft(draftFromRecipe(RISOTTO, ING), ING, new Set(['mushroom-risotto']));
    expect(errors).toEqual([]);
    expect(recipe).toEqual(RISOTTO);
  });

  it('an untouched line keeps its exact imported quantity when another line is edited', () => {
    // The figure the household buys by must not drift because someone fixed a
    // different line.
    const d = draftFromRecipe(RISOTTO, ING);
    d.lines[2] = { ...d.lines[2], qtyText: '2', dirty: true };
    const { recipe } = recipeFromDraft(d, ING, new Set());
    expect(recipe.lines[0]).toEqual(RISOTTO.lines[0]);           // 1500 mL, exactly
    expect(recipe.lines[1]).toEqual(RISOTTO.lines[1]);
    expect(recipe.lines[2]).toMatchObject({ ingredientId: 'leek', quantity: 2, cookingUnit: null });
  });

  it('a line edited in cups is kept in cups, and converts through the ingredient', () => {
    const d = draftFromRecipe(RISOTTO, ING);
    expect(d.lines[0]).toMatchObject({ qtyText: '6', unit: 'cup' });   // shown as the recipe reads
    d.lines[0] = { ...d.lines[0], qtyText: '8', dirty: true };
    const { recipe } = recipeFromDraft(d, ING, new Set());
    expect(recipe.lines[0]).toEqual({ ingredientId: 'stock', quantity: 8, cookingUnit: 'cup', displayQty: '8', displayUnit: 'cup' });
  });

  it('offers only units that can actually be converted', () => {
    expect(unitsFor(ING.get('stock'))).toEqual(['mL', 'cup']);
    expect(unitsFor(ING.get('leek'))).toEqual(['qty']);
  });

  it('refuses what cannot be shopped for, saying why — and saves nothing', () => {
    const d = draftFromRecipe(RISOTTO, ING);
    d.name = '  ';
    d.servings = '0';
    d.lines[1] = { ...d.lines[1], qtyText: 'a handful', dirty: true };
    d.lines[2] = { ...d.lines[2], unit: 'tbsp', dirty: true };
    const { recipe, errors } = recipeFromDraft(d, ING, new Set());
    expect(recipe).toBe(null);
    expect(errors).toEqual([
      'The recipe needs a name.',
      'Servings must be a whole number of at least 1.',
      '"a handful" is not an amount (Rice: arborio).',
      'Leek cannot be measured in tbsp — it has no conversion to qty.',
    ]);
  });

  it('a blank amount means "to serve", which never reaches the shopping list', () => {
    const d = draftFromRecipe(RISOTTO, ING);
    d.lines[2] = { ...d.lines[2], qtyText: '', dirty: true };
    const { recipe } = recipeFromDraft(d, ING, new Set());
    expect(recipe.lines[2]).toEqual({ ingredientId: 'leek', quantity: 0, garnish: true });
  });

  it('a new recipe gets a readable id that does not collide', () => {
    const d = draftFromRecipe(null, ING);
    d.name = 'Mushroom Risotto';
    d.servings = '4';
    d.lines.push({ ingredientId: 'rice', qtyText: '1', unit: 'cup', original: null, dirty: true });
    const { recipe } = recipeFromDraft(d, ING, new Set(['mushroom-risotto']));
    expect(recipe.id).toBe('mushroom-risotto-2');
    expect(recipe.lines).toHaveLength(1);
  });
});

describe('the household library round-trips through the editor', () => {
  it('opening and saving any of the imported recipes changes nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const lib = JSON.parse(readFileSync(new URL('../data/library.json', import.meta.url)));
    const ings = new Map(lib.ingredients.map((i) => [i.id, i]));
    const ids = new Set(lib.recipes.map((r) => r.id));
    for (const r of lib.recipes) {
      const { recipe, errors } = recipeFromDraft(draftFromRecipe(r, ings), ings, ids);
      expect(errors, r.name).toEqual([]);
      expect(recipe, r.name).toEqual(r);
    }
  });
});

describe('saving an edited recipe in the app', () => {
  const LIB = {
    ingredients: [{ id: 'noodles', name: 'Noodles', shoppingUnit: 'g', category: 'Pantry', aisle: 'Rice/pasta', conversions: { cup: 100 } }],
    recipes: [{ id: 'laksa', name: 'Fish Laksa', servings: 4, lines: [{ ingredientId: 'noodles', quantity: 400 }], method: [] }],
  };
  const setup = async () => {
    const app = await createApp({ storage: createMemoryStorage() });
    await app.loadLibrary(LIB);
    const edit = (qtyText) => {
      const d = draftFromRecipe(app.library.recipes.get('laksa'), app.library.ingredients);
      d.lines[0] = { ...d.lines[0], qtyText, dirty: true };
      return d;
    };
    const noodles = () => app.list().lines.find((l) => l.ingredientId === 'noodles')?.qty;
    return { app, edit, noodles };
  };

  it('an edit reaches the next list, and a list being shopped is not changed under the shopper', async () => {
    const { app, edit, noodles } = await setup();
    app.planRecipe('laksa', 4);
    app.lockShop();
    expect(app.saveRecipe(edit('800')).errors).toEqual([]);   // allowed while shopping (FR-REC-2)
    expect(noodles()).toBe(400);                               // the snapshot taken at the lock
    await app.closeShop();
    app.planRecipe('laksa', 4);
    expect(noodles()).toBe(800);
  });

  it('saving a copy opened before someone else saved is refused, not silently undoing theirs', async () => {
    const { app, edit } = await setup();
    const mine = edit('800');
    app.saveRecipe(edit('600'));                              // someone else, meanwhile
    expect(app.saveRecipe(mine)).toEqual({ recipe: null, errors: [STALE_RECIPE] });
    expect(app.library.recipes.get('laksa').lines[0].quantity).toBe(600);
  });

  it('saving without a change writes nothing — an unchanged copy must not win over a later edit', async () => {
    const { app } = await setup();
    const before = app.store.version;
    const d = draftFromRecipe(app.library.recipes.get('laksa'), app.library.ingredients);
    expect(app.saveRecipe(d).errors).toEqual([]);
    expect(app.store.version).toBe(before);
  });
});

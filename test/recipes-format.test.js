// The recipe file is shared with the earlier version of the app, so these
// check two things: that it is read correctly, and that editing one recipe
// leaves the file exactly as the earlier app wrote it everywhere else.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { importLibrary, recipeToDraft, applyDraft, blankRow, unitChoices } from '../src/core/recipes-format.js';
import { generate } from '../src/core/generate.js';
import { createDevice } from '../src/core/events.js';

const seed = JSON.parse(readFileSync(new URL('../data/recipes-data.reviewed.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(seed);
const recipe = (src, id) => src.recipes.find((r) => r.id === id);

const toLibrary = (src) => {
  const { library } = importLibrary(src);
  return {
    recipes: new Map(library.recipes.map((r) => [r.id, r])),
    ingredients: new Map(library.ingredients.map((i) => [i.id, i])),
  };
};

describe('reading the file', () => {
  it('takes quantities as already in shopping units, not converting them again', () => {
    // 2 cups of wine is stored as 500 mL. Converting from the cup a second time
    // put 125,000 mL on the list.
    const lib = toLibrary(fresh());
    const d = createDevice('d1');
    const events = [d.emit('menu.selection', { recipeId: 'mushroom-risotto', present: true, servings: 4 }, 'draft')];
    const { lines } = generate(lib, { events, shopId: 'shop:genesis' });
    const wine = lines.find((l) => l.name === 'Wine: white');
    expect(wine.qty).toBe(500);
    expect(wine.unit).toBe('mL');
  });
});

describe('editing one recipe', () => {
  it('opening and saving without changes leaves the file byte-identical', () => {
    const src = fresh();
    const out = applyDraft(src, recipeToDraft(src, 'mushroom-risotto'));
    expect(JSON.stringify(out.source)).toBe(JSON.stringify(seed));
  });

  it('changes only the edited recipe, keeping fields this app does not use', () => {
    const src = fresh();
    recipe(src, 'mushroom-risotto').lastPlanned = '2026-09-01';   // the earlier app's field
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.method += '\nServe with crusty bread';
    const { source: next } = applyDraft(src, draft);

    const edited = recipe(next, 'mushroom-risotto');
    expect(edited.method.at(-1)).toBe('Serve with crusty bread');
    expect(edited.lastPlanned).toBe('2026-09-01');
    expect(edited.wikiTitle).toBe(recipe(src, 'mushroom-risotto').wikiTitle);
    // Every other recipe, every ingredient, meta and settings are untouched.
    const others = (s) => JSON.stringify({ ...s, recipes: s.recipes.filter((r) => r.id !== 'mushroom-risotto') });
    expect(others(next)).toBe(others(src));
    // And untouched lines of the edited recipe are the same objects' contents.
    expect(edited.ingredients).toEqual(recipe(src, 'mushroom-risotto').ingredients);
  });

  it('stores a kitchen measure the way the earlier app does', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    const wine = draft.rows.find((r) => r.name === 'Wine: white');
    wine.qty = '1 ½';
    const { source: next } = applyDraft(src, draft);
    const line = recipe(next, 'mushroom-risotto').ingredients.find((l) => l.ingredientName === 'Wine: white');
    expect(line).toMatchObject({ quantity: 375, unit: 'mL', displayQty: '1 ½', displayUnit: 'cup' });
  });

  it('switching a line from a measure to the shopping unit drops the display measure', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    const wine = draft.rows.find((r) => r.name === 'Wine: white');
    Object.assign(wine, { qty: '400', unit: 'mL' });
    const { source: next } = applyDraft(src, draft);
    const line = recipe(next, 'mushroom-risotto').ingredients.find((l) => l.ingredientName === 'Wine: white');
    expect(line).toEqual({ ingredientName: 'Wine: white', quantity: '400', unit: 'mL' });
  });

  it('refuses a fraction the measure does not allow, and an amount that is not a number', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.rows.find((r) => r.name === 'Wine: white').qty = '1 1/5';
    expect(applyDraft(src, draft).error).toMatch(/isn't a valid amount in cup/);

    const d2 = recipeToDraft(src, 'mushroom-risotto');
    d2.rows.find((r) => r.name === 'Leek').qty = 'a few';
    expect(applyDraft(src, d2).error).toMatch(/needs to be a number/);
  });

  it('adds an unknown ingredient to the list, uncategorised, in mL if measured', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.rows.push({ ...blankRow(draft), name: 'Truffle oil', qty: '1', unit: 'tsp' });
    const { source: next } = applyDraft(src, draft);
    const ing = next.ingredients.at(-1);
    expect(ing).toMatchObject({ name: 'Truffle oil', shoppingUnit: 'mL', aisle: 'Uncategorised', shoppingCategory: 'Other' });
    expect(Number.isFinite(ing.id)).toBe(true);
    const line = recipe(next, 'mushroom-risotto').ingredients.at(-1);
    expect(line).toMatchObject({ ingredientName: 'Truffle oil', quantity: 5, unit: 'mL', displayQty: '1', displayUnit: 'tsp' });
    // And the new line reaches the library the shopping list is built from.
    const lib = toLibrary(next);
    expect(lib.recipes.get('mushroom-risotto').lines).toHaveLength(recipe(next, 'mushroom-risotto').ingredients.length);
  });

  it('refuses to save over a change someone else made to the same recipe', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.notes = 'mine';
    const theirs = fresh();
    recipe(theirs, 'mushroom-risotto').notes = 'theirs';
    expect(applyDraft(theirs, draft)).toEqual({ conflict: true });
  });

  it('keeps a change someone else made to a different recipe', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.notes = 'mine';
    const theirs = fresh();
    recipe(theirs, 'pumpkin-and-bean-curry').notes = 'theirs';
    // Their planning stamp on this recipe is not an edit and does not block it.
    recipe(theirs, 'mushroom-risotto').lastPlanned = '2026-09-20';
    const { source: next } = applyDraft(theirs, draft);
    expect(recipe(next, 'pumpkin-and-bean-curry').notes).toBe('theirs');
    expect(recipe(next, 'mushroom-risotto')).toMatchObject({ notes: 'mine', lastPlanned: '2026-09-20' });
  });

  it('creates a new recipe with a unique id', () => {
    const src = fresh();
    const draft = recipeToDraft(src, null);
    Object.assign(draft, { name: 'Mushroom Risotto', method: 'Cook it' });
    draft.rows.push({ ...blankRow(draft), name: 'leek', qty: '2', unit: '' });
    const { source: next, recipeId } = applyDraft(src, draft);
    expect(recipeId).toBe('mushroom-risotto-2');
    const r = recipe(next, recipeId);
    expect(Object.keys(r)).toEqual(['id', 'name', 'category', 'servings', 'slowCooker', 'inSeason',
      'ingredients', 'method', 'images', 'notes', 'source']);
    // A name matched ignoring case is stored as the list spells it.
    expect(r.ingredients[0].ingredientName).toBe('Leek');
  });

  it('offers kitchen measures only for ingredients bought by weight or volume', () => {
    const src = fresh();
    expect(unitChoices(src, 'Wine: white')).toEqual({ kind: 'choose', options: ['mL', 'cup', 'TBsp', 'tsp'] });
    expect(unitChoices(src, 'nothing like this')).toEqual({ kind: 'free' });
  });
});

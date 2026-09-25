// Editing more of the shared recipe file: section headings and line order,
// recipe flags and links, new ingredients with a place on the list, deleting,
// the ingredient list, staples and the shared switches. As in
// recipes-format.test.js, the point is both that the change is made and that
// nothing else in the file moves, because the earlier app reads it too.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  importLibrary, recipeToDraft, applyDraft, blankRow, moveItem, isHeading, unitChoices, deleteRecipe,
  setIngredient, needsAttention, staplesOf, setStaple, removeStaple, setFeature, featureOn,
} from '../src/core/recipes-format.js';

const seed = JSON.parse(readFileSync(new URL('../data/recipes-data.reviewed.json', import.meta.url), 'utf8'));
const fresh = () => structuredClone(seed);
const recipe = (src, id) => src.recipes.find((r) => r.id === id);
const others = (s, id) => JSON.stringify({ ...s, recipes: s.recipes.filter((r) => r.id !== id) });
const PORK = 'spicy-pork-fillet-on-kumara-mash';   // lines under "Marinade" and "Mash"

describe('section headings and line order', () => {
  it('a recipe with sections opens with its headings, and saves back byte-identical', () => {
    const src = fresh();
    const draft = recipeToDraft(src, PORK);
    expect(draft.rows.filter(isHeading).map((h) => h.heading)).toEqual(['Marinade', 'Mash']);
    expect(JSON.stringify(applyDraft(src, draft).source)).toBe(JSON.stringify(seed));
  });

  it('renaming a heading renames the section of every line under it, and nothing else', () => {
    const src = fresh();
    const draft = recipeToDraft(src, PORK);
    draft.rows.find((r) => isHeading(r) && r.heading === 'Mash').heading = 'Kumara mash';
    const { source: next } = applyDraft(src, draft);
    const before = recipe(src, PORK).ingredients;
    const after = recipe(next, PORK).ingredients;
    after.forEach((l, i) => {
      expect(l.section).toBe(before[i].section === 'Mash' ? 'Kumara mash' : before[i].section);
      expect({ ...l, section: null }).toEqual({ ...before[i], section: null });
    });
    expect(others(next, PORK)).toBe(others(src, PORK));
  });

  it('moving a line past a heading moves it into that section, unchanged otherwise', () => {
    const src = fresh();
    const draft = recipeToDraft(src, PORK);
    const i = draft.rows.findIndex((r) => r.name === 'Sherry');       // last Marinade line
    moveItem(draft, i, +1);                                            // past the "Mash" heading
    const { source: next } = applyDraft(src, draft);
    const sherry = recipe(next, PORK).ingredients.find((l) => l.ingredientName === 'Sherry');
    const was = recipe(src, PORK).ingredients.find((l) => l.ingredientName === 'Sherry');
    expect(sherry).toEqual({ ...was, section: 'Mash' });
  });

  it('a new heading takes the lines below it; deleting it returns them to the one above', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    const at = draft.rows.findIndex((r) => r.name === 'Cheese: Parmesan');
    draft.rows.splice(at, 0, { heading: 'To finish' });
    const { source: next } = applyDraft(src, draft);
    const lines = recipe(next, 'mushroom-risotto').ingredients;
    expect(lines.slice(0, 7).every((l) => !l.section)).toBe(true);
    expect(lines.slice(7).every((l) => l.section === 'To finish')).toBe(true);

    const d2 = recipeToDraft(next, 'mushroom-risotto');
    d2.rows.splice(d2.rows.findIndex(isHeading), 1);
    expect(JSON.stringify(applyDraft(next, d2).source)).toBe(JSON.stringify(seed));
  });
});

describe('recipe flags and link', () => {
  it('ticking slow cooker sets the flag and nothing else', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.slowCooker = true;
    const { source: next } = applyDraft(src, draft);
    expect(recipe(next, 'mushroom-risotto')).toEqual({ ...recipe(src, 'mushroom-risotto'), slowCooker: true });
  });

  it('a source website is stored as sourceUrl, and clearing it removes the key', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.sourceUrl = 'https://example.com/risotto';
    const { source: next } = applyDraft(src, draft);
    expect(recipe(next, 'mushroom-risotto').sourceUrl).toBe('https://example.com/risotto');
    const d2 = recipeToDraft(next, 'mushroom-risotto');
    d2.sourceUrl = '';
    expect(JSON.stringify(applyDraft(next, d2).source)).toBe(JSON.stringify(seed));
  });

  it('refuses a link that is not a web address', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.sourceUrl = 'example.com';
    expect(applyDraft(src, draft).error).toMatch(/http/);
  });

  it('a flag changed elsewhere is a conflict, like any other edit to the recipe', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.notes = 'mine';
    const theirs = fresh();
    recipe(theirs, 'mushroom-risotto').slowCooker = true;
    expect(applyDraft(theirs, draft)).toEqual({ conflict: true });
  });
});

describe('a new ingredient, placed on the list from the editor', () => {
  it('takes the category, aisle and unit chosen for it', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.rows.push({ ...blankRow(), name: 'Porcini', qty: '1', unit: 'cup',
      newCategory: 'Fruit and Vegetables', newAisle: 'Vegetables', newUnit: 'g' });
    expect(unitChoices(src, 'Porcini', draft.rows.at(-1))).toEqual({ kind: 'choose', options: ['g', 'cup', 'TBsp', 'tsp'] });
    const { source: next } = applyDraft(src, draft);
    expect(next.ingredients.at(-1)).toMatchObject({ name: 'Porcini', shoppingUnit: 'g', aisle: 'Vegetables', shoppingCategory: 'Fruit and Vegetables' });
    expect(recipe(next, 'mushroom-risotto').ingredients.at(-1))
      .toMatchObject({ ingredientName: 'Porcini', quantity: 250, unit: 'g', displayQty: '1', displayUnit: 'cup' });
    expect(needsAttention(next.ingredients.at(-1))).toEqual([]);
  });

  it('counted, and with nothing chosen it is uncategorised and needs attention', () => {
    const src = fresh();
    const draft = recipeToDraft(src, 'mushroom-risotto');
    draft.rows.push({ ...blankRow(), name: 'Shallots', qty: '3', unit: '', newUnit: 'qty' });
    draft.rows.push({ ...blankRow(), name: 'Mystery', qty: '1', unit: '' });
    const { source: next } = applyDraft(src, draft);
    const [shallots, mystery] = next.ingredients.slice(-2);
    expect(shallots).toMatchObject({ shoppingUnit: 'qty', aisle: 'Uncategorised', shoppingCategory: 'Other' });
    expect(needsAttention(shallots)).toEqual(['category', 'aisle']);
    expect(needsAttention(mystery)).toEqual(['category', 'aisle', 'unit']);
  });
});

describe('deleting a recipe', () => {
  it('removes that recipe only', () => {
    const src = fresh();
    const { source: next } = deleteRecipe(src, 'mushroom-risotto');
    expect(recipe(next, 'mushroom-risotto')).toBeUndefined();
    expect(next.recipes).toHaveLength(src.recipes.length - 1);
    expect(JSON.stringify(next.ingredients)).toBe(JSON.stringify(src.ingredients));
    expect(deleteRecipe(next, 'mushroom-risotto').error).toMatch(/already/);
  });
});

describe('the ingredient list', () => {
  it('sets category, aisle and unit on one ingredient, found ignoring case', () => {
    const src = fresh();
    const { source: next } = setIngredient(src, 'thyme', { shoppingCategory: 'Pantry', aisle: 'Spices', shoppingUnit: 'g' });
    const i = src.ingredients.findIndex((x) => x.name === 'Thyme');
    expect(next.ingredients[i]).toEqual({ ...src.ingredients[i], shoppingCategory: 'Pantry', aisle: 'Spices', shoppingUnit: 'g' });
    expect(JSON.stringify({ ...next, ingredients: [] })).toBe(JSON.stringify({ ...src, ingredients: [] }));
  });
});

describe('staples', () => {
  it('reads the staples with their amounts in the shopping unit', () => {
    const milk = staplesOf(fresh()).find((s) => s.name === 'Milk');
    expect(milk).toMatchObject({ qty: 6000, unit: 'mL', known: true });
  });

  it('adds a staple in the earlier app\'s shape: a name in the list, an amount in the map', () => {
    const src = fresh();
    const { source: next } = setStaple(src, 'butter', '500 g');
    expect(next.settings.staples.at(-1)).toBe('Butter');
    expect(next.settings.stapleQty.Butter).toBe(500);
    expect(typeof next.settings.staples.at(-1)).toBe('string');
  });

  it('converts litres, changes an amount in place, and removes cleanly', () => {
    const src = fresh();
    let { source: next } = setStaple(src, 'Milk', '2 L');
    expect(next.settings.stapleQty.Milk).toBe(2000);
    expect(next.settings.staples.filter((s) => s === 'Milk')).toHaveLength(1);
    ({ source: next } = removeStaple(next, 'milk'));
    expect(next.settings.staples).not.toContain('Milk');
    expect('Milk' in next.settings.stapleQty).toBe(false);
  });

  it('refuses a staple the ingredient list does not know, or an amount in the wrong unit', () => {
    expect(setStaple(fresh(), 'Unicorn', '1').error).toMatch(/ingredient list/);
    expect(setStaple(fresh(), 'Milk', '2 kg').error).toMatch(/isn't an amount/);
  });

  it('go on the list only while the household has staples switched on', () => {
    const on = importLibrary(fresh()).library.ingredients.filter((i) => i.isStaple);
    expect(on.length).toBeGreaterThan(0);
    const { source: off } = setFeature(fresh(), 'staples', false);
    expect(importLibrary(off).library.ingredients.filter((i) => i.isStaple)).toHaveLength(0);
  });
});

describe('pantry items start as "at home"', () => {
  it('marks Pantry ingredients while the switch is on, and none when off', () => {
    const src = fresh();
    expect(featureOn(src, 'pantryAtHome')).toBe(true);
    const lib = importLibrary(src).library.ingredients;
    expect(lib.filter((i) => i.startsAtHome).every((i) => i.category === 'Pantry')).toBe(true);
    expect(lib.some((i) => i.startsAtHome)).toBe(true);
    const { source: off } = setFeature(src, 'pantryAtHome', false);
    expect(importLibrary(off).library.ingredients.some((i) => i.startsAtHome)).toBe(false);
    // The switch keeps the earlier app's other switches as they were.
    expect(off.settings.features).toEqual({ ...src.settings.features, pantryAtHome: false });
  });
});

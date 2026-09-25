// Importing a recipe from a website, and copying one out as text.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseImportPaste, parseIngredientText, suggestIngredients, draftFromImport } from '../src/core/web-import.js';
import { applyDraft } from '../src/core/recipes-format.js';
import { recipeToText, recipeToHtml } from '../src/core/recipe-text.js';

const seed = JSON.parse(readFileSync(new URL('../data/recipes-data.reviewed.json', import.meta.url), 'utf8'));

describe('reading what was pasted', () => {
  it('takes the Grab Recipe bookmark\'s JSON as it is', () => {
    const p = parseImportPaste(JSON.stringify({ fridgeListImport: 1, name: 'Chilli', servings: '6', url: 'https://x.test/c',
      ingredients: ['500g beef mince'], method: ['Cook it.'] }));
    expect(p).toEqual({ name: 'Chilli', servings: '6', url: 'https://x.test/c', ingredients: ['500g beef mince'], method: ['Cook it.'] });
  });

  it('finds the ingredients and method in a copied page, and stops at the comments', () => {
    const page = ['Best Pancakes', 'Serves 4', 'Ingredients', '1 cup flour', '1 egg', 'Method', 'Mix everything together.',
      'Cook in a hot pan.', 'Comments', 'Lovely!'].join('\n');
    const p = parseImportPaste(page);
    expect(p).toMatchObject({ name: 'Best Pancakes', servings: '4', ingredients: ['1 cup flour', '1 egg'],
      method: ['Mix everything together.', 'Cook in a hot pan.'], weak: false });
  });

  it('says when it could not find either heading', () => {
    expect(parseImportPaste('just some words\nnothing useful').weak).toBe(true);
    expect(parseImportPaste('   ')).toBeNull();
  });
});

describe('reading an ingredient line', () => {
  it.each([
    ['2 ½ cups plain flour, sifted', { qty: '2 ½', unit: 'cup' }],
    ['½ tsp salt', { qty: '½', unit: 'tsp' }],
    ['1 1/2 tbsp soy sauce', { qty: '1 ½', unit: 'TBsp' }],
    ['400g tin crushed tomatoes', { qty: '400', unit: 'g' }],
    ['1kg chicken thighs', { qty: '1000', unit: 'g' }],
    ['1.5 L stock', { qty: '1500', unit: 'mL' }],
    ['2-3 cloves garlic', { qty: '2', unit: '' }],
    ['Salt and pepper', { qty: '', unit: '' }],
  ])('%s', (line, want) => {
    expect(parseIngredientText(line)).toMatchObject(want);
  });
});

describe('matching the ingredient list', () => {
  it('offers the likeliest ingredients first', () => {
    expect(suggestIngredients(seed, '2 cups plain flour')[0]).toBe('Flour (Plain)');
    expect(suggestIngredients(seed, '500g beef mince')[0]).toBe('Mince: beef');
    expect(suggestIngredients(seed, '2 tbsp olive oil')[0]).toBe('Oil: olive');
  });

  it('opens as a new recipe in the editor and saves in the file\'s own format', () => {
    const draft = draftFromImport(seed, { name: 'Pancakes', servings: '4 servings', url: 'https://x.test/p',
      ingredients: ['1 cup plain flour', '2 eggs'], method: ['Mix.', 'Cook.'] });
    expect(draft.rows.map((r) => r.web)).toEqual(['1 cup plain flour', '2 eggs']);
    draft.rows[0].name = draft.rows[0].suggestions[0];
    draft.rows[1].name = 'Eggs (whole)';
    const { source, recipeId } = applyDraft(seed, draft);
    const r = source.recipes.find((x) => x.id === recipeId);
    expect(r).toMatchObject({ name: 'Pancakes', servings: 4, sourceUrl: 'https://x.test/p', source: 'web', method: ['Mix.', 'Cook.'] });
    expect(r.ingredients[0]).toMatchObject({ ingredientName: 'Flour (Plain)', displayQty: '1', displayUnit: 'cup' });
  });
});

describe('copying a recipe out', () => {
  const pork = seed.recipes.find((r) => r.id === 'spicy-pork-fillet-on-kumara-mash');

  it('as text: headings, lines as the cook measures them, numbered method', () => {
    const t = recipeToText(seed, pork);
    expect(t.split('\n')[0]).toBe(pork.name);
    expect(t).toContain('INGREDIENTS');
    expect(t).toContain('Marinade');
    expect(t).toMatch(/\n1\. /);
  });

  it('as HTML, with the text escaped', () => {
    const html = recipeToHtml(seed, { ...pork, name: 'Fish & <chips>' });
    expect(html).toContain('<h2>Fish &amp; &lt;chips&gt;</h2>');
    expect(html).toContain('<ul>');
  });
});

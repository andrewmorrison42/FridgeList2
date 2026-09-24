// The migration, checked against its own source. Glitch #1.
//
// The household's data is the oracle: the old app bought by these quantities
// for years ("the recipes worked"). Every test before this one built its
// library by hand with the right semantics, so none of them noticed that the
// import stored each quantity *already converted* to shopping units, labelled
// it with the cooking unit, and let the app convert it a second time — 4x for
// a teaspoon, 250x for a cup. Marmalade 62,500 g on the fridge-door printout.
//
// So: every imported line, at its recipe's own servings, must produce exactly
// the shopping quantity the source file says. 5,561 checks, no hand-built data.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { importLibrary } from '../tools/import.js';
import { toShoppingUnit, scaleForServings } from '../src/core/units.js';

const source = JSON.parse(readFileSync('data/recipes-data.reviewed.json', 'utf8'));
const { library } = importLibrary(source);
const ingredients = new Map(library.ingredients.map((i) => [i.id, i]));
const byName = new Map(library.ingredients.map((i) => [i.name, i]));

describe('migration against its source (glitch #1)', () => {
  it('P12 — every recipe line yields the shopping quantity the source says', () => {
    const parse = (q) => (typeof q === 'number' ? q : Number(q));
    const wrong = [];
    let checked = 0;
    for (const raw of source.recipes) {
      const imported = library.recipes.find((r) => r.id === raw.id);
      // The import keeps every line, in order — so lines pair by position.
      expect(imported.lines.length).toBe((raw.ingredients ?? []).length);
      raw.ingredients.forEach((src, i) => {
        const line = imported.lines[i];
        const want = parse(src.quantity);
        if (line.garnish || !Number.isFinite(want)) return;   // "to serve"; fraction strings parse-tested
        const ing = ingredients.get(line.ingredientId);
        const got = toShoppingUnit(scaleForServings(line.quantity, imported.servings, imported.servings), line.cookingUnit, ing);
        checked += 1;
        if (Math.abs(got - want) > 1e-9 * Math.max(1, want)) {
          wrong.push(`${raw.id}: ${ing.name} — source ${want} ${ing.shoppingUnit}, app ${got}`);
        }
      });
    }
    expect(checked).toBeGreaterThan(5000);
    expect({ wrong: wrong.length, examples: wrong.slice(0, 4) }).toEqual({ wrong: 0, examples: [] });
  });

  it('the shipped data/library.json is exactly what the importer produces', () => {
    // So the file the app loads cannot drift from the code that makes it.
    const shipped = JSON.parse(readFileSync('data/library.json', 'utf8'));
    expect(shipped.recipes).toEqual(library.recipes);
    expect(shipped.ingredients).toEqual(library.ingredients);
  });
});

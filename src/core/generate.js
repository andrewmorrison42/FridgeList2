// Shopping list generation. FR-LIST-1, FR-LIST-2, FR-MENU-7, §10.
//
// A pure function of (menu selections, staples, Wait List, ingredient master)
// producing a proposed set of lines. What may be *done* with the proposal
// depends on the shop's phase — see §5.7 — but generating it never touches
// anything: this module returns a value and changes nothing.

import { toShoppingUnit, scaleForServings } from './units.js';
import { selections, PLANNED, CARRIED, FLAGGED } from './carryover.js';

/**
 * @param {object} library  { recipes: Map, ingredients: Map }
 * @param {object} plan     { events, shopId, waitList, dismissed }
 * @returns {{ lines: Array, carryOver: Array, problems: Array }}
 */
export function generate(library, { events, shopId, waitList = [], dismissed = new Set() }) {
  const { recipes, ingredients } = library;
  const sels = [...selections(events).values()];
  const problems = [];

  // Quantities are accumulated here and derived on read — never stored as a
  // field. Two people generating concurrently would otherwise each write a
  // total, and the merge would keep one of them, possibly the smaller: you
  // would buy too few onions and nothing would say so. §5.5.
  const main = new Map();
  const carriedOnly = new Map();

  const add = (bucket, ingredientId, qty, source) => {
    const ing = ingredients.get(ingredientId);
    if (!ing) { problems.push({ kind: 'unknown-ingredient', ingredientId, source }); return; }
    if (!bucket.has(ingredientId)) {
      bucket.set(ingredientId, {
        shopId, ingredientId, name: ing.name, unit: ing.shoppingUnit,
        category: ing.category, aisle: ing.aisle, preference: ing.preference ?? null,
        qty: 0, sources: [],
      });
    }
    const line = bucket.get(ingredientId);
    line.qty += qty;
    line.sources.push(source);
  };

  const linesOf = (sel) => {
    const recipe = recipes.get(sel.recipeId);
    if (!recipe) { problems.push({ kind: 'unknown-recipe', recipeId: sel.recipeId }); return []; }
    return recipe.lines.map((l) => {
      const ing = ingredients.get(l.ingredientId);
      if (!ing) { problems.push({ kind: 'unknown-ingredient', ingredientId: l.ingredientId }); return null; }
      const scaled = scaleForServings(l.quantity, sel.servings || recipe.servings, recipe.servings);
      return { ingredientId: l.ingredientId, qty: toShoppingUnit(scaled, l.cookingUnit, ing) };
    }).filter(Boolean);
  };

  // 1–2. Planned selections, scaled and converted.
  for (const sel of sels.filter((s) => s.status === PLANNED)) {
    for (const l of linesOf(sel)) {
      add(main, l.ingredientId, l.qty, { kind: 'recipe', recipeId: sel.recipeId });
    }
  }

  // 3. Staples — automatic, never individually selected. FR-STA-1.
  for (const ing of ingredients.values()) {
    if (ing.isStaple) add(main, ing.id, ing.stapleQty ?? 1, { kind: 'staple' });
  }

  // 4. Open Wait List items.
  for (const item of waitList) {
    add(main, item.ingredientId, item.qty ?? 1, { kind: 'waitlist', itemId: item.id, note: item.note });
  }

  // 6. Carried-over entries do not fold into the ordinary lines. FR-MENU-7.1.
  //    An ingredient already on the main list via a planned selection, a staple
  //    or the Wait List is being bought regardless, so there is nothing to
  //    check and it does not appear here (FR-MENU-7.3).
  for (const sel of sels.filter((s) => s.status === CARRIED || s.status === FLAGGED)) {
    for (const l of linesOf(sel)) {
      if (main.has(l.ingredientId)) continue;
      if (dismissed.has(l.ingredientId)) continue;   // dismissed for this shop only
      add(carriedOnly, l.ingredientId, l.qty, { kind: 'carried', recipeId: sel.recipeId });
    }
  }

  return {
    lines: [...main.values()],
    carryOver: [...carriedOnly.values()],
    problems,
  };
}

/**
 * Group for display: category as header, aisle as subheading. FR-LIST-6, §10.1.
 *
 * Never alphabetical, never insertion order. Category alone would put 62% of
 * the household's ingredients into "Pantry", which makes "you take Pantry, I'll
 * take the rest" a useless split; the aisles inside it are what make it
 * divisible.
 */
export function groupForDisplay(lines, { categoryOrder = [], aisleOrder = [] } = {}) {
  const rank = (list, v) => { const i = list.indexOf(v); return i === -1 ? list.length : i; };
  const byCategory = new Map();
  for (const line of lines) {
    if (!byCategory.has(line.category)) byCategory.set(line.category, new Map());
    const aisles = byCategory.get(line.category);
    if (!aisles.has(line.aisle)) aisles.set(line.aisle, []);
    aisles.get(line.aisle).push(line);
  }
  return [...byCategory.entries()]
    .sort((a, b) => rank(categoryOrder, a[0]) - rank(categoryOrder, b[0]) || a[0].localeCompare(b[0]))
    .map(([category, aisles]) => ({
      category,
      aisles: [...aisles.entries()]
        .sort((a, b) => rank(aisleOrder, a[0]) - rank(aisleOrder, b[0]) || a[0].localeCompare(b[0]))
        .map(([aisle, items]) => ({
          aisle,
          lines: items.sort((x, y) => x.name.localeCompare(y.name)),
        })),
    }));
}

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
 * @param {object} plan     { events, shopId, waitList, dismissed, added }
 *   `added`: ingredients someone has said are needed on this shop — "Need it"
 *   on an at-home line, "Still need it" on a carried-over one.
 * @returns {{ lines: Array, atHome: Array, carryOver: Array, problems: Array }}
 */
export function generate(library, { events, shopId, waitList = [], dismissed = new Set(), added = new Set() }) {
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
    // A Wait List item typed in rather than picked from the ingredient list has
    // no aisle to go in; it gets a line of its own under "Wait list".
    const ing = ingredients.get(ingredientId) ?? (source.text
      ? { name: source.text, shoppingUnit: 'qty', category: 'Other', aisle: 'Wait list' } : null);
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
      // "Serve with lettuce" — a garnish with no amount. It belongs in the
      // recipe, but a zero-quantity shopping line means nothing to anyone
      // standing in a shop, so it never reaches the list (A6).
      if (l.garnish || l.quantity === 0) return null;
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
    const id = item.ingredientId ?? freeTextId(item.text);
    add(main, id, item.qty ?? 1, { kind: 'waitlist', itemId: item.id, note: item.note, text: item.ingredientId ? null : item.text });
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

  // "Still need it" on a carried-over line puts it on the list proper.
  for (const [id, line] of carriedOnly) {
    if (!added.has(id)) continue;
    carriedOnly.delete(id);
    main.set(id, line);
  }

  // Ingredients the household usually has in — Pantry items, when that option
  // is on — start in "at home already" rather than on the buy list, with one
  // tap to need them. Only when every reason for the line is a recipe: a Wait
  // List item or a staple is there because someone asked for it to be bought.
  const atHome = [];
  for (const [id, line] of main) {
    if (!ingredients.get(id)?.startsAtHome || added.has(id)) continue;
    if (line.sources.some((src) => src.kind !== 'recipe')) continue;
    main.delete(id);
    atHome.push(line);
  }

  return {
    lines: [...main.values()],
    atHome,
    carryOver: [...carriedOnly.values()],
    problems,
  };
}

/** The line id for a Wait List item typed in by hand: one line per wording. */
export const freeTextId = (text) =>
  `x-${String(text ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'item'}`;

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

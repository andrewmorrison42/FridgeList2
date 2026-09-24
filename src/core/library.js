// The recipe and ingredient library, derived from events. §9.
//
// Recipes are edited rarely, by whoever is cooking, so these are last-save-wins
// registers rather than causally merged ones (§5.5). The library is large — 638
// recipes and 452 ingredients for this household — which is why it lives in its
// own files and is fetched conditionally rather than polled (§7.2).

import { stateOf } from './merge.js';
import { K, parseKey } from './keys.js';
import { parseAmount } from './units.js';

/** @returns {{ recipes: Map, ingredients: Map }} */
export function library(events) {
  const state = stateOf(events);
  const recipes = new Map();
  const ingredients = new Map();

  for (const [key, reg] of state) {
    if (reg.value === undefined || reg.value === null) continue;
    const k = parseKey(key);
    if (k?.kind === 'recipe') recipes.set(k.recipeId, reg.value);
    else if (k?.kind === 'ingredient') ingredients.set(k.ingredientId, reg.value);
  }
  return { recipes, ingredients };
}

/** Staples are a property of the ingredient, never conflated with the rest. FR-STA-2. */
export const staples = (ingredients) => [...ingredients.values()].filter((i) => i.isStaple);

/**
 * How long since this recipe was last chosen, derived from trip history —
 * which is the set of `shop.closed` events, plus the history carried over by
 * the migration (§12). Not a separate store. FR-REC-3, FR-HIST-2, §15.3.
 *
 * The imported history was written to library.json from the start and never
 * read, so every recipe showed "never" in the picker — the signal URS §9 asks
 * to carry forward. Found in review v0.5.
 */
export function cookHistory(events) {
  const state = stateOf(events);
  const last = new Map();
  const note = (recipeId, at) => {
    if (at && (!last.has(recipeId) || last.get(recipeId) < at)) last.set(recipeId, at);
  };
  for (const trip of state.get(K.historyImported())?.value ?? []) {
    for (const recipeId of trip.selections ?? []) note(recipeId, trip.closedAt);
  }
  for (const [key, reg] of state) {
    if (parseKey(key)?.kind !== 'shopClosed' || reg.value !== true) continue;
    for (const e of reg.by) {
      for (const recipeId of e.payload.selections ?? []) note(recipeId, e.payload.closedAt ?? e.ts);
    }
  }
  return last;
}

/** "3 weeks ago" — shown in the picker, not only in a history view. FR-REC-4. */
export function sinceLabel(iso, now = Date.now()) {
  if (!iso) return 'never';
  const days = Math.floor((now - Date.parse(iso)) / 86400000);
  if (days < 1) return 'today';
  if (days < 14) return `${days}d ago`;
  if (days < 70) return `${Math.round(days / 7)}w ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/**
 * The units a line can be written in: what the ingredient is bought in, and
 * every unit it has a conversion for. Nothing else is offered, so a recipe line
 * that cannot reach the shopping list cannot be entered. FR-ING-1, FR-REC-2.
 */
export const unitsFor = (ing) => [ing.shoppingUnit, ...Object.keys(ing.conversions ?? {})];

/**
 * The editing form's view of a recipe (or of a blank one). Each line shows the
 * way the recipe reads — "6 cup", not "1500 mL" — and remembers the line it
 * came from, so a line nobody touched is saved back exactly as it was.
 */
export function draftFromRecipe(recipe, ingredients) {
  const lines = (recipe?.lines ?? []).map((l) => {
    const ing = ingredients.get(l.ingredientId);
    const garnish = l.garnish || l.quantity === 0;
    return {
      ingredientId: l.ingredientId,
      qtyText: garnish ? '' : String(l.displayQty ?? (l.cookingUnit ? l.quantity : roundAmount(l.quantity))),
      unit: l.displayUnit ?? l.cookingUnit ?? ing?.shoppingUnit ?? 'qty',
      original: l,
      dirty: false,
    };
  });
  return {
    source: recipe ?? null,
    name: recipe?.name ?? '',
    servings: recipe?.servings == null ? '' : String(recipe.servings),
    method: methodText(recipe?.method),
    lines,
  };
}

/**
 * The recipe a draft describes, or the reasons it cannot be saved. Refuses
 * rather than guesses (P-II): a line that cannot be converted to what is bought
 * would otherwise turn up later as a gap on someone's shopping list.
 * @returns {{ recipe: object|null, errors: string[] }}
 */
export function recipeFromDraft(draft, ingredients, existingIds) {
  const errors = [];
  const name = draft.name.trim();
  if (!name) errors.push('The recipe needs a name.');
  const servingsText = String(draft.servings).trim();
  const servings = /^\d+$/.test(servingsText) ? Number(servingsText) : NaN;
  if (!(servings >= 1)) errors.push('Servings must be a whole number of at least 1.');

  const lines = [];
  for (const d of draft.lines) {
    if (!d.dirty && d.original) { lines.push(d.original); continue; }
    const ing = ingredients.get(d.ingredientId);
    if (!ing) { errors.push(`"${d.ingredientId}" is not in the ingredient list.`); continue; }
    const text = String(d.qtyText ?? '').trim();
    if (!text) { lines.push({ ingredientId: ing.id, quantity: 0, garnish: true }); continue; }
    const quantity = parseAmount(text);
    if (quantity === null || quantity < 0) { errors.push(`"${text}" is not an amount (${ing.name}).`); continue; }
    if (!unitsFor(ing).includes(d.unit)) {
      errors.push(`${ing.name} cannot be measured in ${d.unit} — it has no conversion to ${ing.shoppingUnit}.`);
      continue;
    }
    lines.push(d.unit === ing.shoppingUnit
      ? { ingredientId: ing.id, quantity, cookingUnit: null }
      : { ingredientId: ing.id, quantity, cookingUnit: d.unit, displayQty: text, displayUnit: d.unit });
  }
  if (errors.length) return { recipe: null, errors };

  const src = draft.source;
  const method = src && draft.method === methodText(src.method)
    ? src.method
    : draft.method.split('\n').map((s) => s.trim()).filter(Boolean);
  const recipe = {
    ...(src ?? {}),
    id: src?.id ?? freshId(name, existingIds),
    name: src && name === src.name.trim() ? src.name : name,
    servings,
    lines,
    method,
  };
  return { recipe, errors };
}

const methodText = (m) => (Array.isArray(m) ? m.join('\n') : (m ?? ''));
const roundAmount = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(2)));

function freshId(name, existingIds) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'recipe';
  let id = base;
  for (let n = 2; existingIds.has(id); n++) id = `${base}-${n}`;
  return id;
}

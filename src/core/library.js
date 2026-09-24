// The recipe and ingredient library, derived from events. §9.
//
// Recipes are edited rarely, by whoever is cooking, so these are last-save-wins
// registers rather than causally merged ones (§5.5). The library is large — 638
// recipes and 452 ingredients for this household — which is why it lives in its
// own files and is fetched conditionally rather than polled (§7.2).

import { stateOf } from './merge.js';
import { K, parseKey } from './keys.js';

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

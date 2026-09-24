// Shopping list derivation. FR-LIST-1, FR-LIST-2, FR-SHOP-1, FR-MENU-7, §5.7, §10.
//
// This is the one place the list is derived. Every other module — the app, the
// views, the close report, the print sheet — reads what this returns and
// derives nothing of its own. Review #2 found suppression applied in one view
// and forgotten everywhere else, mid-shop additions derived nowhere at all, and
// a list that a mid-shop recipe edit could shrink; all three came from the list
// being assembled in more than one place.
//
// Pure: a value in, a value out, nothing written.

import { toShoppingUnit, scaleForServings } from './units.js';
import { selections, PLANNED, CARRIED, FLAGGED } from './carryover.js';
import { stateOf } from './merge.js';
import { shopPhases } from './shop.js';
import { library as libraryOf } from './library.js';
import { K, parseKey } from './keys.js';

/** The open Wait List: present items, oldest first. FR-WAIT-1/2. */
export function openWaitList(events) {
  const state = stateOf(events);
  const out = [];
  for (const [key, reg] of state) {
    const k = parseKey(key);
    if (k?.kind !== 'waitlistPresent' || reg.value !== true) continue;
    const p = reg.by[0]?.payload ?? {};
    out.push({ id: k.itemId, ingredientId: p.ingredientId, note: p.note ?? null, qty: p.qty ?? null });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Per-shop line modifiers: pantry-check suppressions, dismissals, additions. */
function shopFlags(state, shopId) {
  const suppressed = new Set();
  const dismissed = new Set();
  const added = new Set();
  for (const [key, reg] of state) {
    if (reg.value !== true) continue;
    const k = parseKey(key);
    if (!k || k.shopId !== shopId) continue;
    if (k.kind === 'lineSuppressed') suppressed.add(k.ingredientId);
    else if (k.kind === 'linePresent') added.add(k.ingredientId);
    else if (k.kind === 'carryoverDismissed') dismissed.add(k.ingredientId);
  }
  return { suppressed, dismissed, added };
}

/**
 * What the shop was locked with. Concurrent locks are all kept (true-wins,
 * §5.4) and their lists are *unioned* — two people pressing "Menu is settled"
 * at once with different views of the menu must never have one list replace
 * the other. Where both hold a line, the larger quantity stands.
 */
function lockedSnapshot(state, shopId) {
  const reg = state.get(K.shopLocked(shopId));
  const lines = new Map();
  const planned = new Set();
  const waitItems = new Set();
  if (!reg || reg.value !== true) return { lines, planned, waitItems };
  for (const e of reg.by) {
    for (const r of e.payload.selections ?? []) planned.add(r);
    for (const l of e.payload.lines ?? []) {
      const have = lines.get(l.ingredientId);
      const sources = [...(have?.sources ?? []), ...(l.sources ?? [])];
      const qty = have ? maxQty(have.qty, l.qty) : l.qty;
      lines.set(l.ingredientId, { ...(have ?? l), qty, sources: dedupe(sources) });
      for (const src of l.sources ?? []) if (src.kind === 'waitlist') waitItems.add(src.itemId);
    }
  }
  return { lines, planned, waitItems };
}

const maxQty = (a, b) => (a === null || a === undefined ? b : b === null || b === undefined ? a : Math.max(a, b));
const dedupe = (sources) => [...new Map(sources.map((s) => [JSON.stringify(s), s])).values()];

/**
 * @param {{ events?: Array, state?: Map, shopId: string }} args
 * @returns {{ phase, lines: Array, carryOver: Array, problems: Array }}
 */
export function generate({ events, state, shopId }) {
  state = state ?? stateOf(events);
  const { recipes, ingredients } = libraryOf(state);
  const phase = shopPhases(state).get(shopId) ?? 'draft';
  const flags = shopFlags(state, shopId);
  const waitList = openWaitList(state);
  const sels = [...selections(state, shopId).values()];
  const problems = [];

  const main = new Map();
  const carried = new Map();

  // Quantities are accumulated here and derived on read — never stored as a
  // field. Two people generating concurrently would otherwise each write a
  // total and the merge would keep one, possibly the smaller: too few onions,
  // and nothing would say so. §5.5.
  const add = (bucket, ingredientId, qty, source, { afterLock = false } = {}) => {
    const ing = ingredients.get(ingredientId);
    let line = bucket.get(ingredientId);
    if (!line) {
      if (!ing) { problems.push({ kind: 'unknown-ingredient', ingredientId, source }); return; }
      line = {
        shopId, ingredientId, name: ing.name, unit: ing.shoppingUnit,
        category: ing.category, aisle: ing.aisle, preference: ing.preference ?? null,
        qty: null, sources: [],
      };
      bucket.set(ingredientId, line);
    }
    if (qty !== null && qty !== undefined) line.qty = (line.qty ?? 0) + qty;
    line.sources.push(source);
    if (afterLock) line.addedAfterLock = true;
  };

  // One error-handling posture for the whole derivation: anything wrong with
  // the data is reported in `problems` and the rest of the list still renders.
  // units.js throws, which is right for a primitive asked to convert without a
  // conversion — but that throw must stop here. Before review #5 one recipe
  // saying "tbsp" where the data says "TBsp" took down the entire list screen,
  // while an unknown ingredient beside it was politely reported.
  const linesOf = (sel) => {
    const recipe = recipes.get(sel.recipeId);
    if (!recipe) { problems.push({ kind: 'unknown-recipe', recipeId: sel.recipeId }); return []; }
    if (!recipe.servings) { problems.push({ kind: 'no-servings', recipeId: sel.recipeId }); return []; }
    return recipe.lines.map((l) => {
      // "Serve with lettuce" — a garnish with no amount. It belongs in the
      // recipe, but a zero-quantity shopping line means nothing (A6).
      if (l.garnish || l.quantity === 0) return null;
      const ing = ingredients.get(l.ingredientId);
      if (!ing) { problems.push({ kind: 'unknown-ingredient', ingredientId: l.ingredientId, recipeId: sel.recipeId }); return null; }
      try {
        const scaled = scaleForServings(l.quantity, sel.servings || recipe.servings, recipe.servings);
        return { ingredientId: l.ingredientId, qty: toShoppingUnit(scaled, l.cookingUnit, ing) };
      } catch (err) {
        problems.push({
          kind: 'missing-conversion', recipeId: sel.recipeId, ingredientId: l.ingredientId,
          unit: l.cookingUnit, name: ing.name, message: err.message,
        });
        return null;
      }
    }).filter(Boolean);
  };

  if (phase === 'draft') {
    // The proposal: planned selections, staples, the Wait List. §10.
    for (const sel of sels.filter((s) => s.status === PLANNED)) {
      for (const l of linesOf(sel)) add(main, l.ingredientId, l.qty, { kind: 'recipe', recipeId: sel.recipeId });
    }
    for (const ing of ingredients.values()) {
      if (ing.isStaple) add(main, ing.id, ing.stapleQty ?? null, { kind: 'staple' });   // FR-STA-1
    }
    for (const item of waitList) {
      add(main, item.ingredientId, item.qty, { kind: 'waitlist', itemId: item.id, note: item.note });
    }
    // The pantry check (FR-LIST-3). Applied before additions: an explicit
    // addition is protected by FR-SYNC-1 and must never be hidden by it.
    for (const id of flags.suppressed) main.delete(id);
  } else {
    // Open (or closed): the list is what was locked, plus everything added
    // since. Nothing here can take a line away, so a line — and its tick —
    // cannot vanish from a phone during a shop. §5.7, §6, §5.9.
    const snap = lockedSnapshot(state, shopId);
    for (const [id, line] of snap.lines) main.set(id, { ...line, shopId, sources: [...line.sources] });

    // A menu addition in flight as the lock landed: kept, and its ingredients
    // join the list as additions (§8.1). Marked, because a line already ticked
    // whose quantity has since risen would otherwise be silently short.
    for (const sel of sels.filter((s) => s.status === PLANNED && !snap.planned.has(s.recipeId))) {
      for (const l of linesOf(sel)) {
        add(main, l.ingredientId, l.qty, { kind: 'recipe', recipeId: sel.recipeId }, { afterLock: true });
      }
    }
    for (const item of waitList) {
      if (snap.waitItems.has(item.id)) continue;
      add(main, item.ingredientId, item.qty, { kind: 'waitlist', itemId: item.id, note: item.note }, { afterLock: true });
    }
  }

  // Direct additions — mid-shop (FR-SHOP-1) or "Still need it" from the
  // carry-over section (FR-MENU-7.2). Additions only ever add.
  for (const id of flags.added) {
    if (!main.has(id)) add(main, id, null, { kind: 'manual' }, { afterLock: phase !== 'draft' });
  }

  // Carried over — check before buying. Anything already on the list is being
  // bought regardless, so there is nothing to check (FR-MENU-7.3).
  for (const sel of sels.filter((s) => s.status === CARRIED || s.status === FLAGGED)) {
    for (const l of linesOf(sel)) {
      if (main.has(l.ingredientId) || flags.dismissed.has(l.ingredientId)) continue;
      add(carried, l.ingredientId, l.qty, { kind: 'carried', recipeId: sel.recipeId });
    }
  }

  return { phase, lines: [...main.values()], carryOver: [...carried.values()], problems };
}

/**
 * Group for display: category as header, aisle as subheading. FR-LIST-6, §10.1.
 *
 * Never alphabetical, never insertion order. Category alone would put 62% of
 * the household's ingredients into "Pantry", which makes "you take Pantry, I'll
 * take the rest" a useless split; the aisles inside it make it divisible.
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
        .map(([aisle, items]) => ({ aisle, lines: items.sort((x, y) => x.name.localeCompare(y.name)) })),
    }));
}

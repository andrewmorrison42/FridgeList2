// The recipe and ingredient library. §9, §12.
//
// The library itself is built from the household's recipe file by
// core/recipes-format.js, and held by data/recipes.js — not derived from
// events. What stays here is what is derived from the event log about it:
// staples and cook history.

/** Staples are a property of the ingredient, never conflated with the rest. FR-STA-2. */
export const staples = (ingredients) => [...ingredients.values()].filter((i) => i.isStaple);

/**
 * How long since this recipe was last chosen, derived from trip history —
 * which is the set of `shop.closed` events, not a separate store. FR-REC-3,
 * FR-HIST-2, §15.3.
 */
export function cookHistory(events) {
  const last = new Map();
  for (const e of events) {
    if (e.type !== 'shop.closed') continue;
    for (const recipeId of e.payload.selections ?? []) {
      const at = e.payload.closedAt ?? e.ts;
      if (!last.has(recipeId) || last.get(recipeId) < at) last.set(recipeId, at);
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

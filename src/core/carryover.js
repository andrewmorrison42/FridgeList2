// Menu selection status and carry-over. FR-MENU-3 to FR-MENU-7, §9.1.
//
// A menu item not cooked before the next shop is generated must still appear —
// so it either gets cooked or is deliberately removed. It carries for one
// further week only; after that the household is made to decide.

import { merge } from './merge.js';

export const PLANNED = 'planned';
export const COOKED = 'cooked';
export const CARRIED = 'carried';
export const FLAGGED = 'flagged';

/**
 * Derive every menu selection and its status.
 *
 * Status is derived from set membership — which shops this selection has been
 * carried into — not from a stored counter. Two devices generating in draft
 * both compute the same transition, and asserting the same fact twice is
 * harmless; incrementing twice would send the entry to FLAGGED a week early.
 */
export function selections(events) {
  const state = merge(events);
  const out = new Map();

  for (const [key, reg] of state) {
    const m = /^menu:([^:]+):present$/.exec(key);
    if (!m) continue;
    const [, recipeId] = m;
    if (reg.value !== true) continue;                // removed (FR-MENU-6)
    const source = reg.by[0];
    out.set(recipeId, {
      recipeId,
      servings: source?.payload.servings ?? 0,
      plannedFor: source?.payload.plannedFor ?? null,
      carriedInto: new Set(),
      cooked: false,
    });
  }

  for (const [key, reg] of state) {
    if (reg.value !== true) continue;
    const cooked = /^menu:([^:]+):cooked$/.exec(key);
    if (cooked && out.has(cooked[1])) out.get(cooked[1]).cooked = true;
    const carried = /^menu:([^:]+):carried:(.+)$/.exec(key);
    if (carried && out.has(carried[1])) out.get(carried[1]).carriedInto.add(carried[2]);
  }

  for (const sel of out.values()) sel.status = statusOf(sel);
  return out;
}

/** FR-MENU-2 to FR-MENU-5, in one place. */
export function statusOf(sel) {
  if (sel.cooked) return COOKED;
  switch (sel.carriedInto.size) {
    case 0:  return PLANNED;
    case 1:  return CARRIED;                 // FR-MENU-3
    default: return FLAGGED;                 // FR-MENU-5 — carried at most once
  }
}

/** A Carried entry behaves exactly like a Planned one for cooking and picking. */
export const isActive = (sel) => sel.status === PLANNED || sel.status === CARRIED;

/** FR-MENU-5: a Flagged entry must be explicitly resolved before it is settled. */
export const needsDecision = (sel) => sel.status === FLAGGED;

/**
 * The transitions a new shop's generation causes, as explicit events.
 *
 * Emitted rather than inferred at render time: an inferred status would be
 * recomputed differently on devices holding different subsets of history, and
 * would drift. §9.1.
 */
export function carryOverTransitions(events, newShopId, device) {
  const out = [];
  for (const sel of selections(events).values()) {
    if (sel.cooked) continue;                        // FR-MENU-2 settles it
    if (sel.plannedFor === newShopId) continue;      // planned for this shop
    if (sel.carriedInto.has(newShopId)) continue;    // already recorded
    out.push(device.emit('menu.carried',
      { recipeId: sel.recipeId, shopId: newShopId, carried: true }, 'draft'));
  }
  return out;
}

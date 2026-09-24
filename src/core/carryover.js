// The menu: what is planned for a shop, and what has carried over into it.
// FR-MENU-1 to FR-MENU-7, §9.1.
//
// A menu item not cooked before the next shop must still appear — so it either
// gets cooked or is deliberately removed. It carries for one further week only;
// after that the household is made to decide.
//
// Carry-over is *derived*, not recorded. An earlier version emitted a
// "carried" event when the menu locked, which was after the planning it exists
// to inform: last week's uncooked meal sat on the main list all through the
// pantry check, then moved to "check before buying" once it was too late to
// matter (glitch #3). Derived from the shop chain, there is no moment to get
// wrong and nothing to double-count — how many shops have closed since a meal
// was planned is a fact every device computes the same way (P-I).

import { stateOf, lwwCompare } from './merge.js';
import { parseKey } from './keys.js';

export const PLANNED = 'planned';
export const COOKED = 'cooked';
export const CARRIED = 'carried';
export const FLAGGED = 'flagged';

/** Position in the shop chain; NaN for anything that is not a shop id. */
export function shopIndex(shopId) {
  const m = /^shop-(\d+)$/.exec(shopId ?? '');
  return m ? Number(m[1]) : NaN;
}

/** The selection id: this recipe, planned for this shop. */
export const selectionId = (recipeId, plannedFor) => `${recipeId}@${plannedFor}`;

/**
 * The menu as it stands for `shopId`: every selection on it, with its status.
 *
 * On the menu: anything planned for this shop, and anything planned earlier
 * that has not been cooked. Something cooked in an earlier week has done its
 * job and has left (glitch #10); something cooked this week stays, as cooked,
 * until this shop closes.
 *
 * Status: cooked if cooked; otherwise by how many shops have closed since it
 * was planned — none, planned; one, carried; more, flagged (FR-MENU-3, -5).
 */
export function selections(events, shopId) {
  if (!shopId) throw new Error('selections() needs the shop the menu is for');
  const state = stateOf(events);
  const current = shopIndex(shopId);
  const found = new Map();

  for (const [key, reg] of state) {
    const k = parseKey(key);
    if (k?.kind !== 'menuPresent' || reg.value !== true) continue;   // removed (FR-MENU-6)
    // Servings from the latest save, by the same deterministic order every
    // device uses — not whichever event happened to arrive first.
    const latest = [...reg.by].sort(lwwCompare).at(-1);
    found.set(selectionId(k.recipeId, k.plannedFor), {
      id: selectionId(k.recipeId, k.plannedFor),
      recipeId: k.recipeId,
      plannedFor: k.plannedFor,
      servings: latest?.payload.servings ?? 0,
      cooked: false,
    });
  }
  for (const [key, reg] of state) {
    const k = parseKey(key);
    if (k?.kind !== 'menuCooked' || reg.value !== true) continue;
    const sel = found.get(selectionId(k.recipeId, k.plannedFor));
    if (!sel) continue;
    sel.cooked = true;
    sel.cookedIn = [...reg.by].sort(lwwCompare).at(-1)?.payload.cookedIn ?? sel.plannedFor;
  }

  const out = new Map();
  for (const sel of found.values()) {
    const weeks = current - shopIndex(sel.plannedFor);
    sel.weeksCarried = Number.isFinite(weeks) ? Math.max(0, weeks) : 0;
    if (weeks < 0) continue;                                  // planned for a later shop
    // Something cooked this week stays visible, as cooked, until this shop
    // closes — it should not vanish under the finger that marked it.
    const onMenu = sel.plannedFor === shopId || !sel.cooked || sel.cookedIn === shopId;
    if (!onMenu) continue;
    sel.status = statusOf(sel);
    out.set(sel.id, sel);
  }
  return out;
}

/** FR-MENU-2 to FR-MENU-5, in one place. */
export function statusOf(sel) {
  if (sel.cooked) return COOKED;
  if (sel.weeksCarried === 0) return PLANNED;
  if (sel.weeksCarried === 1) return CARRIED;                   // FR-MENU-3
  return FLAGGED;                                               // FR-MENU-5 — carried at most once
}

/** A Carried entry behaves exactly like a Planned one for cooking and picking. */
export const isActive = (sel) => sel.status === PLANNED || sel.status === CARRIED;

/** FR-MENU-5: a Flagged entry must be explicitly resolved before it is settled. */
export const needsDecision = (sel) => sel.status === FLAGGED;

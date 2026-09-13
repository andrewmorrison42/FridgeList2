// The shop lifecycle: draft → open → closed. ARCHITECTURE.md §8.1.
//
// Nobody creates a shop. There is always exactly one current shop, in draft;
// generating populates it, locking transitions it, closing brings the next one
// into being. Shop ids form a chain with deterministic successors, so two
// people cannot start two shops — starting a shop is not an operation that
// exists — and two concurrent closes name the same successor rather than
// forking the chain.

import { merge } from './merge.js';

export const GENESIS_SHOP = 'shop-0001';

/** The successor of a shop id. Deterministic: no coordination needed. */
export function nextShopId(shopId) {
  const m = /^shop-(\d+)$/.exec(shopId);
  if (!m) throw new Error(`not a shop id: ${shopId}`);
  return `shop-${String(Number(m[1]) + 1).padStart(4, '0')}`;
}

/**
 * Every shop the events know about, and the phase each is in.
 *
 * Phase is derived, never stored: a locked shop is one with a `shop.locked`
 * register resolved true, a closed shop likewise. Both are true-wins registers
 * (§5.4), so concurrent locks or closes converge rather than conflict.
 */
export function shopPhases(events) {
  const state = merge(events);
  const phases = new Map();
  for (const [key, reg] of state) {
    const m = /^shop:([^:]+):(locked|closed)$/.exec(key);
    if (!m || reg.value !== true) continue;
    const [, id, what] = m;
    const current = phases.get(id);
    // closed outranks locked: a shop that has been closed is closed.
    if (what === 'closed' || current !== 'closed') {
      phases.set(id, what === 'closed' ? 'closed' : 'open');
    }
  }
  return phases;
}

/**
 * The one shop that is not closed — the household's current shop.
 *
 * Walks the chain from genesis past every closed shop. Because successors are
 * deterministic this cannot fork, and because it is derived from events rather
 * than stored, every device reaches the same answer. §14 P7.
 */
export function currentShop(events) {
  const phases = shopPhases(events);
  let id = GENESIS_SHOP;
  // Bounded to keep a malformed event set from spinning: a household shopping
  // weekly reaches 10,000 shops in about 190 years.
  for (let i = 0; i < 10000; i++) {
    if (phases.get(id) !== 'closed') return { id, phase: phases.get(id) ?? 'draft' };
    id = nextShopId(id);
  }
  throw new Error('shop chain did not terminate');
}

/**
 * Everything the app needs to know about what may be done right now.
 * The `open` column of §5.9's table, expressed once so no view re-derives it.
 */
export function permissions(events) {
  const { id, phase } = currentShop(events);
  const draft = phase === 'draft';
  return {
    shopId: id,
    phase,
    canEditMenu: draft,            // FR-SHOP-3
    canRemoveLines: draft,         // FR-LIST-3 — the pantry check
    canGenerate: draft,            // §5.7 — regeneration is a draft activity
    canAddLines: phase !== 'closed',      // FR-SHOP-1
    canAddWaitList: phase !== 'closed',   // deliberate, purely additive
    canTick: phase === 'open',            // FR-LIST-5
    canLock: draft,
    canClose: phase === 'open',           // FR-SHOP-4
  };
}

/**
 * Why an action is unavailable, in words a person can act on.
 *
 * FR-SHOP-4: wherever the system declines an action because a shop is still
 * open, it must name the open shop and offer the completion action from that
 * same place. A bare refusal turns a loud failure into a stuck one — which is
 * the whole reason the unfinished-shop risk was acceptable.
 */
export function explainRefusal(events, action) {
  const { id, phase } = currentShop(events);
  if (phase === 'open' && ['canEditMenu', 'canGenerate', 'canRemoveLines'].includes(action)) {
    return {
      reason: `Shopping is still in progress (${id}).`,
      remedy: 'Mark the shop complete to plan the next one.',
      remedyAction: 'closeShop',
      shopId: id,
    };
  }
  if (phase === 'draft' && action === 'canTick') {
    return {
      reason: 'Shopping has not started yet.',
      remedy: 'Lock the menu when everyone has chosen, then start ticking.',
      remedyAction: 'lockShop',
      shopId: id,
    };
  }
  return null;
}

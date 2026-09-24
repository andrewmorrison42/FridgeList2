// Register keys: the one place their format is defined — both building a key
// and reading one back. Review #3.
//
// Before this module the format lived in six files: merge.js built keys, and
// five others rebuilt them by hand or took them apart with their own regexes.
// Let the two halves drift and a lookup quietly returns `undefined` — which for
// a tick reads as "not done", with no error anywhere. That is a silent failure
// (P-II), so the format now has exactly one definition, and a test fails if a
// key is built or parsed anywhere else.

const SEP = ':';

/**
 * A key segment may not contain the separator. Enforced when a key is built,
 * so an ambiguous key is unrepresentable rather than mis-parsed later (P-I).
 */
function seg(value, name) {
  const s = String(value);
  if (!s || s.includes(SEP)) throw new Error(`${name} "${s}" cannot be used in a key`);
  return s;
}

/** Builders. Every key in the system is made by one of these. */
export const K = {
  lineDone:           (shopId, ingredientId) => `line:${seg(shopId, 'shopId')}:${seg(ingredientId, 'ingredientId')}:done`,
  linePresent:        (shopId, ingredientId) => `line:${seg(shopId, 'shopId')}:${seg(ingredientId, 'ingredientId')}:present`,
  lineSuppressed:     (shopId, ingredientId) => `line:${seg(shopId, 'shopId')}:${seg(ingredientId, 'ingredientId')}:suppressed`,
  menuPresent:        (recipeId) => `menu:${seg(recipeId, 'recipeId')}:present`,
  menuCooked:         (recipeId) => `menu:${seg(recipeId, 'recipeId')}:cooked`,
  menuCarried:        (recipeId, shopId) => `menu:${seg(recipeId, 'recipeId')}:carried:${seg(shopId, 'shopId')}`,
  waitlistPresent:    (itemId) => `waitlist:${seg(itemId, 'itemId')}:present`,
  carryoverDismissed: (shopId, ingredientId) => `carryover:${seg(shopId, 'shopId')}:${seg(ingredientId, 'ingredientId')}`,
  shopLocked:         (shopId) => `shop:${seg(shopId, 'shopId')}:locked`,
  shopClosed:         (shopId) => `shop:${seg(shopId, 'shopId')}:closed`,
  recipe:             (recipeId) => `recipe:${seg(recipeId, 'recipeId')}`,
  ingredient:         (ingredientId) => `ingredient:${seg(ingredientId, 'ingredientId')}`,
  // One register for all imported history. Imported trip ids contain the
  // separator ("trip:2026-08-29T05:16:33.687Z:…"), so they cannot be key
  // segments; carrying the trips as a single value sidesteps that, and
  // re-importing simply replaces it.
  historyImported:    () => 'history:imported',
};

/** Readers: the exact inverse of the builders above. */
const PATTERNS = [
  ['lineDone',           /^line:([^:]+):([^:]+):done$/,       ['shopId', 'ingredientId']],
  ['linePresent',        /^line:([^:]+):([^:]+):present$/,    ['shopId', 'ingredientId']],
  ['lineSuppressed',     /^line:([^:]+):([^:]+):suppressed$/, ['shopId', 'ingredientId']],
  ['menuPresent',        /^menu:([^:]+):present$/,            ['recipeId']],
  ['menuCooked',         /^menu:([^:]+):cooked$/,             ['recipeId']],
  ['menuCarried',        /^menu:([^:]+):carried:([^:]+)$/,    ['recipeId', 'shopId']],
  ['waitlistPresent',    /^waitlist:([^:]+):present$/,        ['itemId']],
  ['carryoverDismissed', /^carryover:([^:]+):([^:]+)$/,       ['shopId', 'ingredientId']],
  ['shopLocked',         /^shop:([^:]+):locked$/,             ['shopId']],
  ['shopClosed',         /^shop:([^:]+):closed$/,             ['shopId']],
  ['recipe',             /^recipe:([^:]+)$/,                  ['recipeId']],
  ['ingredient',         /^ingredient:([^:]+)$/,              ['ingredientId']],
  ['historyImported',    /^history:imported$/,                []],
];

/** Read a key back into its kind and fields, or null if it is not ours. */
export function parseKey(key) {
  for (const [kind, re, names] of PATTERNS) {
    const m = re.exec(key);
    if (m) return Object.fromEntries([['kind', kind], ...names.map((n, i) => [n, m[i + 1]])]);
  }
  return null;
}

/** Which register an event talks about. */
export function keyOf(event) {
  const p = event.payload ?? {};
  switch (event.type) {
    // A line is identified by (shopId, ingredientId) — never by name, position
    // or a per-device id. Two devices adding the same ingredient produce events
    // about the *same* line, which merge, rather than two lines needing
    // de-duplication later, which would have to decide whose tick to keep. §5.6.
    case 'line.done':           return K.lineDone(p.shopId, p.ingredientId);
    case 'line.added':          return K.linePresent(p.shopId, p.ingredientId);
    case 'line.suppressed':     return K.lineSuppressed(p.shopId, p.ingredientId);
    case 'menu.selection':      return K.menuPresent(p.recipeId);
    case 'menu.cooked':         return K.menuCooked(p.recipeId);
    // One register per (selection, shop) rather than one counter per selection:
    // set membership is idempotent where an increment is not. §5.5, §9.1.
    case 'menu.carried':        return K.menuCarried(p.recipeId, p.shopId);
    case 'waitlist.item':       return K.waitlistPresent(p.itemId);
    case 'carryover.dismissed': return K.carryoverDismissed(p.shopId, p.ingredientId);
    case 'shop.locked':         return K.shopLocked(p.shopId);
    case 'shop.closed':         return K.shopClosed(p.shopId);
    case 'recipe.upsert':       return K.recipe(p.recipeId);
    case 'ingredient.upsert':   return K.ingredient(p.ingredientId);
    case 'history.imported':    return K.historyImported();
    default: throw new Error(`unkeyed event type: ${event.type}`);
  }
}

/** keyOf, or null for an event that cannot be keyed. Never throws. */
export function tryKeyOf(event) {
  try { return keyOf(event); } catch { return null; }
}

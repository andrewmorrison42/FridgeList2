// Cooking units in, shopping units out. FR-ING-1.
//
// An ingredient is cooked in one unit and bought in another — flour is cups in
// a recipe and weight on a shopping list. The requirement is absolute: a
// quantity is never presented or totalled without the conversion applied. So
// there is exactly one way to get a shopping quantity, and it is this module.

/**
 * Convert a recipe quantity into the ingredient's shopping unit.
 *
 * `cookingUnit` absent, or equal to the shopping unit, means the ingredient is
 * cooked in the unit it is bought in — no conversion, which satisfies FR-ING-1
 * trivially and is the common case (3,104 of 5,561 lines in the household's
 * data).
 *
 * Throws rather than guessing. A missing conversion is a data defect, and a
 * silently wrong quantity is precisely the class of failure this system exists
 * to avoid — a plausible number nobody questions is worse than an error.
 */
export function toShoppingUnit(quantity, cookingUnit, ingredient) {
  if (!Number.isFinite(quantity)) {
    throw new TypeError(`quantity must be a number, got ${JSON.stringify(quantity)}`);
  }
  if (!cookingUnit || cookingUnit === ingredient.shoppingUnit) return quantity;

  const factor = ingredient.conversions?.[cookingUnit];
  if (!Number.isFinite(factor)) {
    throw new Error(
      `no conversion from "${cookingUnit}" to "${ingredient.shoppingUnit}" ` +
      `for ingredient "${ingredient.name}"`,
    );
  }
  return quantity * factor;
}

const FRACTIONS = { '\u00bc': 0.25, '\u00bd': 0.5, '\u00be': 0.75, '\u2153': 1 / 3, '\u2154': 2 / 3, '\u215b': 0.125 };

/**
 * Read an amount as people write it: "500", "0.5", "1/3", "½", "2 ¼", "1 1/2".
 * Returns a number, or null when there is no amount in it.
 *
 * One parser for the whole system: the migration reads the household's data
 * with it and the recipe editor reads what people type with it, so the two can
 * never disagree about what "2 ¼" means. (The migration's own copy claimed to
 * read "2 1/4" and returned nothing for it.) A parsed zero is a value — "0"
 * means "to serve" — never a failure.
 */
export function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let t = String(raw ?? '').trim();
  if (!t) return null;
  let total = 0;
  let parsed = false;
  for (const [glyph, value] of Object.entries(FRACTIONS)) {
    if (t.includes(glyph)) { total += value; t = t.replace(glyph, ' '); parsed = true; }
  }
  for (const part of t.split(/\s+/).filter(Boolean)) {
    const slash = /^(\d+)\/(\d+)$/.exec(part);
    if (slash && Number(slash[2]) !== 0) { total += Number(slash[1]) / Number(slash[2]); parsed = true; continue; }
    const n = Number(part.replace(',', '.'));
    if (part && Number.isFinite(n)) { total += n; parsed = true; continue; }
    return null;                       // something that is not an amount
  }
  return parsed ? total : null;
}

/** Scale a recipe line for the servings actually wanted. */
export function scaleForServings(quantity, wantServings, recipeServings) {
  if (!recipeServings) throw new Error('recipe has no servings baseline (FR-REC-1)');
  return (quantity * wantServings) / recipeServings;
}

/**
 * How a quantity is shown. Shopping happens in a supermarket, not a laboratory:
 * 1,013.4 g of flour helps nobody, and nor does 0.30000000000000004 — or
 * "6000 mL" of milk, which is bought as 6 L (glitch #11).
 */
export function formatQuantity(quantity, unit) {
  // A line added by hand ("we need mayo") has no quantity. Showing "1 g" would
  // be a number nobody chose.
  if (quantity === null || quantity === undefined) return '';
  const big = { g: 'kg', mL: 'L' }[unit];
  if (big && quantity >= 1000) {
    const n = Math.round(quantity / 100) / 10;                 // one decimal place
    return `${Number.isInteger(n) ? n : n.toFixed(1)} ${big}`;
  }
  // Counted things are bought whole: 1.35 lemons is 2 lemons, and three
  // thirds of an onion is one onion, not two (hence the small tolerance for
  // floating-point sums). Glitch #13. The exact figure is kept underneath;
  // only what is shown rounds.
  if (unit === 'qty') return `${Math.max(1, Math.ceil(quantity - 1e-9))}`;
  const rounded =
    quantity >= 100 ? Math.round(quantity / 10) * 10
    : Math.round(quantity);
  const n = Number.isInteger(rounded) ? rounded : Number(rounded.toFixed(2));
  return `${n} ${unit}`;
}

/**
 * One line of a recipe, the way the recipe reads: "2 cup Wine: white" where
 * the recipe was written in cups, "300 g Mushrooms" where it was written in
 * what is bought, "1 Leek" for a count. Before glitch #12 a count read
 * "1  Leek" and a weighed line lost its unit entirely.
 */
export function describeRecipeLine(line, ingredient) {
  const name = ingredient?.name ?? line.ingredientId;
  if (line.garnish || line.quantity === 0) return `${name}, to serve`;
  const qty = line.displayQty ?? (line.cookingUnit ? line.quantity : formatAmount(line.quantity));
  const unit = line.displayUnit ?? line.cookingUnit ?? (ingredient?.shoppingUnit === 'qty' ? null : ingredient?.shoppingUnit);
  return [qty, unit, name].filter((part) => part !== null && part !== undefined && part !== '').join(' ');
}

const formatAmount = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(2)));

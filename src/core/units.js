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

/** Scale a recipe line for the servings actually wanted. */
export function scaleForServings(quantity, wantServings, recipeServings) {
  if (!recipeServings) throw new Error('recipe has no servings baseline (FR-REC-1)');
  return (quantity * wantServings) / recipeServings;
}

/**
 * How a quantity is shown. Shopping happens in a supermarket, not a laboratory:
 * 1,013.4 g of flour helps nobody, and nor does 0.30000000000000004.
 */
export function formatQuantity(quantity, unit) {
  const rounded =
    unit === 'qty' ? Math.ceil(quantity * 100) / 100
    : quantity >= 100 ? Math.round(quantity / 10) * 10
    : Math.round(quantity);
  const n = Number.isInteger(rounded) ? rounded : Number(rounded.toFixed(2));
  return unit === 'qty' ? `${n}` : `${n} ${unit}`;
}

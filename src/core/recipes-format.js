// The household's recipe file format: reading it, and editing it without
// changing what it is. ARCHITECTURE.md §12.
//
// Pure: no I/O, no DOM. The same file is read and written by the earlier
// version of the app, so everything here keeps that format exactly — field
// names, the shopping-unit `quantity`, the cup/TBsp/tsp display measures, and
// every field this app does not use. `importLibrary` turns the file into the
// shape src/core/library.js and generate.js expect; the edit functions change
// one recipe and leave the rest of the file as it was.

const FRACTIONS = { '¼': 0.25, '½': 0.5, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125 };

/** Parse "2 1/4", "1/3", "500" - the display quantities as actually written. */
function parseQty(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  let t = String(raw ?? '').trim();
  if (!t) return null;
  let total = 0;
  let parsedSomething = false;
  for (const [glyph, value] of Object.entries(FRACTIONS)) {
    if (t.includes(glyph)) { total += value; t = t.replace(glyph, ''); parsedSomething = true; }
  }
  t = t.trim();
  if (t) {
    const slash = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
    if (slash) { total += Number(slash[1]) / Number(slash[2]); parsedSomething = true; }
    else if (Number.isFinite(Number(t))) { total += Number(t); parsedSomething = true; }
    else return parsedSomething ? total : null;
  }
  // A parsed zero is a value, not a failure. "0" means "to serve" - a garnish
  // with no amount - and returning null for it would silently drop the line
  // instead of carrying it as one (A6).
  return parsedSomething ? total : null;
}

const normName = (name) => String(name ?? '').trim().toLowerCase();

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function importLibrary(source, tripHistory = { trips: [] }, { now = Date.now() } = {}) {
  const report = { fixed: [], referred: [], counts: {} };
  const settings = source.settings ?? {};

  // -- ingredients: stable ids, one shopping group, staples ------------------
  const byName = new Map();
  const ingredients = [];
  let syntheticId = 10000;

  for (const raw of source.ingredients) {
    const id = String(raw.id ?? ++syntheticId);
    if (byName.has(raw.name)) {
      // Mint and Tahini each name two different things - fresh vs dried, in
      // different aisles. Merging them would put dried mint in the vegetable
      // aisle, so they are kept apart and referred for disambiguation.
      const first = byName.get(raw.name);
      report.referred.push({
        kind: 'duplicate-name', name: raw.name,
        detail: `also ${first.aisle}/${first.category}; recipes naming it resolve to the first and may mean either`,
      });
    }
    const ing = {
      id, name: raw.name,
      shoppingUnit: raw.shoppingUnit || 'qty',
      category: raw.shoppingCategory || 'Other',
      aisle: raw.aisle || 'Uncategorised',
      conversions: {},
      preference: raw.preference ?? null,
      isStaple: false,
      startsAtHome: false,
    };
    if (!raw.shoppingUnit) report.referred.push({ kind: 'no-shopping-unit', name: raw.name });
    ingredients.push(ing);
    if (!byName.has(raw.name)) byName.set(raw.name, ing);
  }

  // Staples are a property of the ingredient, held separately from recipe and
  // Wait List membership; the three are never conflated (FR-STA-2). Only while
  // the household has staples switched on — the switch lives in the same file
  // and the earlier app honours it, so both apps agree on what goes on a list.
  for (const name of settings.features?.staples ? settings.staples ?? [] : []) {
    const ing = byName.get(name);
    if (!ing) { report.referred.push({ kind: 'unknown-staple', name }); continue; }
    ing.isStaple = true;
    ing.stapleQty = stapleQtyOf(source, name) ?? 1;
  }

  // Which ingredients start a new list in "at home already", as the earlier app
  // decides it: Pantry items when that option is on, and anything the household
  // has said it always has in. The list keeps Wait List items and staples on the
  // buy list regardless (generate.js).
  const always = new Set((settings.alwaysAtHome ?? []).map(normName));
  for (const ing of ingredients) {
    ing.startsAtHome = (!!settings.features?.pantryAtHome && ing.category === 'Pantry') || always.has(normName(ing.name));
  }

  // -- conversions: one factor per (ingredient, cooking unit) ---------------
  // FR-ING-1 assumes one; the source holds several for 107 pairs, which is
  // rounding noise from individual recipes rather than disagreement about what
  // a teaspoon is. The median lands on the sensible value in every case
  // sampled. Recorded here so the choice is visible rather than buried (A7).
  const observed = new Map();
  for (const recipe of source.recipes) {
    for (const line of recipe.ingredients ?? []) {
      const ing = byName.get(line.ingredientName);
      const unit = line.displayUnit;
      if (!ing || !unit) continue;
      const display = parseQty(line.displayQty);
      const shop = parseQty(line.quantity);
      if (!display || !shop) continue;
      const key = `${ing.id}|${unit}`;
      if (!observed.has(key)) observed.set(key, []);
      observed.get(key).push(shop / display);
    }
  }
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  for (const [key, factors] of observed) {
    const sep = key.lastIndexOf('|');
    const ing = byId.get(key.slice(0, sep));
    const unit = key.slice(sep + 1);
    ing.conversions[unit] = Number(median(factors).toFixed(4));
    const spread = Math.max(...factors) / Math.min(...factors);
    if (spread > 1.05) {
      report.fixed.push({ kind: 'conversion-median', ingredient: ing.name, unit,
        chose: ing.conversions[unit], from: [...new Set(factors.map((f) => Number(f.toFixed(2))))] });
    }
  }

  // -- recipes: references by id, not by name ------------------------------
  const byLowerName = new Map();
  for (const [name, ing] of byName) if (!byLowerName.has(normName(name))) byLowerName.set(normName(name), ing);
  const recipes = [];
  for (const raw of source.recipes) {
    const lines = [];
    for (const line of raw.ingredients ?? []) {
      // The earlier app matches names ignoring case and spacing, so a line it
      // wrote as "onion " still means Onion.
      const ing = byName.get(line.ingredientName) ?? byLowerName.get(normName(line.ingredientName));
      if (!ing) { report.referred.push({ kind: 'unknown-ingredient', recipe: raw.id, name: line.ingredientName }); continue; }
      const quantity = parseQty(line.quantity);
      if (quantity === null) {
        report.referred.push({ kind: 'unparseable-quantity', recipe: raw.id, name: line.ingredientName, raw: String(line.quantity) });
        continue;
      }
      if (quantity === 0) {
        // "Serve with lettuce", recorded with no amount. A zero line would
        // generate a meaningless zero-quantity entry, so it is carried as a
        // garnish and kept off the shopping list (A6).
        report.referred.push({ kind: 'zero-quantity', recipe: raw.id, name: line.ingredientName });
        lines.push({ ingredientId: ing.id, quantity: 0, garnish: true,
          displayQty: line.displayQty ?? null, displayUnit: line.displayUnit ?? null });
        continue;
      }
      // `quantity` in this format is already in the ingredient's shopping unit;
      // displayQty/displayUnit are only how the cook measures it. So there is
      // no cooking unit to convert from. Converting from displayUnit here once
      // multiplied 2,457 lines by the cup/spoon factor a second time.
      lines.push({
        ingredientId: ing.id,
        quantity,
        cookingUnit: null,
        displayQty: line.displayQty ?? null,
        displayUnit: line.displayUnit ?? null,
        descriptor: line.descriptor ?? null,
        section: line.section ?? null,
      });
    }
    recipes.push({
      id: raw.id, name: raw.name, category: raw.category ?? null,
      servings: raw.servings || 4, lines,
      slowCooker: !!raw.slowCooker, inSeason: raw.inSeason !== false,
      method: raw.method ?? [], notes: raw.notes ?? null,
      source: raw.source ?? null, sourceUrl: raw.sourceUrl ?? null,
    });
  }

  // -- trip history: recipes selected and when, nothing more ---------------
  const cutoff = now - 2 * 365 * 86400000;
  const trips = (tripHistory.trips ?? [])
    .filter((t) => t.doneAt && Date.parse(t.doneAt) >= cutoff)
    .map((t) => ({
      shopId: t.tripId,
      closedAt: t.doneAt,
      selections: (t.selections ?? []).map((s) => s.recipeId),
    }));

  report.counts = {
    ingredients: ingredients.length, recipes: recipes.length,
    recipeLines: recipes.reduce((n, r) => n + r.lines.length, 0),
    conversionPairs: observed.size, trips: trips.length,
    staples: ingredients.filter((i) => i.isStaple).length,
  };

  return { library: { ingredients, recipes, trips }, report };
}

// -- editing --------------------------------------------------------------
//
// These mirror the earlier app's recipe editor rule for rule, because both apps
// write the same file: a line measured in cup/TBsp/tsp stores its shopping
// quantity in mL (or g, 1 g = 1 mL) plus the measure as typed; any other line
// stores the quantity in the ingredient's own shopping unit. Conversion basis
// as agreed by the household on 17 Jul 2026.

export const MEASURE_ML = { cup: 250, TBsp: 20, tsp: 5 };
const MEASURE_FRACTIONS = { cup: [1 / 8, 1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4], tsp: [1 / 8, 1 / 4, 1 / 2, 3 / 4], TBsp: [1 / 2] };
const FRACTION_GLYPHS = [[1 / 8, '⅛'], [1 / 4, '¼'], [1 / 3, '⅓'], [1 / 2, '½'], [2 / 3, '⅔'], [3 / 4, '¾']];
// The fields the editor changes, read the way the earlier app reads them, so a
// recipe that never had a `slowCooker` key compares equal to one set false.
const EDITED = {
  name: (r) => r.name ?? '', category: (r) => r.category ?? '', servings: (r) => r.servings ?? null,
  ingredients: (r) => r.ingredients ?? [], method: (r) => r.method ?? [], notes: (r) => r.notes ?? '',
  slowCooker: (r) => !!r.slowCooker, inSeason: (r) => r.inSeason !== false, sourceUrl: (r) => r.sourceUrl ?? '',
};

export function parseMeasureQty(str) {
  if (str === null || str === undefined) return null;
  const t = String(str).trim()
    .replace(/⅛/g, ' 1/8').replace(/¼/g, ' 1/4').replace(/⅓/g, ' 1/3')
    .replace(/½/g, ' 1/2').replace(/⅔/g, ' 2/3').replace(/¾/g, ' 3/4').trim();
  if (!t) return null;
  const m = t.match(/^(\d+)?\s*(\d+)\s*\/\s*(\d+)$/);
  if (m) {
    const den = parseInt(m[3], 10);
    return den ? (m[1] ? parseInt(m[1], 10) : 0) + parseInt(m[2], 10) / den : null;
  }
  const f = Number(t.replace(',', '.'));
  return Number.isFinite(f) ? f : null;
}

export function validMeasureQty(num, unit) {
  if (num === null || num <= 0) return false;
  const fr = MEASURE_FRACTIONS[unit];
  if (!fr) return true;
  const rem = num - Math.floor(num);
  return rem < 1e-9 || fr.some((x) => Math.abs(rem - x) < 0.02);
}

export function formatMeasureQty(num) {
  const whole = Math.floor(num);
  const rem = num - whole;
  if (rem < 1e-9) return String(whole);
  for (const [v, g] of FRACTION_GLYPHS) if (Math.abs(rem - v) < 0.02) return (whole ? `${whole} ` : '') + g;
  return String(Math.round(num * 100) / 100);
}

export const measureToShoppingQty = (num, unit) => Math.round(num * MEASURE_ML[unit]);

const kitchenMeasure = (u) => {
  const t = String(u ?? '').trim().toLowerCase();
  if (t === 'cup' || t === 'cups') return 'cup';
  if (t === 'tbsp' || t === 'tablespoon' || t === 'tablespoons') return 'TBsp';
  if (t === 'tsp' || t === 'teaspoon' || t === 'teaspoons') return 'tsp';
  return null;
};

export function findIngredient(source, name) {
  const n = normName(name);
  return n ? (source.ingredients ?? []).find((i) => normName(i.name) === n) ?? null : null;
}

/**
 * Which units a line for this ingredient may use: a choice of the shopping
 * unit or a kitchen measure for g/mL ingredients, the shopping unit alone for
 * anything else known, and free text for a new ingredient — unless the row has
 * already said how the new ingredient is bought.
 */
export function unitChoices(source, name, row = null) {
  const ing = findIngredient(source, name);
  const unit = ing ? ing.shoppingUnit : row?.newUnit;
  if (!ing && !unit) return { kind: 'free' };
  if (unit === 'g' || unit === 'mL') return { kind: 'choose', options: [unit, 'cup', 'TBsp', 'tsp'] };
  return { kind: 'fixed', unit: unit ?? '' };
}

const editedFields = (r) => JSON.stringify(Object.values(EDITED).map((read) => (r ? read(r) : null)));

/** A heading item in a draft's rows: every line below it, to the next, is in that section. */
export const isHeading = (item) => item && Object.prototype.hasOwnProperty.call(item, 'heading');

function lineToRow(source, line) {
  const ing = findIngredient(source, line.ingredientName);
  const row = {
    name: line.ingredientName ?? '',
    qty: line.displayUnit ? String(line.displayQty ?? '') : String(line.quantity ?? ''),
    unit: line.displayUnit || line.unit || ing?.shoppingUnit || '',
    descriptor: line.descriptor ?? '',
    orig: line,
  };
  // A unit the ingredient no longer allows reads as its shopping unit, which is
  // what the quantity is stored in.
  const choice = unitChoices(source, row.name);
  if (choice.kind === 'choose' && !choice.options.includes(row.unit)) row.unit = choice.options[0];
  if (choice.kind === 'fixed') row.unit = choice.unit;
  row.opened = rowKey(row);
  return row;
}

// Where a row sits (its section) is not part of this: moving a line leaves
// what it says untouched.
const rowKey = (r) => JSON.stringify([r.name.trim(), r.qty.trim(), r.unit, r.descriptor.trim()]);

/** An editable copy of one recipe, or of a blank one when `recipeId` is null. */
export function recipeToDraft(source, recipeId) {
  const r = recipeId ? source.recipes.find((x) => x.id === recipeId) : null;
  if (recipeId && !r) throw new Error(`no recipe ${recipeId}`);
  // Section headings become items of their own, as in the earlier app's
  // editor, so they can be renamed and moved. A line with no section after a
  // sectioned one gets an empty heading, which keeps it out of that section.
  const rows = [];
  let section = '';
  for (const line of r?.ingredients ?? []) {
    const here = line.section ?? '';
    if (here !== section) rows.push({ heading: here });
    section = here;
    rows.push(lineToRow(source, line));
  }
  return {
    id: r?.id ?? null,
    base: r ? editedFields(r) : null,
    name: r?.name ?? '',
    category: r?.category ?? '',
    servings: String(r?.servings ?? 4),
    slowCooker: r ? !!r.slowCooker : false,
    inSeason: r ? r.inSeason !== false : true,
    sourceUrl: r?.sourceUrl ?? '',
    method: (r?.method ?? []).join('\n'),
    notes: r?.notes ?? '',
    rows,
    error: null,
  };
}

export function blankRow() {
  return { name: '', qty: '', unit: '', descriptor: '', orig: null, opened: null };
}

/** Move a line or heading one place up (-1) or down (+1). */
export function moveItem(draft, i, dir) {
  const j = i + dir;
  if (j < 0 || j >= draft.rows.length) return;
  [draft.rows[i], draft.rows[j]] = [draft.rows[j], draft.rows[i]];
}

function rowToLine(source, row, newIngredients) {
  const name = row.name.trim();
  // A row nobody touched goes back exactly as it came, so opening and saving a
  // recipe never rewrites lines the earlier app wrote in its own way. Moved
  // under another heading, only its section changes.
  if (row.orig && rowKey(row) === row.opened) {
    if ((row.orig.section ?? '') === row.section) return { line: row.orig };
    const line = { ...row.orig };
    if (row.section) line.section = row.section; else delete line.section;
    return { line };
  }

  const qtyText = row.qty.trim();
  const descriptor = row.descriptor.trim();
  const known = findIngredient(source, name) ?? newIngredients.find((i) => normName(i.name) === normName(name));
  const shopUnit = known ? known.shoppingUnit : (row.newUnit || null);
  const base = { ...(row.orig ?? {}) };
  delete base.displayQty; delete base.displayUnit; delete base.descriptor; delete base.section;

  const measure = MEASURE_ML[row.unit] ? row.unit : (!shopUnit ? kitchenMeasure(row.unit) : null);
  let line;
  if (measure) {
    const num = parseMeasureQty(qtyText);
    if (!validMeasureQty(num, measure)) {
      const allowed = measure === 'cup' ? 'whole numbers and ⅛ ¼ ⅓ ½ ⅔ ¾'
        : measure === 'tsp' ? 'whole numbers and ⅛ ¼ ½ ¾' : 'whole numbers and ½';
      return { error: `"${name}": "${qtyText}" isn't a valid amount in ${measure}. Allowed: ${allowed} (e.g. 1 ½).` };
    }
    line = { ...base, ingredientName: known?.name ?? name, quantity: measureToShoppingQty(num, measure),
      unit: shopUnit ?? 'mL', displayQty: formatMeasureQty(num), displayUnit: measure };
  } else {
    if (parseMeasureQty(qtyText) === null) {
      return { error: `"${name}": the amount "${qtyText}" needs to be a number, like 2, 1/2 or 1 ½. Use 0 for "to serve".` };
    }
    line = { ...base, ingredientName: known?.name ?? name, quantity: qtyText, unit: shopUnit ?? row.unit.trim() };
  }
  if (row.section) line.section = row.section;
  if (descriptor) line.descriptor = descriptor;

  if (!known) {
    // A name not in the ingredient list joins it, with the aisle, category and
    // unit chosen for it in the editor, or uncategorised if none were — as
    // the earlier app adds one — rather than vanishing from the shopping list.
    newIngredients.push({ name, shoppingUnit: row.newUnit || line.unit || '',
      aisle: row.newAisle || 'Uncategorised', shoppingCategory: row.newCategory || 'Other' });
  }
  return { line };
}

function uniqueSlug(source, name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'recipe';
  let slug = base;
  for (let i = 2; source.recipes.some((r) => r.id === slug); i++) slug = `${base}-${i}`;
  return slug;
}

/**
 * Apply a draft to the file's current contents, changing that one recipe and
 * nothing else.
 *
 * `source` should be the file as just read, not as it was when the editor
 * opened: someone may have changed another recipe meanwhile, and that change
 * must survive. If someone changed *this* recipe meanwhile, the draft is
 * refused rather than saved over theirs.
 *
 * @returns {{ source, recipeId } | { error } | { conflict: true }}
 */
export function applyDraft(source, draft) {
  const next = structuredClone(source);
  const name = draft.name.trim();
  if (!name) return { error: 'Please give the recipe a name.' };
  const servings = parseInt(draft.servings, 10);
  if (!(servings >= 1)) return { error: 'Servings needs to be a whole number, 1 or more.' };
  const sourceUrl = (draft.sourceUrl ?? '').trim();
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) return { error: 'The source website needs to start with http:// or https://' };

  let existing = null;
  if (draft.id) {
    existing = next.recipes.find((r) => r.id === draft.id);
    if (!existing) return { error: 'This recipe has been deleted on another device since you opened it.' };
    if (editedFields(existing) !== draft.base) return { conflict: true };
  }

  const newIngredients = [];
  const ingredients = [];
  let section = '';
  for (const item of draft.rows) {
    if (isHeading(item)) { section = item.heading.trim(); continue; }
    if (!item.name.trim()) continue;
    const out = rowToLine(next, { ...item, section }, newIngredients);
    if (out.error) return { error: out.error };
    ingredients.push(out.line);
  }
  const method = String(draft.method ?? '').split('\n').map((x) => x.trim()).filter(Boolean)
    .map((x) => { const m = x.match(/^(?:—|–|--)\s*(.+)$/); return m ? `— ${m[1]}` : x; });
  const fields = { name, category: draft.category.trim(), servings, ingredients, method, notes: draft.notes.trim() };
  const slowCooker = !!draft.slowCooker;
  const inSeason = draft.inSeason !== false;

  if (existing) {
    // Only the edited fields change. Everything else on the recipe —
    // lastPlanned, images, wikiTitle, whatever the earlier app keeps — stays.
    const after = { ...existing, ...fields, slowCooker, inSeason, sourceUrl };
    if (editedFields(after) === draft.base) return { source, recipeId: existing.id, unchanged: true };
    Object.assign(existing, fields);
    // Flags and link are written only when they change, so a recipe that never
    // had the key does not gain one just by being saved.
    if (!!existing.slowCooker !== slowCooker) existing.slowCooker = slowCooker;
    if ((existing.inSeason !== false) !== inSeason) existing.inSeason = inSeason;
    if ((existing.sourceUrl ?? '') !== sourceUrl) {
      if (sourceUrl) existing.sourceUrl = sourceUrl; else delete existing.sourceUrl;
    }
  } else {
    // The same fields, in the same order, as a recipe the earlier app creates.
    existing = { id: uniqueSlug(next, name), name, category: fields.category, servings, slowCooker,
      inSeason, ingredients, method, images: [], notes: fields.notes, source: draft.origin ?? 'manual' };
    if (sourceUrl) existing.sourceUrl = sourceUrl;
    next.recipes.push(existing);
  }

  if (newIngredients.length) {
    let top = Math.max(0, ...next.ingredients.map((i) => Number(i.id)).filter(Number.isFinite));
    for (const ing of newIngredients) next.ingredients.push({ id: ++top, ...ing });
  }
  return { source: next, recipeId: existing.id };
}

/** Remove one recipe. Its ingredients stay in the ingredient list. */
export function deleteRecipe(source, recipeId) {
  const next = structuredClone(source);
  const i = next.recipes.findIndex((r) => r.id === recipeId);
  if (i === -1) return { error: 'That recipe has already been deleted.' };
  next.recipes.splice(i, 1);
  return { source: next };
}

/**
 * Take someone else's version of this recipe as the new starting point while
 * keeping the draft's own changes: what "save mine anyway" does after a
 * conflict, once the person has seen that there was one.
 */
export function rebaseDraft(draft, source) {
  const r = source.recipes.find((x) => x.id === draft.id);
  return r ? { ...draft, base: editedFields(r), error: null, conflict: false } : draft;
}

// -- the ingredient list, staples and shared settings ---------------------
//
// All in the file's `ingredients` and `settings`, which the earlier app reads
// on every load, so every shape here is the one it writes: staples a plain
// array of names, their amounts a separate map in the shopping unit, feature
// switches in `settings.features`.

/** Shopping categories, in list order, and the aisles each may use. */
export const CATEGORIES = ['Fruit and Vegetables', 'Meat', 'Cold', 'Pantry', 'Toiletries', 'Other'];
export const CATEGORY_AISLES = {
  'Pantry': ['Alcohol', 'Bakery', 'Baking', 'Beverage', 'Biscuits', 'Breakfast', 'International',
    'Rice/pasta', 'Sauces', 'Snacks', 'Spices', 'Tins - fruit', 'Tins - veg'],
  'Cold': ['Dairy', 'Deli', 'Freezer'],
  'Fruit and Vegetables': ['Fruit', 'Vegetables'],
  'Meat': ['Fish', 'Meat'],
  'Toiletries': ['Toiletries'],
};
export const SHOPPING_UNITS = [
  { value: 'g', label: 'Weight (g)' },
  { value: 'mL', label: 'Volume (mL)' },
  { value: 'qty', label: 'Counted (each)' },
];

/** Every aisle in use or on the category lists, for a category with none of its own. */
export function knownAisles(source) {
  const all = new Set(Object.values(CATEGORY_AISLES).flat());
  for (const i of source.ingredients ?? []) if (i.aisle && i.aisle !== 'Uncategorised') all.add(i.aisle);
  return [...all].sort((a, b) => a.localeCompare(b));
}
export const aislesFor = (source, category) => CATEGORY_AISLES[category] ?? knownAisles(source);

/**
 * What an ingredient still needs before the shopping list can place and total
 * it: the same three checks as the earlier app's "needs an aisle, category or
 * unit" filter.
 */
export function needsAttention(ing) {
  const missing = [];
  if (!ing.shoppingCategory || ing.shoppingCategory === 'Other') missing.push('category');
  if (!ing.aisle || ing.aisle === 'Uncategorised') missing.push('aisle');
  if (!ing.shoppingUnit) missing.push('unit');
  return missing;
}

/** Set an ingredient's category, aisle or unit. Only the fields given change. */
export function setIngredient(source, name, fields) {
  const next = structuredClone(source);
  const ing = findIngredient(next, name);
  if (!ing) return { error: `"${name}" is not in the ingredient list any more.` };
  for (const k of ['shoppingCategory', 'aisle', 'shoppingUnit']) if (k in fields) ing[k] = fields[k];
  return { source: next };
}

const settingsOf = (s) => {
  if (!s.settings || typeof s.settings !== 'object') s.settings = {};
  return s.settings;
};

/** A staple's amount in its shopping unit, read as the earlier app reads it. */
function stapleQtyOf(source, name) {
  const map = source.settings?.stapleQty ?? {};
  const key = Object.keys(map).find((k) => normName(k) === normName(name));
  const v = key === undefined ? undefined : map[key];
  if (typeof v === 'number') return v > 0 ? v : null;
  return stapleQtyToShopping(v, findIngredient(source, name)?.shoppingUnit);
}

/** "2", "2 L", "500g", "1 cup" → a number in the shopping unit, or null. */
export function stapleQtyToShopping(raw, unit) {
  const m = String(raw ?? '').trim().match(/^([0-9.,/½¼¾⅓⅔⅛\s]+?)\s*([a-zA-Z]*)$/);
  if (!m) return null;
  const n = parseMeasureQty(m[1].replace(/,/g, '').trim());
  if (n === null || !(n > 0)) return null;
  const suffix = m[2].toLowerCase();
  if (!suffix) return n;
  if (unit === 'mL') {
    if (suffix === 'ml') return n;
    if (suffix === 'l') return n * 1000;
    const measure = kitchenMeasure(m[2]);
    if (measure) return n * MEASURE_ML[measure];
  }
  if (unit === 'g') {
    if (suffix === 'g') return n;
    if (suffix === 'kg') return n * 1000;
  }
  return null;
}

/** The staples, in the order they were added. */
export function staplesOf(source) {
  return (source.settings?.staples ?? []).map((name) => {
    const ing = findIngredient(source, name);
    return { name, qty: stapleQtyOf(source, name), unit: ing?.shoppingUnit ?? null, known: !!ing };
  });
}

/** Add a staple, or change its amount. `qty` as typed: "2", "2 L", "500 g". */
export function setStaple(source, name, qty) {
  const next = structuredClone(source);
  const ing = findIngredient(next, name);
  if (!ing) return { error: `Pick "${name.trim()}" from the ingredient list — staples have to be ingredients the list knows how to buy.` };
  const n = stapleQtyToShopping(qty, ing.shoppingUnit);
  if (String(qty ?? '').trim() && n === null) {
    return { error: `"${qty}" isn't an amount in ${ing.shoppingUnit === 'qty' || !ing.shoppingUnit ? 'items' : ing.shoppingUnit}.` };
  }
  const settings = settingsOf(next);
  const staples = Array.isArray(settings.staples) ? settings.staples : (settings.staples = []);
  if (!staples.some((s) => normName(s) === normName(ing.name))) staples.push(ing.name);
  const map = settings.stapleQty && typeof settings.stapleQty === 'object' ? settings.stapleQty : (settings.stapleQty = {});
  for (const k of Object.keys(map)) if (normName(k) === normName(ing.name)) delete map[k];
  if (n !== null) map[ing.name] = n;
  return { source: next };
}

export function removeStaple(source, name) {
  const next = structuredClone(source);
  const settings = settingsOf(next);
  settings.staples = (settings.staples ?? []).filter((s) => normName(s) !== normName(name));
  const map = settings.stapleQty ?? {};
  for (const k of Object.keys(map)) if (normName(k) === normName(name)) delete map[k];
  return { source: next };
}

/** The household's shared switches, as the earlier app stores them. */
export const featureOn = (source, key) => !!source.settings?.features?.[key];

export function setFeature(source, key, on) {
  const next = structuredClone(source);
  const settings = settingsOf(next);
  settings.features = { ...(settings.features ?? {}), [key]: !!on };
  return { source: next };
}

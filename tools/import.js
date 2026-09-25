// One-off migration from the household's existing data. ARCHITECTURE.md §12.
//
// Run once by the maintainer; not part of the app and never shipped to a
// device. Reads the reviewed source (data/recipes-data.reviewed.json) and
// writes data/library.json in the shape src/core/library.js expects, plus a
// report of everything that needed a human.
//
// data/library.json is public (it ships with the app as the seed library), so
// the CLI writes recipes and ingredients only. Trip history is household
// history and stays in the household's own OneDrive.
//
//   node tools/import.js [source.json]

import { readFileSync, writeFileSync } from 'node:fs';

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
    };
    if (!raw.shoppingUnit) report.referred.push({ kind: 'no-shopping-unit', name: raw.name });
    ingredients.push(ing);
    if (!byName.has(raw.name)) byName.set(raw.name, ing);
  }

  // Staples are a property of the ingredient, held separately from recipe and
  // Wait List membership; the three are never conflated (FR-STA-2).
  for (const name of settings.staples ?? []) {
    const ing = byName.get(name);
    if (!ing) { report.referred.push({ kind: 'unknown-staple', name }); continue; }
    ing.isStaple = true;
    ing.stapleQty = settings.stapleQty?.[name] ?? 1;
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
  const recipes = [];
  for (const raw of source.recipes) {
    const lines = [];
    for (const line of raw.ingredients ?? []) {
      const ing = byName.get(line.ingredientName);
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
      lines.push({
        ingredientId: ing.id,
        quantity,
        cookingUnit: line.displayUnit ?? null,
        displayQty: line.displayQty ?? null,
        displayUnit: line.displayUnit ?? null,
      });
    }
    recipes.push({
      id: raw.id, name: raw.name, category: raw.category ?? null,
      servings: raw.servings || 4, lines,
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

export function renderReport(report) {
  const group = (list) => {
    const by = new Map();
    for (const r of list) { if (!by.has(r.kind)) by.set(r.kind, []); by.get(r.kind).push(r); }
    return by;
  };
  let out = `# Import report\n\nGenerated ${new Date().toISOString()}\n\n## Counts\n\n`;
  for (const [k, v] of Object.entries(report.counts)) out += `- ${k}: ${v}\n`;
  out += `\n## Resolved automatically\n\n`;
  for (const [kind, items] of group(report.fixed)) {
    out += `### ${kind} (${items.length})\n\n`;
    for (const i of items.slice(0, 20)) out += `- ${JSON.stringify(i)}\n`;
    if (items.length > 20) out += `- ...and ${items.length - 20} more\n`;
    out += '\n';
  }
  out += `## Needs a human\n\n`;
  const referred = group(report.referred);
  if (referred.size === 0) out += 'Nothing.\n';
  for (const [kind, items] of referred) {
    out += `### ${kind} (${items.length})\n\n`;
    for (const i of items.slice(0, 20)) out += `- ${JSON.stringify(i)}\n`;
    if (items.length > 20) out += `- ...and ${items.length - 20} more\n`;
    out += '\n';
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = process.argv[2] ?? 'data/recipes-data.reviewed.json';
  const source = JSON.parse(readFileSync(src, 'utf8'));
  const { library, report } = importLibrary(source);
  delete library.trips;
  delete report.counts.trips;
  writeFileSync('data/library.json', JSON.stringify(library));
  writeFileSync('data/import-report.md', renderReport(report));
  console.log('wrote data/library.json and data/import-report.md');
  console.log(report.counts);
}

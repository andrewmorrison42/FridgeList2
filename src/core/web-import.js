// Import a recipe from a website. Pure.
//
// A web page cannot be fetched from here (the browser forbids reading another
// site), so the recipe arrives as pasted text: either what the Grab Recipe
// bookmark copies — the page's own structured recipe, as JSON — or the whole
// page, selected and copied. Both shapes are the earlier app's, and so is the
// bookmark: a household that set it up there can use it here unchanged.
//
// The result is a draft for the ordinary recipe editor, with each website
// line kept beside the row it became and the ingredient list's best matches
// offered, so a person decides every match. Nothing is saved until they do.

import { recipeToDraft, blankRow, findIngredient } from './recipes-format.js';

/** Copies the page's recipe as JSON. Identical to the earlier app's. */
export const GRAB_RECIPE_BOOKMARKLET = `javascript:(function(){function find(o){if(!o)return null;if(Array.isArray(o)){for(var i=0;i<o.length;i++){var r=find(o[i]);if(r)return r;}return null;}if(typeof o==='object'){var t=o['@type'];if(t==='Recipe'||(Array.isArray(t)&&t.indexOf('Recipe')>-1))return o;if(o['@graph'])return find(o['@graph']);}return null;}var rec=null,scripts=document.querySelectorAll('script[type=%22application/ld+json%22]');for(var i=0;i<scripts.length;i++){try{rec=find(JSON.parse(scripts[i].textContent));}catch(e){}if(rec)break;}if(!rec){alert('No structured recipe found on this page. Use Select All, Copy, and the paste box in The Fridge List instead.');return;}function clean(s){var d=document.createElement('div');d.innerHTML=s;return d.textContent.replace(/\\s+/g,' ').trim();}function steps(x){var out=[];(function w(v){if(!v)return;if(typeof v==='string'){var c=clean(v);if(c)out.push(c);}else if(Array.isArray(v)){v.forEach(w);}else if(typeof v==='object'){if(v.name&&v.itemListElement)out.push('— '+clean(v.name));if(v.text&&!v.itemListElement)out.push(clean(v.text));if(v.itemListElement)w(v.itemListElement);}})(x);return out;}var data={fridgeListImport:1,name:clean(String(rec.name||'')),servings:String(Array.isArray(rec.recipeYield)?rec.recipeYield[0]:(rec.recipeYield||'')),url:location.href,ingredients:(rec.recipeIngredient||rec.ingredients||[]).map(function(s){return clean(String(s));}),method:steps(rec.recipeInstructions)};var txt=JSON.stringify(data);navigator.clipboard.writeText(txt).then(function(){alert('Recipe %22'+data.name+'%22 copied ('+data.ingredients.length+' ingredients, '+data.method.length+' steps). Now paste it into The Fridge List import box.');},function(){prompt('Clipboard blocked - copy this manually, then paste into The Fridge List:',txt);});})();`;

/**
 * Read pasted text: the bookmark's JSON, or a copied page, found by its
 * "Ingredients" and "Method" headings.
 * @returns {{ name, servings, url, ingredients: string[], method: string[], weak? } | null}
 */
export function parseImportPaste(text) {
  text = String(text ?? '').trim();
  if (!text) return null;
  try {
    const j = JSON.parse(text);
    if (j && j.fridgeListImport) {
      return { name: j.name || '', servings: String(j.servings || ''), url: j.url || '',
        ingredients: j.ingredients || [], method: j.method || [] };
    }
  } catch { /* not the bookmark's JSON: read it as a page */ }
  const lines = text.split('\n').map((x) => x.trim());
  const lower = lines.map((x) => x.toLowerCase().replace(/[^a-z ]/g, '').trim());
  const findHead = (words) => lower.findIndex((l) => words.includes(l));
  const ingIdx = findHead(['ingredients', 'ingredient list']);
  const methIdx = findHead(['method', 'instructions', 'directions', 'steps', 'preparation']);
  let ingredients = [];
  let method = [];
  if (ingIdx > -1) {
    const end = methIdx > ingIdx ? methIdx : lines.length;
    ingredients = lines.slice(ingIdx + 1, end).filter(Boolean).filter((x) => x.length < 120);
  }
  if (methIdx > -1) {
    method = lines.slice(methIdx + 1).filter(Boolean).filter((x) => x.length > 3);
    const stop = method.findIndex((x) => /^(nutrition|notes|comments|reviews|you might also like|related recipes|rate this)/i.test(x));
    if (stop > -1) method = method.slice(0, stop);
  }
  const name = lines.find((l) => l && l.length > 2 && l.length < 90) ?? '';
  const sm = text.match(/serv(?:es|ings?)[:\s]*([0-9]+)|([0-9]+)\s*servings?/i);
  const servings = sm ? sm[1] || sm[2] || '' : '';
  return { name, servings, url: '', ingredients, method, weak: !ingredients.length && !method.length };
}

const GLYPHS = { '¼': ' 1/4', '½': ' 1/2', '¾': ' 3/4', '⅓': ' 1/3', '⅔': ' 2/3', '⅛': ' 1/8' };
const UNITS = [
  [/^(cups?|c)$/i, 'cup'], [/^(tablespoons?|tbsps?|tbs|tbl)$/i, 'TBsp'], [/^(teaspoons?|tsps?)$/i, 'tsp'],
  [/^(grams?|g|gm|gms)$/i, 'g', 1], [/^(kilograms?|kgs?)$/i, 'g', 1000],
  [/^(millilit(?:re|er)s?|ml|mls)$/i, 'mL', 1], [/^(lit(?:re|er)s?|l)$/i, 'mL', 1000],
];

/**
 * "2 ½ cups plain flour, sifted" → { qty: '2 ½', unit: 'cup', rest: 'plain flour, sifted' }.
 * "400g tin tomatoes" → { qty: '400', unit: 'g', ... }. "1kg chicken" → 1000 g.
 * Anything it cannot read is left for the person, never guessed.
 */
export function parseIngredientText(line) {
  let t = String(line ?? '').trim();
  for (const [g, v] of Object.entries(GLYPHS)) t = t.split(g).join(v);
  t = t.replace(/\s+/g, ' ').trim();
  // Longest first: "1 1/2", then "1/2", then "1.5" — or "1/2" reads as "1".
  const m = t.match(/^(\d+ \d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?)(?:\s*(?:-|–|to)\s*\d+(?:[.,]\d+)?)?\s*([a-zA-Z]+\b)?\.?\s*(.*)$/);
  if (!m) return { qty: '', unit: '', rest: String(line ?? '').trim() };
  const num = m[1].replace(',', '.').trim();
  const word = m[2] ?? '';
  const unit = UNITS.find(([re]) => re.test(word));
  if (!unit) return { qty: pretty(num), unit: '', rest: `${word} ${m[3]}`.trim() };
  const [, name, factor] = unit;
  if (factor) {
    const n = toNumber(num);
    return { qty: n === null ? pretty(num) : String(Math.round(n * factor)), unit: name, rest: m[3].trim() };
  }
  return { qty: pretty(num), unit: name, rest: m[3].trim() };
}

function toNumber(s) {
  const parts = s.split(/\s+/);
  let n = 0;
  for (const p of parts) {
    const f = p.match(/^(\d+)\/(\d+)$/);
    if (f) n += Number(f[1]) / Number(f[2]);
    else if (Number.isFinite(Number(p))) n += Number(p);
    else return null;
  }
  return n;
}

const FRACTION = { '1/4': '¼', '1/2': '½', '3/4': '¾', '1/3': '⅓', '2/3': '⅔', '1/8': '⅛' };
/** "2 1/2" → "2 ½", as the editor's measures are written. */
const pretty = (s) => s.replace(/(\d+)\/(\d+)/, (f) => FRACTION[f] ?? f).trim();

const STOPWORDS = new Set(('cup cups tsp tbsp tablespoon tablespoons teaspoon teaspoons gram grams kilogram '
  + 'of a an the and or to into for with finely freshly roughly thinly chopped sliced diced grated minced crushed peeled '
  + 'large small medium fresh ground extra plus more taste optional about approx can tin jar packet pkt bunch handful '
  + 'pinch clove cloves sprig sprigs stick sticks piece pieces halved quartered trimmed drained rinsed cut serve serving').split(' '));

/** The ingredient list's best matches for a website line, best first. As the earlier app scores them. */
export function suggestIngredients(source, line, max = 3) {
  const toks = String(line ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (!toks.length) return [];
  const scored = [];
  for (const ing of source.ingredients ?? []) {
    const nToks = String(ing.name ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
    if (!nToks.length) continue;
    let hit = 0;
    for (const nt of nToks) {
      if (toks.some((t) => t === nt || (t.length > 3 && nt.length > 3 && (t.startsWith(nt) || nt.startsWith(t))))) hit++;
    }
    if (hit) scored.push({ name: ing.name, score: hit / nToks.length + hit * 0.1 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.name);
}

/** A new-recipe draft from an import, for the editor. */
export function draftFromImport(source, parsed) {
  const draft = recipeToDraft(source, null);
  draft.name = parsed.name ?? '';
  const serves = parseInt(parsed.servings, 10);
  if (serves >= 1) draft.servings = String(serves);
  draft.sourceUrl = parsed.url ?? '';
  draft.origin = 'web';
  draft.method = (parsed.method ?? []).join('\n');
  draft.rows = (parsed.ingredients ?? []).map((text) => {
    const { qty, unit } = parseIngredientText(text);
    const suggestions = suggestIngredients(source, text, 3);
    // An exact match (bar case) is the ingredient; anything less is offered,
    // not assumed: "red onion" is not "Onion" in every kitchen.
    const exact = suggestions.find((n) => findIngredient(source, n) && text.toLowerCase().includes(n.toLowerCase()) && n.length > 3);
    return { ...blankRow(), web: text, suggestions, qty, unit, name: exact && suggestions[0] === exact ? exact : '' };
  });
  if (!draft.rows.length) draft.rows.push(blankRow());
  return draft;
}

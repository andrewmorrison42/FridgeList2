// A recipe as text to paste into an email or a message. Pure.
//
// The same layout as the earlier app's "Copy recipe": name, a line of
// category · serves · slow cooker, the ingredients (under their section
// headings), the method numbered (a "— heading" step restarts the numbering),
// notes, and where it came from. HTML for anywhere that takes formatting,
// plain text for everywhere else.

import { findIngredient } from './recipes-format.js';

/** "2 ¼ cup Rice: arborio, rinsed" · "300g Mushrooms" · "2 Leek". */
export function lineText(source, l) {
  const desc = l.descriptor ? `, ${l.descriptor}` : '';
  if (l.displayUnit && l.displayQty !== undefined && l.displayQty !== '') {
    return `${l.displayQty} ${l.displayUnit} ${l.ingredientName}${desc}`;
  }
  const unit = String(l.unit || findIngredient(source, l.ingredientName)?.shoppingUnit || '').trim();
  if (l.quantity === null || l.quantity === undefined || l.quantity === '') return `${l.ingredientName}${desc}`;
  if (unit && unit.toLowerCase() !== 'qty') return `${l.quantity}${unit} ${l.ingredientName}${desc}`;
  return `${l.quantity} ${l.ingredientName}${desc}`;
}

const subtitle = (r) => [r.category || 'Uncategorised', `serves ${r.servings || '?'}`, r.slowCooker && 'slow cooker']
  .filter(Boolean).join(' · ');

/** Walk the ingredients and method with their headings, for either format. */
function parts(source, r) {
  const groups = [];
  for (const l of r.ingredients ?? []) {
    const sec = l.section || '';
    if (!groups.length || groups.at(-1).heading !== sec) groups.push({ heading: sec, lines: [] });
    groups.at(-1).lines.push(lineText(source, l));
  }
  const steps = [];
  for (const m of r.method ?? []) {
    const h = String(m).match(/^—\s*(.+)$/);
    if (h) steps.push({ heading: h[1], items: [] });
    else {
      if (!steps.length) steps.push({ heading: '', items: [] });
      steps.at(-1).items.push(String(m));
    }
  }
  return { groups, steps };
}

export function recipeToText(source, r) {
  const { groups, steps } = parts(source, r);
  const out = [r.name, subtitle(r), '', 'INGREDIENTS'];
  if (!groups.length) out.push('(none listed)');
  groups.forEach((g, i) => {
    if (g.heading) { if (i) out.push(''); out.push(g.heading); }
    out.push(...g.lines);
  });
  out.push('', 'METHOD');
  if (!steps.some((s) => s.items.length)) out.push('(no method written down yet)');
  for (const s of steps) {
    if (s.heading) out.push('', s.heading);
    s.items.forEach((t, i) => out.push(`${i + 1}. ${t}`));
  }
  if (r.notes) out.push('', 'NOTES', r.notes);
  if (r.sourceUrl) out.push('', `From: ${r.sourceUrl}`);
  return out.join('\n');
}

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function recipeToHtml(source, r) {
  const { groups, steps } = parts(source, r);
  const out = ['<div>', `<h2>${esc(r.name)}</h2>`, `<p><em>${esc(subtitle(r))}</em></p>`, '<h3>Ingredients</h3>'];
  if (!groups.length) out.push('<p><em>(none listed)</em></p>');
  for (const g of groups) {
    if (g.heading) out.push(`<p><strong>${esc(g.heading)}</strong></p>`);
    out.push('<ul>', ...g.lines.map((t) => `<li>${esc(t)}</li>`), '</ul>');
  }
  out.push('<h3>Method</h3>');
  if (!steps.some((s) => s.items.length)) out.push('<p><em>(no method written down yet)</em></p>');
  for (const s of steps) {
    if (s.heading) out.push(`<p><strong>${esc(s.heading)}</strong></p>`);
    if (s.items.length) out.push('<ol>', ...s.items.map((t) => `<li>${esc(t)}</li>`), '</ol>');
  }
  if (r.notes) out.push('<h3>Notes</h3>', `<p>${esc(r.notes)}</p>`);
  if (r.sourceUrl) out.push(`<p>From: <a href="${esc(r.sourceUrl)}">${esc(r.sourceUrl)}</a></p>`);
  out.push('</div>');
  return out.join('');
}

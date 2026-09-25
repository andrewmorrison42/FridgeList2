// The recipe editor. FR-REC-2: anyone may edit any recipe at any time.
//
// The draft lives in app.ui.draft and typing writes straight into it, without a
// re-render: the screen is rebuilt from scratch on every render, and rebuilding
// under someone's thumb would lose their cursor. For the same reason, while a
// draft is open the background sync does not re-render (main.js). What typing
// changes about a line — which units apply, whether the ingredient is new — is
// swapped into that line in place. Buttons that change the shape of the form
// (add, remove, move) go through onAction and re-render as usual.
//
// Section headings are items in the list of lines, as in the earlier app:
// every line below a heading, to the next one, is in that section. So moving
// a line past a heading moves it into that section.

import { h } from './dom.js';
import { unitChoices, findIngredient, isHeading, CATEGORIES, aislesFor, SHOPPING_UNITS } from '../core/recipes-format.js';

const unitLabel = (u) => (!u || u === 'qty' ? 'each' : u);
const unitKey = (raw, row) => JSON.stringify(unitChoices(raw, row.name, row));
const isNew = (raw, row) => row.name.trim() !== '' && !findIngredient(raw, row.name);

/** The unit box for a row, settling its unit to one the ingredient allows. */
function unitControl(raw, row) {
  const choice = unitChoices(raw, row.name, row);
  const key = JSON.stringify(choice);
  if (choice.kind === 'choose') {
    if (!choice.options.includes(row.unit)) row.unit = choice.options[0];
    return h('select', { 'aria-label': 'Unit', dataset: { unit: key }, onChange: (e) => { row.unit = e.target.value; } },
      choice.options.map((u) => h('option', { value: u, selected: u === row.unit }, u)));
  }
  if (choice.kind === 'fixed') {
    row.unit = choice.unit;
    return h('span', { class: 'unit-fixed', title: 'Set by the ingredient list', dataset: { unit: key } }, unitLabel(choice.unit));
  }
  return h('input', { type: 'text', class: 'unit', placeholder: 'unit', value: row.unit, 'aria-label': 'Unit',
    dataset: { unit: key }, onInput: (e) => { row.unit = e.target.value; } });
}

/**
 * For an ingredient the list does not know yet: where it goes on the shopping
 * list, and how it is bought. Without these it would join the list as
 * uncategorised, to be sorted out later in Setup.
 */
function newIngredientBlock(raw, row, swapUnit, redraw) {
  if (!isNew(raw, row)) return h('div', { dataset: { alloc: 'known' } });
  const cat = row.newCategory ?? '';
  const aisles = cat ? aislesFor(raw, cat) : [];
  if (row.newAisle && !aisles.includes(row.newAisle)) row.newAisle = '';
  return h('div', { class: 'new-ing', dataset: { alloc: 'new' } },
    h('p', { class: 'hint' }, `New ingredient — where does “${row.name.trim()}” go on the shopping list?`),
    h('div', { class: 'alloc' },
      h('select', { 'aria-label': 'Category', onChange: (e) => { row.newCategory = e.target.value; redraw(); } },
        h('option', { value: '' }, '— category —'),
        CATEGORIES.map((c) => h('option', { value: c, selected: c === cat }, c))),
      h('select', { 'aria-label': 'Aisle', disabled: !cat, onChange: (e) => { row.newAisle = e.target.value; } },
        h('option', { value: '' }, '— aisle —'),
        aisles.map((a) => h('option', { value: a, selected: a === row.newAisle }, a))),
      h('select', { 'aria-label': 'Bought by', onChange: (e) => { row.newUnit = e.target.value; swapUnit(); } },
        h('option', { value: '' }, '— bought by —'),
        SHOPPING_UNITS.map((u) => h('option', { value: u.value, selected: u.value === row.newUnit }, u.label))),
    ),
  );
}

const moveButtons = (i, onAction) => [
  h('button', { class: 'ghost', title: 'Move up', 'aria-label': 'Move up', onClick: () => onAction('draftMove', i, -1) }, '▲'),
  h('button', { class: 'ghost', title: 'Move down', 'aria-label': 'Move down', onClick: () => onAction('draftMove', i, +1) }, '▼'),
];

function headingItem(item, i, onAction) {
  return h('div', { class: 'ing-heading' },
    h('input', { type: 'text', class: 'heading-name', value: item.heading, 'aria-label': 'Section heading',
      placeholder: 'Section heading (e.g. Icing) — or leave empty for no section',
      onInput: (e) => { item.heading = e.target.value; } }),
    moveButtons(i, onAction),
    h('button', { class: 'ghost', title: 'Remove this heading (its lines stay)', 'aria-label': 'Remove this heading',
      onClick: () => onAction('draftRemoveRow', i) }, '✕'),
  );
}

function lineItem(raw, row, i, onAction) {
  let unit = unitControl(raw, row);
  const swapUnit = () => { if (unit.dataset.unit !== unitKey(raw, row)) { const n = unitControl(raw, row); unit.replaceWith(n); unit = n; } };
  let alloc;
  const redrawAlloc = () => { const n = newIngredientBlock(raw, row, swapUnit, redrawAlloc); alloc.replaceWith(n); alloc = n; };
  alloc = newIngredientBlock(raw, row, swapUnit, redrawAlloc);
  const swapAlloc = () => { if (alloc.dataset.alloc !== (isNew(raw, row) ? 'new' : 'known')) redrawAlloc(); };

  return h('div', { class: 'ing-item' },
    // From a website import: the line as the site wrote it, and the ingredient
    // list's best guesses at what it is. The person chooses; nothing is assumed.
    row.web && h('p', { class: 'web-line' }, h('small', {}, 'From the website: '), row.web),
    row.suggestions?.length > 0 && h('div', { class: 'chips' },
      row.suggestions.map((name) => h('button', {
        class: `chip ${row.name === name ? 'on' : ''}`, onClick: () => onAction('draftPick', i, name),
      }, name))),
    // The ingredient and its controls on one line; how much, and how used, on
    // the next — so on a phone nothing wraps onto a third.
    h('div', { class: 'ing-row' },
      h('div', { class: 'ing-line' },
        h('input', {
          type: 'text', class: 'ing-name', list: 'ingredient-names', placeholder: 'Ingredient',
          value: row.name, 'aria-label': 'Ingredient', autocomplete: 'off',
          onInput: (e) => { row.name = e.target.value; swapUnit(); swapAlloc(); },
        }),
        moveButtons(i, onAction),
        h('button', { class: 'ghost', title: 'Remove this line', 'aria-label': 'Remove this line',
          onClick: () => onAction('draftRemoveRow', i) }, '✕'),
      ),
      h('div', { class: 'ing-line' },
        h('input', { type: 'text', class: 'ing-qty', inputmode: 'decimal', placeholder: 'Amount',
          value: row.qty, 'aria-label': 'Amount', onInput: (e) => { row.qty = e.target.value; } }),
        unit,
        h('input', { type: 'text', class: 'ing-desc', placeholder: 'How used',
          value: row.descriptor, 'aria-label': 'How used', onInput: (e) => { row.descriptor = e.target.value; } }),
      ),
    ),
    alloc,
  );
}

export function editorView(app, { onAction }) {
  const d = app.ui.draft;
  const raw = app.recipes.raw;
  const set = (key) => (e) => { d[key] = e.target.value; };
  const tick = (key) => (e) => { d[key] = e.target.checked; };

  return h('section', { class: 'editor' },
    h('h1', {}, d.id ? 'Edit recipe' : d.origin === 'web' ? 'Imported recipe — check it over' : 'New recipe'),
    d.origin === 'web' && h('p', { class: 'hint' },
      'Each line shows what the website said. Tap the matching ingredient (or type one), check the amount, then Save.'),

    d.conflict && h('div', { class: 'refusal' },
      h('p', {}, 'Someone changed this recipe on another device while you were editing it. ',
        'Nothing has been saved.'),
      h('div', { class: 'actions' },
        h('button', { onClick: () => onAction('draftReopen') }, 'Start again from their version'),
        h('button', { onClick: () => onAction('draftOverride') }, 'Save mine over theirs'),
      ),
    ),
    d.error && h('p', { class: 'warn-text' }, d.error),

    h('label', { class: 'field' }, h('span', {}, 'Recipe name'),
      h('input', { type: 'text', value: d.name, onInput: set('name') })),
    h('label', { class: 'field' }, h('span', {}, 'Category'),
      h('input', { type: 'text', value: d.category, list: 'recipe-categories', placeholder: 'e.g. Vegetable, Dessert, Meat (Red)', onInput: set('category') })),
    h('datalist', { id: 'recipe-categories' },
      [...new Set((raw?.recipes ?? []).map((r) => r.category).filter(Boolean))].sort().map((c) => h('option', { value: c }))),
    h('label', { class: 'field' }, h('span', {}, 'Serves'),
      h('input', { type: 'number', min: '1', inputmode: 'numeric', value: d.servings, onInput: set('servings') })),
    h('div', { class: 'flags' },
      h('label', {}, h('input', { type: 'checkbox', checked: d.slowCooker, onChange: tick('slowCooker') }), 'Slow cooker'),
      h('label', {}, h('input', { type: 'checkbox', checked: d.inSeason, onChange: tick('inSeason') }), 'In season'),
    ),
    h('label', { class: 'field' }, h('span', {}, 'Source website'),
      h('input', { type: 'url', inputmode: 'url', value: d.sourceUrl ?? '', placeholder: 'https://…', autocapitalize: 'off',
        onInput: set('sourceUrl') })),

    h('h2', {}, 'Ingredients'),
    h('p', { class: 'hint' },
      'Pick an ingredient already in the book to keep its aisle on the shopping list. ',
      'For a new one, say where it goes and how it is bought. ▲ ▼ move a line; moving it past a heading puts it in that section.'),
    h('datalist', { id: 'ingredient-names' },
      (raw?.ingredients ?? []).map((i) => h('option', { value: i.name }))),

    h('div', { class: 'ing-rows' }, d.rows.map((item, i) => (isHeading(item)
      ? headingItem(item, i, onAction)
      : lineItem(raw, item, i, onAction)))),
    h('div', { class: 'actions' },
      h('button', { onClick: () => onAction('draftAddRow') }, '+ Add ingredient'),
      h('button', { onClick: () => onAction('draftAddHeading') }, '+ Add section heading'),
    ),

    h('h2', {}, 'Method'),
    h('p', { class: 'hint' }, 'One step per line. Start a line with — for a heading.'),
    h('textarea', { rows: '8', onInput: set('method') }, d.method),

    h('h2', {}, 'Notes'),
    h('textarea', { rows: '3', onInput: set('notes') }, d.notes),

    h('div', { class: 'actions' },
      h('button', { class: 'primary', disabled: d.saving, onClick: () => onAction('draftSave') },
        d.saving ? 'Saving…' : 'Save recipe'),
      h('button', { disabled: d.saving, onClick: () => onAction('draftCancel') }, 'Cancel'),
      d.id && h('button', { class: 'danger', disabled: d.saving, onClick: () => onAction('draftDelete') }, 'Delete recipe'),
    ),
    app.recipes.mode === 'file' && h('p', { class: 'hint' },
      `Saves to ${app.recipes.path}. Only this recipe is written; changes made elsewhere to other recipes are kept.`),
  );
}

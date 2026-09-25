// The recipe editor. FR-REC-2: anyone may edit any recipe at any time.
//
// The draft lives in app.ui.draft and typing writes straight into it, without a
// re-render: the screen is rebuilt from scratch on every render, and rebuilding
// under someone's thumb would lose their cursor. For the same reason, while a
// draft is open the background sync does not re-render (main.js). Actions that
// change the shape of the form — adding or removing a line, choosing an
// ingredient — go through onAction and re-render as usual.

import { h } from './dom.js';
import { unitChoices } from '../core/recipes-format.js';

const unitLabel = (u) => (!u || u === 'qty' ? 'each' : u);

export function editorView(app, { onAction }) {
  const d = app.ui.draft;
  const raw = app.recipes.raw;
  const set = (key) => (e) => { d[key] = e.target.value; };

  return h('section', { class: 'editor' },
    h('h1', {}, d.id ? 'Edit recipe' : 'New recipe'),

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
      h('input', { type: 'text', value: d.category, placeholder: 'e.g. Vegetable, Dessert, Meat (Red)', onInput: set('category') })),
    h('label', { class: 'field' }, h('span', {}, 'Serves'),
      h('input', { type: 'number', min: '1', inputmode: 'numeric', value: d.servings, onInput: set('servings') })),

    h('h2', {}, 'Ingredients'),
    h('p', { class: 'hint' },
      'Pick an ingredient already in the book to keep its aisle on the shopping list. ',
      'Anything new is added to the ingredient list as uncategorised.'),
    h('datalist', { id: 'ingredient-names' },
      (raw?.ingredients ?? []).map((i) => h('option', { value: i.name }))),

    h('div', { class: 'ing-rows' }, d.rows.map((row, i) => {
      const heading = row.section && row.section !== d.rows[i - 1]?.section
        ? h('h3', {}, row.section) : null;
      const choice = unitChoices(raw, row.name);
      const unit = choice.kind === 'choose'
        ? h('select', {
            'aria-label': 'Unit',
            onChange: (e) => { row.unit = e.target.value; },
          }, choice.options.map((u) => h('option', { value: u, selected: u === row.unit }, u)))
        : choice.kind === 'fixed'
          ? h('span', { class: 'unit-fixed', title: 'Set by the ingredient list' }, unitLabel(choice.unit))
          : h('input', { type: 'text', class: 'unit', placeholder: 'unit', value: row.unit,
              'aria-label': 'Unit', onInput: (e) => { row.unit = e.target.value; } });

      return [heading, h('div', { class: 'ing-row' },
        h('input', {
          type: 'text', class: 'ing-name', list: 'ingredient-names', placeholder: 'Ingredient',
          value: row.name, 'aria-label': 'Ingredient',
          onInput: (e) => { row.name = e.target.value; },
          // Choosing a name decides which units apply, so the row is redrawn.
          onChange: () => onAction('draftRowName', i),
        }),
        h('input', { type: 'text', class: 'ing-qty', inputmode: 'decimal', placeholder: 'Amount',
          value: row.qty, 'aria-label': 'Amount', onInput: (e) => { row.qty = e.target.value; } }),
        unit,
        h('input', { type: 'text', class: 'ing-desc', placeholder: 'How used',
          value: row.descriptor, 'aria-label': 'How used', onInput: (e) => { row.descriptor = e.target.value; } }),
        h('button', { class: 'ghost', title: 'Remove this line', 'aria-label': 'Remove this line',
          onClick: () => onAction('draftRemoveRow', i) }, '✕'),
      )];
    })),
    h('button', { onClick: () => onAction('draftAddRow') }, '+ Add ingredient'),

    h('h2', {}, 'Method'),
    h('p', { class: 'hint' }, 'One step per line. Start a line with — for a heading.'),
    h('textarea', { rows: '8', onInput: set('method') }, d.method),

    h('h2', {}, 'Notes'),
    h('textarea', { rows: '3', onInput: set('notes') }, d.notes),

    h('div', { class: 'actions' },
      h('button', { class: 'primary', disabled: d.saving, onClick: () => onAction('draftSave') },
        d.saving ? 'Saving…' : 'Save recipe'),
      h('button', { disabled: d.saving, onClick: () => onAction('draftCancel') }, 'Cancel'),
    ),
    app.recipes.mode === 'file' && h('p', { class: 'hint' },
      `Saves to ${app.recipes.path}. Only this recipe is written; changes made elsewhere to other recipes are kept.`),
  );
}

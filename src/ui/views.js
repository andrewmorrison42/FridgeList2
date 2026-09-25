// The four screens: plan, list, wait list, recipes.
//
// Every one renders from derived state and is re-rendered by the store on any
// change (FR-SYNC-7). None reads state once and keeps it; there is no
// pull-to-refresh anywhere in this app.

import { h } from './dom.js';
import { groupForDisplay } from '../core/generate.js';
import { formatQuantity } from '../core/units.js';
import { sinceLabel } from '../core/library.js';
import { PLANNED, CARRIED, FLAGGED, COOKED } from '../core/carryover.js';
import { refusal } from './status.js';
import { editorView } from './editor.js';

/**
 * A search box whose results redraw beneath it. The box itself is never
 * rebuilt while someone types in it: phone keyboards build each word in
 * stages (composition), and a replaced box loses the word half-built — the
 * letters vanish, or come back doubled.
 */
function searchWithResults({ value, placeholder, onSearch, results }) {
  let list = h('div', {}, results(value));
  const box = h('input', {
    type: 'search', placeholder, value,
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
    onInput: (e) => {
      onSearch(e.target.value);
      const next = h('div', {}, results(e.target.value));
      list.replaceWith(next);
      list = next;
    },
  });
  return [box, list];
}

/** Say so when a list is cut short, so a missing recipe reads as "search for it". */
const moreHint = (shown, total) => shown < total &&
  h('p', { class: 'hint' }, `Showing ${shown} of ${total}. Search to find the rest.`);

const STATUS_LABEL = { [PLANNED]: 'Planned', [CARRIED]: 'Carried over', [FLAGGED]: 'Needs a decision', [COOKED]: 'Cooked' };

// -- Plan -------------------------------------------------------------------

export function planView(app, { onAction }) {
  if (!app.can.canEditMenu) return refusal(app, 'canEditMenu', onAction) ?? h('p', {}, 'The menu is locked.');

  const { recipes } = app.library;
  const sels = app.selections;
  const history = app.history;
  const search = app.ui.search ?? '';

  const chosen = [...sels.values()].sort((a, b) => a.recipeId.localeCompare(b.recipeId));
  const results = (q) => {
    const all = [...recipes.values()]
      .filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    const matches = all.slice(0, 60);
    return [
      h('ul', { class: 'picker' },
        matches.map((r) => h('li', {},
          h('div', { class: 'grow' },
            h('strong', {}, r.name),
            // The cook-history signal belongs where recipes are chosen, not only
            // in a separate history view (FR-REC-4).
            h('span', { class: 'since' }, sinceLabel(history.get(r.id))),
          ),
          h('button', { onClick: () => onAction('plan', r.id, r.servings) }, 'Add'),
        )),
      ),
      moreHint(matches.length, all.length),
    ];
  };

  return h('section', {},
    h('h1', {}, "This week's menu"),

    chosen.length > 0 && h('ul', { class: 'chosen' },
      chosen.map((sel) => {
        const recipe = recipes.get(sel.recipeId);
        return h('li', { class: `sel ${sel.status}` },
          h('div', { class: 'grow' },
            h('strong', {}, recipe?.name ?? sel.recipeId),
            h('span', { class: 'status' }, STATUS_LABEL[sel.status]),
            // A Flagged entry has carried once already and must be resolved,
            // not carried silently again (FR-MENU-5).
            sel.status === FLAGGED && h('span', { class: 'nudge' },
              'Cook it, remove it, or plan it again'),
          ),
          h('span', { class: 'servings' }, `${sel.servings}`),
          sel.status !== COOKED && h('button', { onClick: () => onAction('cooked', sel.recipeId) }, 'Cooked'),
          h('button', { onClick: () => onAction('unplan', sel.recipeId) }, 'Remove'),
        );
      }),
    ),

    h('h2', {}, 'Add a recipe'),
    searchWithResults({
      value: search, placeholder: 'Search recipes', results,
      onSearch: (q) => { app.ui.search = q; },
    }),
  );
}

// -- Shopping list ----------------------------------------------------------

export function listView(app, { onAction }) {
  const { id, phase } = app.shop;
  const { lines, carryOver, problems } = app.list();
  const suppressed = (ingredientId) => app.store.get(`line:${id}:${ingredientId}:suppressed`) === true;
  const visible = lines.filter((l) => !suppressed(l.ingredientId));
  const done = (l) => app.store.get(`line:${id}:${l.ingredientId}:done`) === true;

  const categoryOrder = ['Fruit and Vegetables', 'Meat', 'Cold', 'Pantry', 'Toiletries', 'Other'];
  const grouped = groupForDisplay(visible, { categoryOrder });
  const remaining = visible.filter((l) => !done(l)).length;

  return h('section', { class: 'list' },
    h('h1', {}, phase === 'draft' ? 'Shopping list (planning)' : 'Shopping list'),
    h('p', { class: 'count' }, `${remaining} of ${visible.length} to get`),

    phase === 'draft' && h('p', { class: 'hint' },
      'Remove anything already in the pantry. Once shopping starts, nothing can be removed — only added.'),

    // Carried over — check before buying. A prompt, not a gate: neither action
    // is required before the list can be used (FR-MENU-7.2).
    carryOver.length > 0 && h('div', { class: 'carry' },
      h('h2', {}, 'Carried over — check before buying'),
      h('p', { class: 'hint' },
        'These were for a meal you did not cook. You may still have them, or they may have gone into something else.'),
      h('ul', {}, carryOver.map((l) => h('li', {},
        h('span', { class: 'grow' }, l.name, ' ', h('small', {}, formatQuantity(l.qty, l.unit))),
        h('button', { onClick: () => onAction('addLine', l.ingredientId) }, 'Still need it'),
        h('button', { onClick: () => onAction('dismiss', l.ingredientId) }, 'Have it'),
      ))),
    ),

    grouped.map((group) => h('div', { class: 'group' },
      h('h2', {}, group.category),                       // category as header
      group.aisles.map((a) => h('div', { class: 'aisle' },
        h('h3', {}, a.aisle),                            // aisle as subheading
        h('ul', {}, a.lines.map((l) => h('li', { class: done(l) ? 'done' : '' },
          h('label', {},
            h('input', {
              type: 'checkbox', checked: done(l), disabled: !app.can.canTick,
              onChange: (e) => onAction('tick', l.ingredientId, e.target.checked),
            }),
            h('span', { class: 'name' }, l.name),
            h('span', { class: 'qty' }, formatQuantity(l.qty, l.unit)),
          ),
          // A preference note is shown only where it matters (FR-ING-3/4).
          l.preference && h('span', { class: 'pref' }, l.preference),
          app.can.canRemoveLines && h('button', {
            class: 'ghost', onClick: () => onAction('suppress', l.ingredientId),
          }, 'Have it'),
        ))),
      )),
    )),

    problems.length > 0 && h('div', { class: 'problems' },
      h('h2', {}, 'Needs attention'),
      h('ul', {}, problems.map((p) => h('li', {}, `${p.kind}: ${p.ingredientId ?? p.recipeId}`))),
    ),
  );
}

// -- Wait list --------------------------------------------------------------

export function waitListView(app, { onAction }) {
  const { ingredients } = app.library;
  const items = app.waitList();
  const search = app.ui.waitSearch ?? '';
  const results = (q) => {
    const matches = q
      ? [...ingredients.values()].filter((i) => i.name.toLowerCase().includes(q.toLowerCase())).slice(0, 12)
      : [];
    return matches.length > 0 && h('ul', { class: 'picker' },
      matches.map((i) => h('li', {},
        h('span', { class: 'grow' }, i.name),
        h('button', { onClick: () => onAction('addWait', i.id) }, 'Add'),
      )),
    );
  };

  return h('section', {},
    h('h1', {}, 'Wait list'),
    h('p', { class: 'hint' },
      'Anything running low. It stays here until it is bought or removed — a week ending never clears it.'),

    searchWithResults({
      value: search, placeholder: 'Add something running low', results,
      onSearch: (q) => { app.ui.waitSearch = q; },
    }),

    items.length === 0
      ? h('p', { class: 'empty' }, 'Nothing waiting.')
      : h('ul', { class: 'waitlist' }, items.map((item) => h('li', {},
          h('span', { class: 'grow' }, ingredients.get(item.ingredientId)?.name ?? item.ingredientId),
          item.note && h('small', {}, item.note),
          h('button', { onClick: () => onAction('removeWait', item.id) }, 'Remove'),
        ))),
  );
}

// -- Recipes ----------------------------------------------------------------

/** "2 ¼ cup", "300 g", "2" — as the cook measures it, not as the shop sells it. */
function lineAmount(l, ing) {
  if (l.displayUnit) return `${l.displayQty} ${l.displayUnit}`;
  const unit = ing?.shoppingUnit && ing.shoppingUnit !== 'qty' ? ` ${ing.shoppingUnit}` : '';
  return `${l.quantity}${unit}`;
}

export function recipesView(app, { onAction }) {
  if (app.ui.draft) return editorView(app, { onAction });

  const { recipes, ingredients } = app.library;
  const history = app.history;
  const open = app.ui.openRecipe;
  const search = app.ui.recipeSearch ?? '';
  const rs = app.recipes.status();

  if (open && recipes.has(open)) {
    const r = recipes.get(open);
    let section = null;
    return h('section', {},
      h('div', { class: 'actions' },
        h('button', { onClick: () => onAction('openRecipe', null) }, '← All recipes'),
        h('button', { onClick: () => onAction('editRecipe', r.id) }, 'Edit'),
      ),
      h('h1', {}, r.name),
      h('p', { class: 'hint' }, `Serves ${r.servings} · last chosen ${sinceLabel(history.get(r.id))}`),
      h('h2', {}, 'Ingredients'),
      h('ul', {}, (r.lines ?? []).map((l) => {
        const ing = ingredients.get(l.ingredientId);
        const heading = l.section && l.section !== section ? h('h3', {}, l.section) : null;
        section = l.section;
        return [heading, h('li', {},
          h('span', { class: 'grow' }, `${lineAmount(l, ing)} ${ing?.name ?? l.ingredientId}`,
            l.descriptor && h('small', {}, `, ${l.descriptor}`)),
        )];
      })),
      r.method?.length > 0 && h('div', {},
        h('h2', {}, 'Method'),
        h('ol', {}, r.method.map((step) => h('li', {}, step))),
      ),
      r.notes && h('div', {}, h('h2', {}, 'Notes'), h('p', {}, r.notes)),
    );
  }

  const results = (q) => {
    const all = [...recipes.values()]
      .filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
    const matches = all.slice(0, 80);
    return [
      h('ul', { class: 'picker' }, matches.map((r) => h('li', {},
        h('button', { class: 'link grow', onClick: () => onAction('openRecipe', r.id) }, r.name),
        h('span', { class: 'since' }, sinceLabel(history.get(r.id))),
      ))),
      moreHint(matches.length, all.length),
    ];
  };

  return h('section', {},
    h('div', { class: 'title-row' },
      h('h1', {}, 'Recipes'),
      app.recipes.raw && h('button', { onClick: () => onAction('newRecipe') }, '+ New recipe'),
    ),
    // Never show a saved copy as if it were current (FR-SYNC-2).
    rs.state === 'error' && h('p', { class: 'warn-text' },
      `Showing the copy saved on this device — couldn't check ${rs.path} for changes.`),
    rs.state === 'missing' && h('p', { class: 'warn-text' },
      `There is no recipe file at ${rs.path}. See Setup.`),
    searchWithResults({
      value: search, placeholder: `Search ${recipes.size} recipes`, results,
      onSearch: (q) => { app.ui.recipeSearch = q; },
    }),
  );
}

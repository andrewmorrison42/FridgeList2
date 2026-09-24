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
import { K } from '../core/keys.js';

const STATUS_LABEL = { [PLANNED]: 'Planned', [CARRIED]: 'Carried over', [FLAGGED]: 'Needs a decision', [COOKED]: 'Cooked' };

// -- Plan -------------------------------------------------------------------

export function planView(app, { onAction }) {
  if (!app.can.canEditMenu) return refusal(app, 'canEditMenu', onAction) ?? h('p', {}, 'The menu is locked.');

  const { recipes } = app.library;
  const sels = app.selections;
  const history = app.history;
  const search = app.ui.search ?? '';

  const chosen = [...sels.values()].sort((a, b) => a.recipeId.localeCompare(b.recipeId));
  const matches = [...recipes.values()]
    .filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 60);

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
    h('input', {
      type: 'search', placeholder: 'Search recipes', value: search,
      onInput: (e) => onAction('search', e.target.value),
    }),
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
  );
}

// -- Shopping list ----------------------------------------------------------

export function listView(app, { onAction }) {
  const { id, phase } = app.shop;
  // The list arrives fully derived — suppression, additions and the lock
  // snapshot already applied in core. A view renders; it does not decide.
  const { lines: visible, carryOver, problems } = app.list();
  const done = (l) => app.store.get(K.lineDone(id, l.ingredientId)) === true;

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
          // Something joined this line after the list locked. If it was already
          // ticked, the quantity may now be short — say so rather than let a
          // tick silently cover less than the list asks for (§5.7).
          l.addedAfterLock && h('span', { class: 'after-lock' },
            done(l) ? 'more needed since ticked' : 'added during shop'),
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
  const matches = search
    ? [...ingredients.values()].filter((i) => i.name.toLowerCase().includes(search.toLowerCase())).slice(0, 12)
    : [];

  return h('section', {},
    h('h1', {}, 'Wait list'),
    h('p', { class: 'hint' },
      'Anything running low. It stays here until it is bought or removed — a week ending never clears it.'),

    h('input', {
      type: 'search', placeholder: 'Add something running low', value: search,
      onInput: (e) => onAction('waitSearch', e.target.value),
    }),
    matches.length > 0 && h('ul', { class: 'picker' },
      matches.map((i) => h('li', {},
        h('span', { class: 'grow' }, i.name),
        h('button', { onClick: () => onAction('addWait', i.id) }, 'Add'),
      )),
    ),

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

export function recipesView(app, { onAction }) {
  const { recipes, ingredients } = app.library;
  const history = app.history;
  const open = app.ui.openRecipe;
  const search = app.ui.recipeSearch ?? '';

  if (open && recipes.has(open)) {
    const r = recipes.get(open);
    return h('section', {},
      h('button', { onClick: () => onAction('openRecipe', null) }, '← All recipes'),
      h('h1', {}, r.name),
      h('p', { class: 'hint' }, `Serves ${r.servings} · last chosen ${sinceLabel(history.get(r.id))}`),
      h('h2', {}, 'Ingredients'),
      h('ul', {}, (r.lines ?? []).map((l) => h('li', {},
        `${l.displayQty ?? l.quantity} ${l.displayUnit ?? l.cookingUnit ?? ''} `,
        ingredients.get(l.ingredientId)?.name ?? l.ingredientId,
      ))),
      r.method?.length > 0 && h('div', {},
        h('h2', {}, 'Method'),
        h('ol', {}, r.method.map((step) => h('li', {}, step))),
      ),
    );
  }

  const matches = [...recipes.values()]
    .filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 80);

  return h('section', {},
    h('h1', {}, 'Recipes'),
    h('input', {
      type: 'search', placeholder: `Search ${recipes.size} recipes`, value: search,
      onInput: (e) => onAction('recipeSearch', e.target.value),
    }),
    h('ul', { class: 'picker' }, matches.map((r) => h('li', {},
      h('button', { class: 'link grow', onClick: () => onAction('openRecipe', r.id) }, r.name),
      h('span', { class: 'since' }, sinceLabel(history.get(r.id))),
    ))),
  );
}

// The four screens: plan, list, wait list, recipes.
//
// Every one renders from derived state and is re-rendered by the store on any
// change (FR-SYNC-7). None reads state once and keeps it; there is no
// pull-to-refresh anywhere in this app.

import { h } from './dom.js';
import { groupForDisplay } from '../core/generate.js';
import { formatQuantity, describeRecipeLine } from '../core/units.js';
import { sinceLabel } from '../core/library.js';
import { PLANNED, CARRIED, FLAGGED, COOKED } from '../core/carryover.js';
import { refusal } from './status.js';
import { K } from '../core/keys.js';

// What each status means to a person. "Carried over" was accurate and
// misleading: straight after a shop is completed, the meals just bought read as
// carried over before anyone had started planning the next week (glitch #15).
const STATUS_LABEL = {
  [PLANNED]: 'Planned',
  [CARRIED]: 'Bought last shop · not cooked yet',
  [FLAGGED]: 'Bought two shops ago — cook it, remove it, or plan it again',
  [COOKED]: 'Cooked',
};

// -- Plan -------------------------------------------------------------------

/**
 * The menu, laid out the way the household's week runs: meals already bought
 * and waiting to be cooked, then meals planned for the next shop.
 *
 * During a shop the menu is settled (FR-SHOP-3), but it stays visible — a meal
 * can still be marked cooked (FR-MENU-2), which the screen used to hide behind
 * the refusal (glitch #20).
 */
export function planView(app, { onAction }) {
  const { recipes } = app.library;
  const shopId = app.shop.id;
  const editable = app.can.canEditMenu;
  const history = app.history;
  const search = app.ui.search ?? '';
  const name = (id) => recipes.get(id)?.name ?? id;
  const byName = (a, b) => name(a.recipeId).localeCompare(name(b.recipeId));

  const sels = [...app.selections.values()];
  const toCook = sels.filter((s) => s.plannedFor !== shopId).sort(byName);
  const planned = sels.filter((s) => s.plannedFor === shopId).sort(byName);

  const row = (sel) => h('li', { class: `sel ${sel.status}` },
    h('div', { class: 'grow' },
      h('strong', {}, name(sel.recipeId)),
      h('span', { class: 'sel-status' }, STATUS_LABEL[sel.status]),
    ),
    // How many it is for (FR-MENU-1), adjustable while it is still being
    // planned; a meal already bought is re-planned to change it.
    editable && sel.status === PLANNED
      ? h('span', { class: 'stepper', 'aria-label': 'servings' },
          h('button', { class: 'step', 'aria-label': 'fewer', disabled: sel.servings <= 1,
            onClick: () => onAction('servings', sel.recipeId, sel.plannedFor, sel.servings - 1) }, '−'),
          h('span', { class: 'servings' }, `${sel.servings}`),
          h('button', { class: 'step', 'aria-label': 'more',
            onClick: () => onAction('servings', sel.recipeId, sel.plannedFor, sel.servings + 1) }, '+'))
      : h('span', { class: 'servings', title: 'servings' }, `for ${sel.servings}`),
    sel.status !== COOKED && h('button', { onClick: () => onAction('cooked', sel.recipeId, sel.plannedFor) }, 'Cooked'),
    editable && h('button', { onClick: () => onAction('unplan', sel.recipeId, sel.plannedFor) }, 'Remove'),
  );

  const matches = [...recipes.values()]
    .filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 60);

  return h('section', {},
    !editable && refusal(app, 'canEditMenu', onAction),

    toCook.length > 0 && h('div', {},
      h('h1', {}, 'To cook — already bought'),
      h('ul', { class: 'chosen' }, toCook.map(row)),
    ),

    h('h1', {}, app.shop.phase === 'open' ? 'Being bought now' : 'Planned for the next shop'),
    planned.length === 0
      ? h('p', { class: 'empty' }, editable ? 'Nothing planned yet — add a recipe below.' : 'Nothing was planned for this shop.')
      : h('ul', { class: 'chosen' }, planned.map(row)),

    editable && h('div', {},
      h('h2', {}, 'Add a recipe'),
      h('input', {
        type: 'search', placeholder: 'Search recipes', value: search, dataset: { key: 'plan-search' },
        onInput: (e) => onAction('search', e.target.value),
      }),
      h('ul', { class: 'picker' },
        matches.map((r) => h('li', {},
          h('div', { class: 'grow' },
            h('strong', {}, r.name),
            // The cook-history signal belongs where recipes are chosen, not
            // only in a separate history view (FR-REC-4).
            h('span', { class: 'since' }, sinceLabel(history.get(r.id))),
          ),
          h('button', { onClick: () => onAction('plan', r.id, r.servings) }, 'Add'),
        )),
      ),
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

  // On the fridge door, a list with no date could be any week's (glitch #19).
  const printed = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  return h('section', { class: 'list' },
    h('h1', {}, phase === 'draft' ? 'Shopping list (planning)' : 'Shopping list'),
    h('p', { class: 'print-only' }, `Printed ${printed}`),
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
          // A preference note is shown only where it matters (FR-ING-3/4),
          // and a Wait List note travels with the item (FR-WAIT-1).
          l.preference && h('span', { class: 'pref' }, l.preference),
          l.notes?.length > 0 && h('span', { class: 'pref' }, l.notes.join(' · ')),
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
      h('p', { class: 'hint' }, 'These could not be added to the list. Everything else is complete.'),
      h('ul', {}, problems.map((p) => h('li', {}, describeProblem(app, p)))),
    ),
  );
}

/** A data problem, in words a person can fix. */
function describeProblem(app, p) {
  const recipe = p.recipeId ? (app.library.recipes.get(p.recipeId)?.name ?? p.recipeId) : null;
  switch (p.kind) {
    case 'missing-conversion':
      return `${recipe}: no way to convert "${p.unit}" of ${p.name} into what it is bought in.`;
    case 'no-servings':        return `${recipe}: has no servings number, so it cannot be scaled.`;
    case 'unknown-recipe':     return `A planned recipe no longer exists (${p.recipeId}).`;
    case 'unknown-ingredient': return `${recipe ?? 'A line'} uses an ingredient that no longer exists (${p.ingredientId}).`;
    default:                   return `${p.kind}: ${p.ingredientId ?? p.recipeId ?? ''}`;
  }
}

// -- Wait list --------------------------------------------------------------

export function waitListView(app, { onAction }) {
  const { ingredients } = app.library;
  const items = app.waitList();
  const search = app.ui.waitSearch ?? '';
  const note = app.ui.waitNote ?? '';
  const typed = search.trim();
  const matches = typed
    ? [...ingredients.values()].filter((i) => i.name.toLowerCase().includes(typed.toLowerCase())).slice(0, 12)
    : [];
  // Offered whenever what was typed is not exactly an ingredient: searching
  // for something the list does not know used to be a dead end.
  const exact = matches.some((i) => i.name.toLowerCase() === typed.toLowerCase());
  const nameOf = (item) => item.name ?? ingredients.get(item.ingredientId)?.name ?? item.ingredientId;

  return h('section', {},
    h('h1', {}, 'Wait list'),
    h('p', { class: 'hint' },
      'Anything running low. It stays here until it is bought or removed — a week ending never clears it.'),

    h('input', {
      type: 'search', placeholder: 'Add something running low', value: search, dataset: { key: 'wait-search' },
      onInput: (e) => onAction('waitSearch', e.target.value),
    }),
    typed && h('input', {
      type: 'text', placeholder: 'Note (optional) — e.g. the big bag', value: note, dataset: { key: 'wait-note' },
      class: 'note-input', onInput: (e) => onAction('waitNote', e.target.value),
    }),
    typed && h('ul', { class: 'picker' },
      matches.map((i) => h('li', {},
        h('span', { class: 'grow' }, i.name),
        h('button', { onClick: () => onAction('addWait', i.id) }, 'Add'),
      )),
      !exact && h('li', {},
        h('span', { class: 'grow' }, `“${typed}”`, h('small', { class: 'since' }, 'not in the ingredient list')),
        h('button', { onClick: () => onAction('addWaitText', typed) }, 'Add'),
      ),
    ),

    items.length === 0
      ? h('p', { class: 'empty' }, 'Nothing waiting.')
      : h('ul', { class: 'waitlist' }, items.map((item) => h('li', {},
          h('div', { class: 'grow' }, h('span', {}, nameOf(item)), item.note && h('small', { class: 'since' }, item.note)),
          // Offered only when it will work. During a shop nothing can be
          // removed (§5.9); showing the button anyway made it throw (glitch #8).
          app.can.canRemoveWaitList && h('button', { onClick: () => onAction('removeWait', item.id) }, 'Remove'),
        ))),
    items.length > 0 && !app.can.canRemoveWaitList && h('p', { class: 'hint' },
      'During a shop the Wait List only grows. Anything bought comes off it automatically when the shop is completed.'),
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
      h('ul', {}, (r.lines ?? []).map((l) => h('li', {}, describeRecipeLine(l, ingredients.get(l.ingredientId))))),
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
      type: 'search', placeholder: `Search ${recipes.size} recipes`, value: search, dataset: { key: 'recipe-search' },
      onInput: (e) => onAction('recipeSearch', e.target.value),
    }),
    h('ul', { class: 'picker' }, matches.map((r) => h('li', {},
      h('button', { class: 'link grow', onClick: () => onAction('openRecipe', r.id) }, r.name),
      h('span', { class: 'since' }, sinceLabel(history.get(r.id))),
    ))),
  );
}

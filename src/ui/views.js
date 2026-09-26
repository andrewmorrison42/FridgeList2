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
import { GRAB_RECIPE_BOOKMARKLET } from '../core/web-import.js';

/**
 * A search box whose results redraw beneath it. The box itself is never
 * rebuilt while someone types in it: phone keyboards build each word in
 * stages (composition), and a replaced box loses the word half-built — the
 * letters vanish, or come back doubled. A filter beside it (a category, say)
 * redraws the same results the same way.
 */
function searchWithResults({ value, placeholder, onSearch, results, filter = null }) {
  let query = value;
  let list = h('div', {}, results(query));
  const redraw = () => {
    const next = h('div', {}, results(query));
    list.replaceWith(next);
    list = next;
  };
  const box = h('input', {
    type: 'search', placeholder, value,
    autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
    onInput: (e) => { query = e.target.value; onSearch(query); redraw(); },
  });
  const select = filter && h('select', {
    class: 'filter', 'aria-label': filter.label,
    onChange: (e) => { filter.onChange(e.target.value); redraw(); },
  }, filter.options.map(([v, label]) => h('option', { value: v, selected: v === filter.value }, label)));
  return [select ? h('div', { class: 'search-row' }, box, select) : box, list];
}

/** Category choices for a recipe filter: every category in use, and slow cooker. */
function categoryFilter(recipes, value, onChange) {
  const cats = [...new Set([...recipes.values()].map((r) => r.category || 'Uncategorised'))].sort((a, b) => a.localeCompare(b));
  return {
    label: 'Category', value, onChange,
    options: [['', 'All categories'], ...cats.map((c) => [c, c]), ['__slow', 'Slow cooker']],
  };
}
const inCategory = (r, cat) => !cat || (cat === '__slow' ? r.slowCooker : (r.category || 'Uncategorised') === cat);

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
      .filter((r) => (!q || r.name.toLowerCase().includes(q.toLowerCase())) && inCategory(r, app.ui.planCat))
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
    h('div', { class: 'title-row' },
      h('h1', {}, "This week's menu"),
      chosen.length > 0 && h('button', { onClick: () => onAction('printMenu') }, 'Print menu'),
    ),
    menuPrint(app, chosen),

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
      filter: categoryFilter(recipes, app.ui.planCat ?? '', (v) => { app.ui.planCat = v; }),
    }),
  );
}

/**
 * The week's menu for the fridge door: printed on its own, never shown on
 * screen (styles.css). A box to tick with a pen as each meal is cooked.
 */
function menuPrint(app, chosen) {
  const { recipes } = app.library;
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return h('div', { class: 'menu-print' },
    h('h1', {}, "This week's menu"),
    h('p', { class: 'hint' }, `Planned ${today}. Tick each meal off as you cook it.`),
    h('ul', {}, chosen.map((sel) => {
      const r = recipes.get(sel.recipeId);
      return h('li', {},
        h('span', { class: 'box' }, sel.status === COOKED ? '☑' : '☐'),
        h('span', { class: 'grow' }, h('strong', {}, r?.name ?? sel.recipeId),
          h('small', {}, [` — serves ${sel.servings}`, r?.category && ` · ${r.category}`, r?.slowCooker && ' · slow cooker'].filter(Boolean).join(''))),
      );
    })),
  );
}

// -- Shopping list ----------------------------------------------------------

export function listView(app, { onAction }) {
  const { id, phase } = app.shop;
  const { lines, atHome, carryOver, problems } = app.list();
  const suppressed = (ingredientId) => app.store.get(`line:${id}:${ingredientId}:suppressed`) === true;
  const visible = lines.filter((l) => !suppressed(l.ingredientId));
  const done = (l) => app.store.get(`line:${id}:${l.ingredientId}:done`) === true;

  const categoryOrder = ['Fruit and Vegetables', 'Meat', 'Cold', 'Pantry', 'Toiletries', 'Other'];
  const grouped = groupForDisplay(visible, { categoryOrder });
  const remaining = visible.filter((l) => !done(l)).length;

  return h('section', { class: 'list' },
    h('div', { class: 'title-row' },
      h('h1', {}, phase === 'draft' ? 'Shopping list (planning)' : 'Shopping list'),
      h('button', { onClick: () => onAction('printList') }, 'Print'),
    ),
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
        h('span', { class: 'grow' }, l.name, ' ', h('small', {}, formatQuantity(l.qty, l.unit)), lineFor(app, l)),
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
            h('span', { class: 'name' }, l.name, lineFor(app, l)),
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

    // Pantry items the household usually has in (when that option is on, in
    // Setup): kept off the buy list, one tap away from it.
    atHome.length > 0 && h('details', { class: 'athome', open: app.ui.atHomeOpen || null,
      onToggle: (e) => { app.ui.atHomeOpen = e.target.open; } },
      h('summary', {}, `At home already (${atHome.length})`),
      h('p', { class: 'hint' }, 'Pantry items you usually have. Tap Need it for anything you are out of.'),
      h('ul', {}, atHome.sort((a, b) => a.name.localeCompare(b.name)).map((l) => h('li', {},
        h('span', { class: 'grow' }, l.name, ' ', h('small', {}, formatQuantity(l.qty, l.unit)), lineFor(app, l)),
        app.can.canAddLines && h('button', { onClick: () => onAction('addLine', l.ingredientId) }, 'Need it'),
      ))),
    ),

    problems.length > 0 && h('div', { class: 'problems' },
      h('h2', {}, 'Needs attention'),
      h('ul', {}, problems.map((p) => h('li', {}, `${p.kind}: ${p.ingredientId ?? p.recipeId}`))),
    ),
  );
}

/**
 * What a line is for: the recipes that need it, and whether it is a staple or
 * on the Wait List. With more than one reason, each one's share, so a line of
 * 750 mL reads as "Risotto 500 mL · Chilli 250 mL" and can be judged by meal.
 */
function lineFor(app, l) {
  const { recipes } = app.library;
  const parts = [];
  const many = l.sources.length > 1;
  for (const src of l.sources) {
    const amount = many && src.qty ? ` ${formatQuantity(src.qty, l.unit)}` : '';
    if (src.kind === 'recipe' || src.kind === 'carried') parts.push(`${recipes.get(src.recipeId)?.name ?? src.recipeId}${amount}`);
    else if (src.kind === 'staple') parts.push(`staple${amount}`);
    else if (src.kind === 'waitlist') parts.push(`Wait List${src.note ? ` (${src.note})` : ''}${amount}`);
  }
  return parts.length > 0 && h('small', { class: 'for' }, parts.join(' · '));
}

// -- Wait list --------------------------------------------------------------

export function waitListView(app, { onAction }) {
  const { ingredients } = app.library;
  const items = app.waitList();
  const search = app.ui.waitSearch ?? '';
  const results = (q) => {
    const text = q.trim();
    const matches = text
      ? [...ingredients.values()].filter((i) => i.name.toLowerCase().includes(text.toLowerCase())).slice(0, 12)
      : [];
    const exact = matches.some((i) => i.name.toLowerCase() === text.toLowerCase());
    return (matches.length > 0 || text) && h('ul', { class: 'picker' },
      matches.map((i) => h('li', {},
        h('span', { class: 'grow' }, i.name),
        h('button', { onClick: () => onAction('addWait', i.id) }, 'Add'),
      )),
      // Anything else — bin bags, birthday candles — goes on as typed, on a
      // line of its own under "Wait list" on the shopping list.
      text && !exact && h('li', { class: 'free' },
        h('span', { class: 'grow' }, `“${text}”`, h('small', {}, ' — not in the ingredient list')),
        h('button', { onClick: () => onAction('addWaitText', text) }, 'Add as typed'),
      ),
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
          h('span', { class: 'grow' }, item.text ?? ingredients.get(item.ingredientId)?.name ?? item.ingredientId),
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
  if (app.ui.importing) return importView(app, { onAction });

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
        h('button', { onClick: () => onAction('copyRecipe', r.id) }, 'Copy'),
        typeof navigator !== 'undefined' && navigator.share && h('button', { onClick: () => onAction('shareRecipe', r.id) }, 'Share…'),
      ),
      app.ui.flash && h('p', { class: 'ok' }, app.ui.flash),
      h('h1', {}, r.name),
      h('p', { class: 'hint' },
        [r.category || 'Uncategorised', `serves ${r.servings}`, r.slowCooker && 'slow cooker', `last chosen ${sinceLabel(history.get(r.id))}`]
          .filter(Boolean).join(' · ')),
      r.sourceUrl && h('p', {}, h('a', { href: r.sourceUrl, target: '_blank', rel: 'noopener' }, 'Source website ↗')),
      // Cooking from the phone: the screen dimming mid-step was the complaint.
      // Remembered on this device (Setup has the same switch).
      app.wake.supported && h('label', { class: 'keep-awake' },
        h('input', { type: 'checkbox', checked: app.wake.wanted, onChange: (e) => onAction('keepAwake', e.target.checked) }),
        'Keep the screen on while a recipe is open'),
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
      r.method?.length > 0 && methodList(r.method),
      r.notes && h('div', {}, h('h2', {}, 'Notes'), h('p', {}, r.notes)),
    );
  }

  const results = (q) => {
    const all = [...recipes.values()]
      .filter((r) => (!q || r.name.toLowerCase().includes(q.toLowerCase())) && inCategory(r, app.ui.recipeCat))
      .sort((a, b) => a.name.localeCompare(b.name));
    const matches = all.slice(0, 80);
    return [
      all.length === 0 && h('p', { class: 'empty' }, 'No recipes match.'),
      h('ul', { class: 'picker' }, matches.map((r) => h('li', {},
        h('button', { class: 'link grow', onClick: () => onAction('openRecipe', r.id) }, r.name,
          r.slowCooker && h('small', {}, ' · slow cooker')),
        h('span', { class: 'since' }, sinceLabel(history.get(r.id))),
      ))),
      moreHint(matches.length, all.length),
    ];
  };

  return h('section', {},
    h('div', { class: 'title-row' },
      h('h1', {}, 'Recipes'),
      app.recipes.raw && h('div', { class: 'actions tight' },
        h('button', { onClick: () => onAction('importOpen') }, 'Import from website'),
        h('button', { onClick: () => onAction('newRecipe') }, '+ New recipe'),
      ),
    ),
    // Never show a saved copy as if it were current (FR-SYNC-2).
    rs.state === 'error' && h('p', { class: 'warn-text' },
      `Showing the copy saved on this device — couldn't check ${rs.path} for changes.`),
    rs.state === 'missing' && h('p', { class: 'warn-text' },
      `There is no recipe file at ${rs.path}. See Setup.`),
    searchWithResults({
      value: search, placeholder: `Search ${recipes.size} recipes`, results,
      onSearch: (q) => { app.ui.recipeSearch = q; },
      filter: categoryFilter(recipes, app.ui.recipeCat ?? '', (v) => { app.ui.recipeCat = v; }),
    }),
  );
}

/** Method steps, numbered; a "— heading" step starts a new numbered group. */
function methodList(method) {
  const groups = [];
  for (const step of method) {
    const m = String(step).match(/^—\s*(.+)$/);
    if (m) groups.push({ heading: m[1], steps: [] });
    else { if (!groups.length) groups.push({ heading: null, steps: [] }); groups.at(-1).steps.push(step); }
  }
  return h('div', {},
    h('h2', {}, 'Method'),
    groups.map((g) => [g.heading && h('h3', {}, g.heading), h('ol', {}, g.steps.map((t) => h('li', {}, t)))]),
  );
}

/**
 * Import from a website. A recipe site cannot be read from here directly (the
 * browser forbids it), so it arrives pasted: what the Grab Recipe bookmark
 * copies, or the whole page selected and copied. It then opens in the editor
 * as a new recipe, each website line beside the row it became, and nothing is
 * saved until Save.
 */
function importView(app, { onAction }) {
  const im = app.ui.importing;
  return h('section', {},
    h('div', { class: 'actions' }, h('button', { onClick: () => onAction('importCancel') }, '← All recipes')),
    h('h1', {}, 'Import a recipe from a website'),
    h('ol', { class: 'steps' },
      h('li', {}, 'Open the recipe on its website.'),
      h('li', {}, 'Tap your ', h('strong', {}, '🛒 Grab Recipe'), ' bookmark — or, if you have not set one up, select the whole page and copy it.'),
      h('li', {}, 'Paste it below, then Continue.'),
    ),
    h('textarea', { rows: '8', placeholder: 'Paste here…', 'aria-label': 'Pasted recipe',
      onInput: (e) => { im.text = e.target.value; } }, im.text ?? ''),
    im.error && h('p', { class: 'warn-text' }, im.error),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onClick: () => onAction('importParse') }, 'Continue'),
      navigator.clipboard?.readText && h('button', { onClick: () => onAction('importPaste') }, 'Paste from clipboard'),
    ),
    h('details', { class: 'grab' },
      h('summary', {}, 'Set up the Grab Recipe bookmark'),
      h('p', { class: 'hint' },
        'Most recipe sites carry the recipe in a form this button can read, which gives a much cleaner import than a copied page. ',
        'It is the same button the earlier Fridge List app used; if you already have it, it works here too.'),
      h('p', {}, h('strong', {}, 'On a computer: '), 'show the bookmarks bar (Ctrl+Shift+B, or ⌘+Shift+B on a Mac) and drag this button onto it:'),
      h('p', {}, h('a', { class: 'bookmarklet', href: GRAB_RECIPE_BOOKMARKLET, onClick: (e) => e.preventDefault() }, '🛒 Grab Recipe')),
      h('p', {}, h('strong', {}, 'On a phone: '), 'bookmark any page, then edit that bookmark: name it Grab Recipe and replace its address with the code copied here.'),
      h('div', { class: 'actions' }, h('button', { onClick: () => onAction('copyGrabCode') }, 'Copy the bookmark code')),
      app.ui.flash && h('p', { class: 'ok' }, app.ui.flash),
    ),
  );
}

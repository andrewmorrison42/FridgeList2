// The Settings screen: connect this device to the household's OneDrive folder,
// and name the device so the reconcile report can say who ticked what.
//
// Everything here is per-device and never shared: the client id, the sign-in,
// the nickname. The household's data is in the folder; this screen only decides
// how this phone reaches it. §3.3, §5.2.

import { h } from './dom.js';
import { recipesPath } from './app.js';
import { staplesOf, featureOn, needsAttention, CATEGORIES, aislesFor, SHOPPING_UNITS } from '../core/recipes-format.js';

export function connectView(app, { onAction }) {
  const cfg = app.config;
  const status = app.sync.status();

  return h('section', {},
    h('h1', {}, 'Settings'),
    versionLine(app),

    h('h2', {}, 'This device'),
    h('label', { class: 'field' },
      h('span', {}, 'Name'),
      h('input', {
        // Unnamed, the device goes by its random id; that is not something
        // to type after, so the box starts empty.
        type: 'text', value: app.identity.nickname === app.identity.id ? '' : app.identity.nickname,
        placeholder: 'Dad’s phone', autocomplete: 'off',
        onInput: (e) => app.setNickname(e.target.value.trim() || app.identity.id),
      }),
    ),
    h('p', { class: 'hint' },
      'Shown to the others while shopping, so the list can say who ticked what. ',
      'It is not an account — there are none.'),
    app.wake.supported
      ? h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: app.wake.wanted, onChange: (e) => onAction('keepAwake', e.target.checked) }),
          'Keep the screen on while a recipe is open')
      : h('p', { class: 'hint' }, 'This browser cannot keep the screen on while a recipe is open.'),

    h('h2', {}, 'Storage'),
    cfg.storageMode === 'onedrive' && app.auth?.connected
      ? h('div', {},
          folderStatus(app, { onAction }),
          app.folder.state === 'found' && h('p', { class: 'hint' },
            status.lastPullAt ? `Last synced ${Math.round((Date.now() - status.lastPullAt) / 1000)}s ago.` : 'Not synced yet.'),
          h('div', { class: 'actions' },
            h('button', { onClick: () => onAction('syncNow') }, 'Sync now'),
            h('button', { onClick: () => onAction('signOut') }, 'Disconnect'),
          ),
        )
      : h('div', {},
          h('p', { class: 'hint' },
            'This device is working on its own. Connect it to the household folder ',
            'so everyone sees the same list.'),
          h('label', { class: 'field' },
            h('span', {}, 'Application (client) ID'),
            h('input', {
              type: 'text', value: cfg.clientId ?? '', placeholder: '00000000-0000-0000-0000-000000000000',
              autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
              onInput: (e) => app.setConfig('clientId', e.target.value.trim()),
            }),
          ),
          h('p', { class: 'hint' },
            'From the Azure app registration — the same id on every device in the house. ',
            'See README.md for the five-minute setup.'),
          h('label', { class: 'field' },
            h('span', {}, 'Folder'),
            h('input', {
              type: 'text', value: cfg.folder, placeholder: '/FridgeList',
              autocomplete: 'off', autocapitalize: 'off',
              onInput: (e) => app.setConfig('folder', e.target.value.trim()),
            }),
          ),
          h('div', { class: 'actions' },
            h('button', { class: 'primary', onClick: () => onAction('signIn') }, 'Connect to OneDrive'),
          ),
          cfg.authError && h('p', { class: 'warn-text' }, cfg.authError),
        ),

    h('h2', {}, 'Recipes'),
    recipesSection(app, { onAction }),

    app.recipes.raw && [
      h('h2', {}, 'Shopping list'),
      sharedSwitches(app, { onAction }),
      staplesSection(app, { onAction }),
      ingredientsSection(app, { onAction }),
    ],

    h('h2', {}, 'About'),
    h('p', { class: 'hint' },
      'Your data lives on this device and in your OneDrive folder. It never passes ',
      'through the site that serves this app. Every device holds the whole history, ',
      'so if OneDrive ever went away nothing would be lost.'),
  );
}

/**
 * Which recipe file this device uses. Per device, like the folder: each app can
 * point at the file it wants, and pointing this one at the earlier app's
 * recipes-data.json is what lets the two share one recipe book.
 */
function recipesSection(app, { onAction }) {
  const rs = app.recipes.status();
  const ago = rs.checkedAt ? `checked ${Math.round((Date.now() - rs.checkedAt) / 1000)}s ago` : 'not checked yet';

  return h('div', {},
    rs.mode === 'local'
      ? h('p', { class: 'hint' },
          `${rs.recipes} recipes, kept on this device only, started from the app's starter recipes. `,
          'Once connected to OneDrive, the recipes come from the file below instead.')
      : rs.state === 'ok' ? h('p', { class: 'ok' }, `${rs.recipes} recipes from ${rs.path} · ${ago}`)
      : rs.state === 'loading' ? h('p', { class: 'hint' }, `Checking ${rs.path}…`)
      : rs.state === 'error' && /No ".*" folder/.test(rs.error ?? '')
        ? h('p', { class: 'warn-text' }, 'The recipes are in the household folder, which this account cannot see yet — see Storage above.')
      : rs.state === 'missing' ? h('div', {},
          h('p', { class: 'warn-text' }, `There is no file at ${rs.path}.`),
          h('p', { class: 'hint' }, 'Check the path below, or start a new recipe book there from the starter recipes. ',
            'Starting one never replaces a file that is already there.'),
          h('div', { class: 'actions' },
            h('button', { onClick: () => onAction('recipesCreate') }, 'Start it from the starter recipes')),
        )
      : h('p', { class: 'warn-text' },
          `Couldn't read ${rs.path}: ${rs.error}. Showing the copy saved on this device (${rs.recipes} recipes).`),
    app.ui.recipesError && h('p', { class: 'warn-text' }, app.ui.recipesError),

    h('label', { class: 'field' },
      h('span', {}, 'Recipe file'),
      h('input', {
        type: 'text', value: app.ui.recipesFile ?? app.config.recipesFile ?? '',
        placeholder: recipesPath({ ...app.config, recipesFile: '' }),
        autocomplete: 'off', autocapitalize: 'off',
        onInput: (e) => { app.ui.recipesFile = e.target.value; },
      }),
    ),
    h('div', { class: 'actions' },
      h('button', { onClick: () => onAction('recipesFile') }, 'Use this recipe file')),
    h('p', { class: 'hint' },
      'A path in the OneDrive, e.g. /FridgeList/recipes-data.json — the file the earlier ',
      'Fridge List app uses, so both share one recipe book. Leave empty for recipes-data.json in the folder above.'),
    rs.mode === 'file' && h('div', { class: 'actions' },
      h('button', { onClick: () => onAction('recipesCheck') }, 'Check for changes now')),
  );
}

/**
 * Which version is running, first thing on the screen, so a glance tells
 * whether this device has the latest. It comes from src/version.js, loaded
 * with the rest of the code, so it is the version actually running.
 */
function versionLine(app) {
  const released = app.released
    ? new Date(`${app.released}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
    : null;
  return h('p', { class: 'version' }, `Version ${app.version}`, released && ` · ${released}`);
}

/**
 * The household's switches. They live in the recipe file, so they apply on
 * every phone — and in the earlier app too, which reads the same settings.
 */
function sharedSwitches(app, { onAction }) {
  const raw = app.recipes.raw;
  const sw = (key, label, hint) => h('div', {},
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: featureOn(raw, key), onChange: (e) => onAction('feature', key, e.target.checked) }),
      label),
    h('p', { class: 'hint' }, hint));
  return h('div', {},
    app.ui.settingsError && h('p', { class: 'warn-text' }, app.ui.settingsError),
    sw('staples', 'Add staples to every list', 'The staples below go on every shopping list, in the amounts set here.'),
    sw('pantryAtHome', 'Pantry items start as "at home"',
      'Pantry-category items from recipes start in an "At home already" group on the list, one tap from the buy list. '
      + 'Wait List items and staples always stay on the buy list.'),
    h('p', { class: 'hint' }, 'These apply to every phone, and to the earlier Fridge List app.'),
  );
}

/** Staples: bought every week, whatever is planned. */
function staplesSection(app, { onAction }) {
  const raw = app.recipes.raw;
  const staples = staplesOf(raw);
  const add = app.ui.stapleAdd ?? (app.ui.stapleAdd = { name: '', qty: '' });
  const unitWord = (u) => (!u || u === 'qty' ? 'each' : u);
  return h('details', { class: 'setup-block', open: app.ui.openBlock === 'staples' || null,
    onToggle: (e) => { if (e.target.open) app.ui.openBlock = 'staples'; else if (app.ui.openBlock === 'staples') app.ui.openBlock = null; } },
    h('summary', {}, `Staples (${staples.length})`),
    !featureOn(raw, 'staples') && h('p', { class: 'warn-text' }, 'Staples are switched off above, so these are not being added to lists.'),
    staples.length === 0 && h('p', { class: 'empty' }, 'No staples yet — add the things you buy every week.'),
    h('ul', { class: 'staples' }, staples.map((st) => h('li', {},
      h('span', { class: 'grow' }, st.name, !st.known && h('small', { class: 'warn-text' }, ' — not in the ingredient list')),
      h('input', { type: 'text', class: 'staple-qty', inputmode: 'decimal', 'aria-label': `Amount of ${st.name}`,
        value: st.qty ?? '', placeholder: '1',
        onChange: (e) => onAction('stapleSet', st.name, e.target.value) }),
      h('span', { class: 'unit-fixed' }, unitWord(st.unit)),
      h('button', { class: 'ghost', title: `Remove ${st.name}`, 'aria-label': `Remove ${st.name}`, onClick: () => onAction('stapleRemove', st.name) }, '✕'),
    ))),
    h('div', { class: 'staple-add' },
      h('input', { type: 'text', list: 'staple-names', placeholder: 'Add a staple…', 'aria-label': 'Staple to add',
        value: add.name, autocomplete: 'off', onInput: (e) => { add.name = e.target.value; } }),
      h('input', { type: 'text', class: 'staple-qty', inputmode: 'decimal', placeholder: 'amount', 'aria-label': 'Amount',
        value: add.qty, onInput: (e) => { add.qty = e.target.value; } }),
      h('button', { onClick: () => onAction('stapleAdd') }, 'Add'),
    ),
    h('datalist', { id: 'staple-names' }, (raw.ingredients ?? []).map((i) => h('option', { value: i.name }))),
    h('p', { class: 'hint' }, 'Amounts are in the ingredient\'s shopping unit — "2 L" and "500 g" work too.'),
  );
}

/**
 * The ingredient list: where each ingredient goes on the shopping list and how
 * it is bought. Anything new, or never sorted, is flagged as needing attention
 * — it would otherwise sit in "Uncategorised" on every list.
 */
function ingredientsSection(app, { onAction }) {
  const raw = app.recipes.raw;
  const all = raw.ingredients ?? [];
  const attention = all.filter((i) => needsAttention(i).length > 0);
  const f = app.ui.ingFilter ?? (app.ui.ingFilter = { q: '', onlyAttention: attention.length > 0, touched: new Set() });

  const rows = () => {
    const q = f.q.trim().toLowerCase();
    // One fixed a moment ago stays in view, ticked, rather than jumping away
    // mid-edit; it goes when the filter or search changes.
    const pool = f.onlyAttention ? all.filter((i) => needsAttention(i).length > 0 || f.touched.has(i.name)) : all;
    const shown = pool.filter((i) => !q || String(i.name).toLowerCase().includes(q))
      .slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const capped = shown.slice(0, 60);
    return h('div', {},
      shown.length === 0 && h('p', { class: 'empty' }, f.onlyAttention ? 'Nothing needs attention.' : 'No ingredients match.'),
      h('ul', { class: 'ingredients' }, capped.map((ing) => ingredientRow(raw, ing, (...a) => { f.touched.add(ing.name); return onAction(...a); }))),
      capped.length < shown.length && h('p', { class: 'hint' }, `Showing ${capped.length} of ${shown.length}. Search to find the rest.`),
    );
  };
  let list = rows();
  const redraw = () => { const n = rows(); list.replaceWith(n); list = n; };

  return h('details', { class: 'setup-block', open: app.ui.openBlock === 'ingredients' || null,
    onToggle: (e) => { if (e.target.open) app.ui.openBlock = 'ingredients'; else if (app.ui.openBlock === 'ingredients') app.ui.openBlock = null; } },
    h('summary', {}, 'Ingredient list', attention.length > 0 && h('span', { class: 'badge' }, `${attention.length} need attention`)),
    h('p', { class: 'hint' }, 'Where each ingredient goes on the shopping list, and how it is bought.'),
    h('div', { class: 'search-row' },
      h('input', { type: 'search', placeholder: `Search ${all.length} ingredients`, value: f.q, 'aria-label': 'Search ingredients',
        autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false',
        onInput: (e) => { f.q = e.target.value; f.touched.clear(); redraw(); } }),
    ),
    h('label', { class: 'check' },
      h('input', { type: 'checkbox', checked: f.onlyAttention, onChange: (e) => { f.onlyAttention = e.target.checked; f.touched.clear(); redraw(); } }),
      `Only ones needing an aisle, category or unit (${attention.length})`),
    list,
  );
}

function ingredientRow(raw, ing, onAction) {
  const missing = needsAttention(ing);
  const cat = ing.shoppingCategory && ing.shoppingCategory !== 'Other' ? ing.shoppingCategory : '';
  const aisle = ing.aisle && ing.aisle !== 'Uncategorised' ? ing.aisle : '';
  const aisles = cat ? aislesFor(raw, cat) : [];
  const set = (field) => (e) => onAction('ingredientSet', ing.name, { [field]: e.target.value });
  return h('li', { class: `ing-edit ${missing.length ? 'attention' : ''}` },
    h('div', { class: 'ing-edit-name' }, h('strong', {}, ing.name),
      missing.length > 0 ? h('small', { class: 'warn-text' }, ` needs ${missing.join(', ')}`) : h('small', { class: 'ok' }, ' ✓')),
    h('div', { class: 'alloc' },
      h('select', { 'aria-label': `Category of ${ing.name}`,
        onChange: (e) => onAction('ingredientSet', ing.name, { shoppingCategory: e.target.value || 'Other',
          // A category's aisles are its own: an aisle from the old one is cleared.
          ...(aislesFor(raw, e.target.value).includes(aisle) ? {} : { aisle: 'Uncategorised' }) }) },
        h('option', { value: '' }, '— category —'),
        CATEGORIES.filter((c) => c !== 'Other').map((c) => h('option', { value: c, selected: c === cat }, c))),
      h('select', { 'aria-label': `Aisle of ${ing.name}`, disabled: !cat, onChange: (e) => onAction('ingredientSet', ing.name, { aisle: e.target.value || 'Uncategorised' }) },
        h('option', { value: '' }, '— aisle —'),
        [...aisles, ...(aisle && !aisles.includes(aisle) ? [aisle] : [])].map((a) => h('option', { value: a, selected: a === aisle }, a))),
      h('select', { 'aria-label': `How ${ing.name} is bought`, onChange: set('shoppingUnit') },
        h('option', { value: '' }, '— bought by —'),
        SHOPPING_UNITS.map((u) => h('option', { value: u.value, selected: u.value === ing.shoppingUnit }, u.label))),
    ),
  );
}

/**
 * Which folder this account is using, and whose it is. Each person signs in as
 * themselves; the folder belongs to one of them and is shared with the rest,
 * who reach it through a shortcut in their own OneDrive.
 */
function folderStatus(app, { onAction }) {
  const f = app.folder;
  const path = app.config.folder;
  const reconsent = app.auth?.needsSharedAccess && h('div', { class: 'refusal' },
    h('p', {}, 'This phone signed in before shared folders were supported. Sign in again to reach a folder someone else has shared with you.'),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onClick: () => onAction('signIn') }, 'Sign in again')));

  if (f.state === 'checking') return h('div', {}, h('p', { class: 'hint' }, `Looking for ${path}…`), reconsent);
  if (f.state === 'error') {
    return h('div', {},
      h('p', { class: 'warn-text' }, `Couldn't look for ${path}: ${f.error}`),
      reconsent,
      h('div', { class: 'actions' }, h('button', { onClick: () => onAction('folderCheck') }, 'Try again')));
  }
  if (f.state === 'missing') {
    return h('div', {},
      h('p', { class: 'warn-text' }, `This Microsoft account can't see a ${path} folder.`),
      reconsent,
      h('p', { class: 'hint' }, 'If someone in the household already has one:'),
      h('ol', { class: 'steps' },
        h('li', {}, `They share their ${path.replace(/^\//, '')} folder with this account's email, from onedrive.com, with editing allowed (not view only).`),
        h('li', {}, 'On onedrive.com, signed in as this account: Shared → the folder → Add shortcut to My files.'),
        h('li', {}, 'Then tap Check again.'),
      ),
      h('div', { class: 'actions' },
        h('button', { class: 'primary', onClick: () => onAction('folderCheck') }, 'Check again'),
        h('button', { onClick: () => onAction('folderCreate') }, `Start a new ${path.replace(/^\//, '')} folder here`),
      ),
      h('p', { class: 'hint' }, 'Only start a new one if nobody has — otherwise this phone would have a list of its own that no one else sees.'),
    );
  }
  if (f.state === 'found') {
    return h('div', {},
      h('p', { class: 'ok' }, f.shared
        ? `Connected · ${path}, shared by ${f.owner ?? 'another account'}`
        : `Connected · ${path} in this account's OneDrive`),
      f.alsoShared && h('div', { class: 'refusal' },
        h('p', {}, `${f.alsoShared} has also shared a ${path.replace(/^\//, '')} folder with this account, but this phone is using one of its own — so nobody else sees what it does.`),
        h('p', { class: 'hint' }, `On onedrive.com, rename or delete this account's own ${path.replace(/^\//, '')} folder, add a shortcut to the shared one (Shared → the folder → Add shortcut to My files), then Check again.`),
        h('div', { class: 'actions' }, h('button', { onClick: () => onAction('folderCheck') }, 'Check again'))),
      reconsent,
    );
  }
  return reconsent || null;
}

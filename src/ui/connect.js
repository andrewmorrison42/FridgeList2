// The Settings screen: connect this device to the household's OneDrive folder,
// and name the device so the reconcile report can say who ticked what.
//
// Everything here is per-device and never shared: the client id, the sign-in,
// the nickname. The household's data is in the folder; this screen only decides
// how this phone reaches it. §3.3, §5.2.

import { h } from './dom.js';
import { recipesPath } from './app.js';

export function connectView(app, { onAction }) {
  const cfg = app.config;
  const status = app.sync.status();

  return h('section', {},
    h('h1', {}, 'Settings'),

    h('h2', {}, 'This device'),
    h('label', { class: 'field' },
      h('span', {}, 'Name'),
      h('input', {
        type: 'text', value: app.identity.nickname, placeholder: 'Dad’s phone',
        onChange: (e) => onAction('nickname', e.target.value),
      }),
    ),
    h('p', { class: 'hint' },
      'Shown to the others while shopping, so the list can say who ticked what. ',
      'It is not an account — there are none.'),

    h('h2', {}, 'Storage'),
    cfg.storageMode === 'onedrive' && app.auth?.connected
      ? h('div', {},
          h('p', { class: 'ok' }, `Connected to OneDrive · ${cfg.folder}`),
          h('p', { class: 'hint' },
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
              onChange: (e) => onAction('clientId', e.target.value.trim()),
            }),
          ),
          h('p', { class: 'hint' },
            'From the Azure app registration — the same id on every device in the house. ',
            'See README.md for the five-minute setup.'),
          h('label', { class: 'field' },
            h('span', {}, 'Folder'),
            h('input', {
              type: 'text', value: cfg.folder, placeholder: '/FridgeList',
              onChange: (e) => onAction('folder', e.target.value.trim()),
            }),
          ),
          h('div', { class: 'actions' },
            h('button', {
              class: 'primary', disabled: !cfg.clientId,
              onClick: () => onAction('signIn'),
            }, 'Connect to OneDrive'),
          ),
          cfg.authError && h('p', { class: 'warn-text' }, cfg.authError),
        ),

    h('h2', {}, 'Recipes'),
    recipesSection(app, { onAction }),
    h('div', { class: 'actions' },
      h('button', { onClick: () => window.print() }, 'Print the list'),
    ),

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
        type: 'text', value: app.config.recipesFile ?? '',
        placeholder: recipesPath({ ...app.config, recipesFile: '' }),
        onChange: (e) => onAction('recipesFile', e.target.value.trim()),
      }),
    ),
    h('p', { class: 'hint' },
      'A path in the OneDrive, e.g. /FridgeList/recipes-data.json — the file the earlier ',
      'Fridge List app uses, so both share one recipe book. Leave empty for recipes-data.json in the folder above.'),
    rs.mode === 'file' && h('div', { class: 'actions' },
      h('button', { onClick: () => onAction('recipesCheck') }, 'Check for changes now')),
  );
}

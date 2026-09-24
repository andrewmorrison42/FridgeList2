// The Settings screen: connect this device to the household's OneDrive folder,
// and name the device so the reconcile report can say who ticked what.
//
// Everything here is per-device and never shared: the client id, the sign-in,
// the nickname. The household's data is in the folder; this screen only decides
// how this phone reaches it. §3.3, §5.2.

import { h } from './dom.js';

export function connectView(app, { onAction }) {
  const cfg = app.config;
  const status = app.sync.status();

  return h('section', {},
    h('h1', {}, 'Settings'),

    h('h2', {}, 'This device'),
    h('label', { class: 'field' },
      h('span', {}, 'Name'),
      h('input', {
        type: 'text', value: app.identity.nickname, placeholder: 'Dad’s phone', dataset: { key: 'nickname' },
        onInput: (e) => onAction('nickname', e.target.value),
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
              // Recorded as it is typed or pasted, not when the box is left:
              // with onChange, the tap on Connect was what left the box, so it
              // landed on a still-disabled button and did nothing (glitch #9).
              type: 'text', value: cfg.clientId ?? '', placeholder: '00000000-0000-0000-0000-000000000000',
              dataset: { key: 'client-id' }, autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false',
              onInput: (e) => onAction('clientId', e.target.value.trim()),
            }),
          ),
          h('p', { class: 'hint' },
            'From the Azure app registration — the same id on every device in the house. ',
            'See README.md for the five-minute setup.'),
          h('label', { class: 'field' },
            h('span', {}, 'Folder'),
            h('input', {
              type: 'text', value: cfg.folder, placeholder: '/FridgeList', dataset: { key: 'folder' },
              autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false',
              onInput: (e) => onAction('folder', e.target.value.trim()),
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

    h('h2', {}, 'Library'),
    h('p', { class: 'hint' },
      `${app.library.recipes.size} recipes, ${app.library.ingredients.size} ingredients.`),
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

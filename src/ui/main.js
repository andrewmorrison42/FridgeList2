// Mount point and router. Wires the store to the screen so that a merge always
// reaches it — FR-SYNC-7, §11.1.

import { createApp } from './app.js';
import { h, clear } from './dom.js';
import { statusBar, closeReport } from './status.js';
import { planView, listView, waitListView, recipesView } from './views.js';
import { connectView } from './connect.js';
import { recipeToDraft, blankRow, unitChoices, rebaseDraft } from '../core/recipes-format.js';

const TABS = [
  ['list', 'List', listView],
  ['plan', 'Plan', planView],
  ['wait', 'Wait', waitListView],
  ['recipes', 'Recipes', recipesView],
  ['settings', 'Setup', connectView],
];

export async function mount(root, { storage } = {}) {
  const app = await createApp({ storage });
  app.ui = { tab: location.hash.slice(1) || 'list', search: '', confirmingClose: false };

  const onAction = async (action, ...args) => {
    switch (action) {
      case 'tab':
        // Leaving for another tab abandons the close confirmation. Otherwise
        // the confirmation shadows every screen and the only way out is to
        // answer it, which is not what tapping "Recipes" means.
        app.ui.confirmingClose = false;
        app.ui.tab = args[0];
        location.hash = args[0];
        break;
      case 'search':     app.ui.search = args[0]; break;
      case 'waitSearch': app.ui.waitSearch = args[0]; break;
      case 'recipeSearch': app.ui.recipeSearch = args[0]; break;
      case 'openRecipe': app.ui.openRecipe = args[0]; break;
      case 'plan':       app.planRecipe(args[0], args[1]); break;
      case 'unplan':     app.unplanRecipe(args[0]); break;
      case 'cooked':     app.markCooked(args[0]); break;
      case 'addWait':    app.addWaitList(args[0]); app.ui.waitSearch = ''; break;
      case 'removeWait': app.removeWaitList(args[0]); break;
      case 'suppress':   app.suppressLine(args[0]); break;
      case 'addLine':    app.addLine(args[0]); break;
      case 'dismiss':    app.dismissCarryOver(args[0]); break;
      case 'tick':       app.setDone(args[0], args[1]); break;
      case 'lock':
        app.generateList();                 // transitions first, then lock
        app.lockShop();
        await app.joinShop({ silent: false });
        break;
      case 'join':       await app.joinShop(); break;
      case 'close':
        // Two steps: here is what is outstanding, then yes, done anyway.
        if (!app.ui.confirmingClose) { app.ui.confirmingClose = true; break; }
        app.ui.confirmingClose = false;
        await app.closeShop();
        break;
      case 'cancelClose': app.ui.confirmingClose = false; break;
      case 'nickname':   app.setNickname(args[0]); break;
      case 'clientId':   app.setConfig('clientId', args[0]); break;
      case 'folder':     app.setConfig('folder', args[0]); break;
      case 'signIn':
        try { await app.connect(); }
        catch (err) { app.config.authError = err.message; }
        break;
      case 'signOut':    app.disconnect(); location.reload(); break;
      case 'syncNow':    await app.refresh({ force: true }); break;
      case 'recipesFile':
        // A different file is a different recipe book: start again on it.
        app.setConfig('recipesFile', args[0]);
        location.reload();
        return;
      case 'recipesCheck':  await app.recipes.refresh({ force: true }); break;
      case 'recipesCreate':
        try { await app.recipes.createFromSeed(); }
        catch (err) { app.ui.recipesError = err.message; }
        break;

      // -- the recipe editor (editor.js) --
      case 'editRecipe':  app.ui.draft = recipeToDraft(app.recipes.raw, args[0]); window.scrollTo(0, 0); break;
      case 'newRecipe':   app.ui.draft = recipeToDraft(app.recipes.raw, null); app.ui.draft.rows.push(blankRow(app.ui.draft)); break;
      case 'draftCancel': app.ui.draft = null; break;
      case 'draftAddRow': app.ui.draft.rows.push(blankRow(app.ui.draft)); break;
      case 'draftRemoveRow': app.ui.draft.rows.splice(args[0], 1); break;
      case 'draftRowName': {
        // Settle the unit to one this ingredient allows.
        const row = app.ui.draft.rows[args[0]];
        const choice = unitChoices(app.recipes.raw, row.name);
        if (choice.kind === 'choose' && !choice.options.includes(row.unit)) row.unit = choice.options[0];
        if (choice.kind === 'fixed') row.unit = choice.unit;
        break;
      }
      case 'draftReopen': app.ui.draft = recipeToDraft(app.recipes.raw, app.ui.draft.id); break;
      case 'draftOverride':
        app.ui.draft = rebaseDraft(app.ui.draft, app.recipes.raw);
        return onAction('draftSave');
      case 'draftSave': {
        const d = app.ui.draft;
        d.saving = true; d.error = null; d.conflict = false;
        render();
        const out = await app.saveRecipe(d);
        d.saving = false;
        if (out.conflict) d.conflict = true;
        else if (out.error) d.error = out.error;
        else { app.ui.draft = null; app.ui.openRecipe = out.recipeId; }
        window.scrollTo(0, 0);
        break;
      }
    }
    render();
  };

  function render() {
    const view = TABS.find(([id]) => id === app.ui.tab)?.[2] ?? listView;
    clear(root).append(
      statusBar(app, { onAction }),
      app.ui.confirmingClose
        ? h('main', {}, closeReport(app),
            h('div', { class: 'actions' },
              h('button', { class: 'primary', onClick: () => onAction('close') }, 'Finish anyway'),
              h('button', { onClick: () => onAction('cancelClose') }, 'Keep shopping')))
        : h('main', {}, view(app, { onAction })),
      h('nav', {}, TABS.map(([id, label]) => h('button', {
        class: app.ui.tab === id ? 'on' : '', onClick: () => onAction('tab', id),
      }, label))),
    );
  }

  // Any change merged into local state re-renders. No view reads state once at
  // mount, and there is no pull-to-refresh: a device holding current data that
  // shows stale data is, to the person holding it, one that never received the
  // change. FR-SYNC-7.
  //
  // The one exception is the recipe editor on screen: re-rendering would take the
  // cursor from someone typing. The editor shows no shared state, and the rest
  // catches up the moment it closes.
  const background = () => { if (!(app.ui.draft && app.ui.tab === 'recipes')) render(); };
  app.store.subscribe(background);
  app.recipes.subscribe(background);
  app.start(background);
  render();

  window.addEventListener('hashchange', () => onAction('tab', location.hash.slice(1) || 'list'));
  return app;
}

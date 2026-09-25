// Mount point and router. Wires the store to the screen so that a merge always
// reaches it — FR-SYNC-7, §11.1.

import { createApp } from './app.js';
import { h, clear } from './dom.js';
import { statusBar, closeReport } from './status.js';
import { planView, listView, waitListView, recipesView } from './views.js';
import { connectView } from './connect.js';
import { recipeToDraft, blankRow, rebaseDraft } from '../core/recipes-format.js';

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
      case 'signIn':
        try { await app.connect(); }
        catch (err) { app.config.authError = err.message; }
        break;
      case 'signOut':    app.disconnect(); location.reload(); break;
      case 'syncNow':    await app.refresh({ force: true }); break;
      case 'recipesFile':
        // A different file is a different recipe book: start again on it.
        app.setConfig('recipesFile', (app.ui.recipesFile ?? app.config.recipesFile ?? '').trim());
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

  // Every render rebuilds the screen, so the element someone is typing in is
  // replaced by a new one. Carry focus, caret and scroll across to it, or each
  // keystroke in a search box would drop the keyboard after one letter.
  const FIELDS = 'input:not([type=checkbox]), textarea, select';
  const typingIn = () => {
    const a = document.activeElement;
    return a && root.contains(a) && a.matches(FIELDS) ? a : null;
  };

  function render() {
    const active = typingIn();
    const at = active ? [...root.querySelectorAll(FIELDS)].indexOf(active) : -1;
    let caret = null;
    try { caret = active && [active.selectionStart, active.selectionEnd]; } catch { /* not a text field */ }
    const scroll = window.scrollY;
    draw();
    window.scrollTo(0, scroll);
    const next = at >= 0 ? root.querySelectorAll(FIELDS)[at] : null;
    if (next && next.tagName === active.tagName && next.type === active.type) {
      next.focus({ preventScroll: true });
      try { if (caret?.[0] !== null && caret) next.setSelectionRange(caret[0], caret[1]); } catch { /* not a text field */ }
    }
  }

  function draw() {
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
  // The one exception is someone typing. A background redraw would take the box
  // from under them (and on a phone, the keyboard with it), so it waits until
  // they leave the field; the recipe editor waits until it closes. Neither
  // shows shared state that could be stale meanwhile.
  let owed = false;
  const background = () => {
    if ((app.ui.draft && app.ui.tab === 'recipes') || typingIn()) { owed = true; return; }
    owed = false;
    render();
  };
  root.addEventListener('focusout', (e) => {
    // Moving from one field to the next is still typing.
    if (owed && !(e.relatedTarget && root.contains(e.relatedTarget) && e.relatedTarget.matches(FIELDS))) {
      setTimeout(background, 0);
    }
  });
  app.store.subscribe(background);
  app.recipes.subscribe(background);
  app.start(background);
  render();

  window.addEventListener('hashchange', () => onAction('tab', location.hash.slice(1) || 'list'));
  return app;
}

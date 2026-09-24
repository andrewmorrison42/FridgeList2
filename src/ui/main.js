// Mount point and router. Wires the store to the screen so that a merge always
// reaches it — FR-SYNC-7, §11.1.

import { createApp } from './app.js';
import { h, clear } from './dom.js';
import { statusBar, closeReport } from './status.js';
import { planView, listView, waitListView, recipesView } from './views.js';
import { connectView } from './connect.js';
import { createMemoryStorage } from '../data/storage.js';

const TABS = [
  ['list', 'List', listView],
  ['plan', 'Plan', planView],
  ['wait', 'Wait', waitListView],
  ['recipes', 'Recipes', recipesView],
  ['settings', 'Setup', connectView],
];

/** First run, or an explicit reload: bring in the imported library (§12). */
export async function loadLibraryInto(app) {
  try {
    const res = await fetch('data/library.json');
    if (!res.ok) return false;
    await app.loadLibrary(await res.json());
    await app.refresh();
    return true;
  } catch {
    return false;    // the app runs without a library; it just has nothing to plan
  }
}

export async function mount(root, { storage } = {}) {
  const app = await createApp({ storage });
  app.ui = { tab: location.hash.slice(1) || 'list', search: '', confirmingClose: false };

  const onAction = async (action, ...args) => {
    app.ui.notice = null;
    try {
      await perform(action, ...args);
    } catch (err) {
      // A safety net for the person holding the phone: a refused action says
      // why, instead of silently doing nothing. It is not how refusals are
      // meant to happen — a view should only offer what the phase permits — so
      // the browser suite counts every one of these as a failure.
      app.ui.notice = err.message;
      app.ui.refusals = (app.ui.refusals ?? 0) + 1;
    }
    render();
  };

  const perform = async (action, ...args) => {
    switch (action) {
      case 'tab':
        // Leaving for another tab abandons the close confirmation. Otherwise
        // the confirmation shadows every screen and the only way out is to
        // answer it, which is not what tapping "Recipes" means.
        app.ui.confirmingClose = false;
        if (app.ui.tab !== args[0]) window.scrollTo(0, 0);   // a new screen starts at its top
        app.ui.tab = args[0];
        location.hash = args[0];
        break;
      case 'search':     app.ui.search = args[0]; break;
      case 'waitSearch': app.ui.waitSearch = args[0]; break;
      case 'recipeSearch': app.ui.recipeSearch = args[0]; break;
      case 'openRecipe': app.ui.openRecipe = args[0]; break;
      case 'plan':       app.planRecipe(args[0], args[1]); break;
      case 'unplan':     app.unplanRecipe(args[0], args[1]); break;
      case 'servings':   app.setServings(args[0], args[1], args[2]); break;
      case 'cooked':     app.markCooked(args[0], args[1]); break;
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
      case 'syncNow':    await app.refresh(); break;
      case 'reloadLibrary': await loadLibraryInto(app); break;
    }
  };

  /**
   * Redraw the screen from derived state.
   *
   * The whole screen is rebuilt, which destroys whatever element had focus.
   * Before glitch #5 was fixed, every search box lost focus after the first key
   * press — type "laksa", get "l". So the focused field (found again by its
   * data-key) and the caret within it survive every redraw.
   *
   * Scroll position needs no help: the rebuild is synchronous, so the page
   * never lays out at zero height and the browser keeps its place. (A reported
   * "jump" on ticking turned out to be the test harness scrolling a box into
   * view, not the app; test/ui guards the real behaviour.)
   */
  function render() {
    const active = document.activeElement;
    const focusKey = active?.dataset?.key ?? null;
    const caret = focusKey && typeof active.selectionStart === 'number'
      ? [active.selectionStart, active.selectionEnd] : null;

    const view = TABS.find(([id]) => id === app.ui.tab)?.[2] ?? listView;
    clear(root).append(
      statusBar(app, { onAction }),
      app.ui.confirmingClose
        ? h('main', {}, closeReport(app),
            h('div', { class: 'actions' },
              h('button', { class: 'primary', onClick: () => onAction('close') }, 'Finish anyway'),
              h('button', { onClick: () => onAction('cancelClose') }, 'Keep shopping')))
        : h('main', {},
            app.ui.notice && h('div', { class: 'refusal', role: 'alert' }, h('p', {}, app.ui.notice)),
            view(app, { onAction })),
      h('nav', {}, TABS.map(([id, label]) => h('button', {
        class: app.ui.tab === id ? 'on' : '', onClick: () => onAction('tab', id),
      }, label))),
    );

    if (focusKey) {
      const field = root.querySelector(`[data-key="${focusKey}"]`);
      if (field) {
        field.focus({ preventScroll: true });
        if (caret) field.setSelectionRange(caret[0], caret[1]);
      }
    }
  }

  // Any change merged into local state re-renders. No view reads state once at
  // mount, and there is no pull-to-refresh: a device holding current data that
  // shows stale data is, to the person holding it, one that never received the
  // change. FR-SYNC-7.
  app.store.subscribe(render);
  app.start(render);
  render();

  window.addEventListener('hashchange', () => onAction('tab', location.hash.slice(1) || 'list'));
  return app;
}

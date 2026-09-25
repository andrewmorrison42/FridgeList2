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

/**
 * What the screen shows if it cannot draw. The message is the real one, so it
 * can be passed on; the buttons are the ways out that need no working screen.
 */
export function failure(err, app = null) {
  return h('main', { class: 'failure' },
    h('h1', {}, 'Something went wrong'),
    h('p', {}, 'The app hit an error drawing this screen. Nothing you have entered has been lost.'),
    h('pre', {}, String(err?.stack ?? err?.message ?? err).split('\n').slice(0, 4).join('\n')),
    app && h('p', { class: 'hint' }, `Version ${app.version}`),
    h('div', { class: 'actions' },
      h('button', { class: 'primary', onClick: () => location.reload() }, 'Reload'),
      h('button', {
        onClick: () => {
          // Back to working on this device alone; sign in again from Setup.
          try { localStorage.removeItem('fridgelist.auth'); localStorage.setItem('fridgelist.storageMode', '"local"'); } catch { /* ignore */ }
          location.replace(location.pathname + '#settings');
          location.reload();
        },
      }, 'Disconnect OneDrive'),
    ),
  );
}

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
        if (app.ui.tab !== args[0]) app.ui.scrollTo = 0;
        app.ui.tab = args[0];
        location.hash = args[0];
        break;
      case 'openRecipe':
        // Into a recipe: its top. Back out: where the list was left.
        if (args[0]) { app.ui.listScroll = window.scrollY; app.ui.scrollTo = 0; }
        else app.ui.scrollTo = app.ui.listScroll ?? 0;
        app.ui.openRecipe = args[0];
        break;
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
      case 'editRecipe':  app.ui.draft = recipeToDraft(app.recipes.raw, args[0]); app.ui.scrollTo = 0; break;
      case 'newRecipe':
        app.ui.draft = recipeToDraft(app.recipes.raw, null);
        app.ui.draft.rows.push(blankRow(app.ui.draft));
        app.ui.scrollTo = 0; app.ui.focus = '.editor .field input';
        break;
      case 'draftCancel': app.ui.draft = null; app.ui.scrollTo = 0; break;
      case 'draftAddRow':
        app.ui.draft.rows.push(blankRow(app.ui.draft));
        app.ui.focus = '.ing-row:last-of-type .ing-name';   // ready to type into
        break;
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
        app.ui.scrollTo = 0;
        break;
      }
    }
    render();
  };

  // Every render rebuilds the screen. So nothing may render while someone is
  // typing: a rebuilt box loses the half-built word a phone keyboard is
  // composing. Searches therefore redraw only their results (views.js), the
  // editor writes into its draft without rendering, and background redraws
  // wait (below). Scroll stays where it was, unless the render is a move to
  // a different screen, which starts at the top — or back where the person
  // left the list.
  const FIELDS = 'input:not([type=checkbox]), textarea, select';
  const typingIn = () => {
    const a = document.activeElement;
    return a && root.contains(a) && a.matches(FIELDS) ? a : null;
  };

  function render() {
    const scroll = app.ui.scrollTo ?? window.scrollY;
    app.ui.scrollTo = null;
    try {
      draw();
    } catch (err) {
      // Never a blank screen: say what broke, and leave a way out.
      console.error(err);
      clear(root).append(failure(err, app));
    }
    window.scrollTo(0, scroll);
    if (app.ui.focus) {
      root.querySelector(app.ui.focus)?.focus();
      app.ui.focus = null;
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
  // The exception is someone in the middle of something. A background redraw
  // waits while:
  //  - a box has focus: it would take the box, and the keyboard, from under them;
  //  - the recipe editor is open: it holds no shared state to go stale;
  //  - a finger is down, or the page is still scrolling: a redraw that moves
  //    the list under a tap puts the tick on the wrong line, and one during a
  //    fling stops it dead.
  // It happens as soon as they stop, so nothing is held back for long.
  let owed = false;
  let busyUntil = 0;
  let fingers = 0;
  let downAt = 0;
  const QUIET_MS = 450;
  // A lost pointerup must not hold redraws back for ever: a finger "down" for
  // more than a few seconds is treated as lifted.
  const busy = () => (fingers > 0 && Date.now() - downAt < 5000) || Date.now() < busyUntil;
  const background = () => {
    if ((app.ui.draft && app.ui.tab === 'recipes') || typingIn() || busy()) { owed = true; return; }
    owed = false;
    render();
  };
  const settle = () => { if (owed) setTimeout(background, 0); };
  const quiet = () => { busyUntil = Date.now() + QUIET_MS; setTimeout(settle, QUIET_MS + 10); };
  root.addEventListener('focusout', (e) => {
    // Moving from one field to the next is still typing.
    if (!(e.relatedTarget && root.contains(e.relatedTarget) && e.relatedTarget.matches(FIELDS))) settle();
  });
  window.addEventListener('pointerdown', () => { fingers++; downAt = Date.now(); setTimeout(settle, 5010); }, { passive: true });
  const lift = () => { fingers = Math.max(0, fingers - 1); quiet(); };
  window.addEventListener('pointerup', lift, { passive: true });
  window.addEventListener('pointercancel', lift, { passive: true });
  window.addEventListener('scroll', quiet, { passive: true });
  app.store.subscribe(background);
  app.recipes.subscribe(background);
  app.start(background);
  render();

  window.addEventListener('hashchange', () => onAction('tab', location.hash.slice(1) || 'list'));
  return app;
}

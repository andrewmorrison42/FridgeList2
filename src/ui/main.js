// Mount point and router. Wires the store to the screen so that a merge always
// reaches it — FR-SYNC-7, §11.1.

import { createApp } from './app.js';
import { h, clear } from './dom.js';
import { statusBar, closeReport } from './status.js';
import { planView, listView, waitListView, recipesView } from './views.js';
import { connectView } from './connect.js';
import {
  recipeToDraft, blankRow, rebaseDraft, moveItem, deleteRecipe, setFeature, setStaple, removeStaple, setIngredient,
} from '../core/recipes-format.js';
import { parseImportPaste, draftFromImport, GRAB_RECIPE_BOOKMARKLET } from '../core/web-import.js';
import { recipeToText, recipeToHtml } from '../core/recipe-text.js';

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

/**
 * Put a recipe on the clipboard with its formatting, for an email or a
 * document, and as plain text for anywhere that cannot take formatting.
 */
async function copyRich(html, text) {
  try {
    if (html && navigator.clipboard?.write && typeof ClipboardItem === 'function') {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      })]);
      return true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      // Older browsers: copy from a hidden box.
      const box = Object.assign(document.createElement('textarea'), { value: text });
      box.style.cssText = 'position:fixed;opacity:0';
      document.body.append(box);
      box.select();
      const ok = document.execCommand('copy');
      box.remove();
      return ok;
    } catch { return false; }
  }
}

/** Print one part of the screen only (styles.css): the week's menu, for the fridge. */
function printOnly(cls) {
  document.body.classList.add(cls);
  const done = () => { document.body.classList.remove(cls); window.removeEventListener('afterprint', done); };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 1000);    // browsers that return from print() without afterprint
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
        app.ui.flash = null;
        if (app.ui.tab !== args[0]) app.ui.scrollTo = 0;
        app.ui.tab = args[0];
        location.hash = args[0];
        break;
      case 'openRecipe':
        // Into a recipe: its top. Back out: where the list was left.
        if (args[0]) { app.ui.listScroll = window.scrollY; app.ui.scrollTo = 0; }
        else app.ui.scrollTo = app.ui.listScroll ?? 0;
        app.ui.openRecipe = args[0];
        app.ui.flash = null;
        break;
      case 'plan':       app.planRecipe(args[0], args[1]); break;
      case 'unplan':     app.unplanRecipe(args[0]); break;
      case 'cooked':     app.markCooked(args[0]); break;
      case 'addWait':    app.addWaitList(args[0]); app.ui.waitSearch = ''; break;
      case 'addWaitText': app.addWaitListText(args[0]); app.ui.waitSearch = ''; break;
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
      case 'folderCheck':   await app.checkFolder(); break;
      case 'folderCreate':
        if (!confirm(`Make a new, empty ${app.config.folder} folder in this account's OneDrive?\n\n`
          + 'Only do this if nobody has shared the household folder with you — otherwise this phone will have a list of its own that no one else sees.')) break;
        try { await app.createFolder(); } catch (err) { app.folder = { state: 'error', error: err.message }; }
        break;
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
        app.ui.focus = '.ing-rows > :last-child .ing-name';   // ready to type into
        break;
      case 'draftAddHeading':
        app.ui.draft.rows.push({ heading: '' });
        app.ui.focus = '.ing-rows > :last-child .heading-name';
        break;
      case 'draftRemoveRow': app.ui.draft.rows.splice(args[0], 1); break;
      case 'draftMove':  moveItem(app.ui.draft, args[0], args[1]); break;
      case 'draftPick':  app.ui.draft.rows[args[0]].name = args[1]; break;
      case 'draftDelete': {
        const d = app.ui.draft;
        const name = d.name.trim() || 'this recipe';
        const planned = app.selections.has(d.id);
        if (!confirm(`Delete “${name}”? ${planned ? 'It is on this week\'s menu. ' : ''}This cannot be undone from the app.`)) break;
        d.saving = true; render();
        const out = await app.changeRecipes((current) => deleteRecipe(current, d.id));
        d.saving = false;
        if (out.error) { d.error = out.error; break; }
        app.ui.draft = null; app.ui.openRecipe = null;
        app.ui.scrollTo = app.ui.listScroll ?? 0;
        break;
      }

      // -- recipes: copy, share, keep awake, import --
      case 'copyRecipe': {
        const r = app.recipes.raw.recipes.find((x) => x.id === args[0]);
        app.ui.flash = (await copyRich(recipeToHtml(app.recipes.raw, r), recipeToText(app.recipes.raw, r)))
          ? 'Copied — paste it into an email or a message.' : 'Could not reach the clipboard on this device.';
        break;
      }
      case 'shareRecipe': {
        const r = app.recipes.raw.recipes.find((x) => x.id === args[0]);
        try { await navigator.share({ title: r.name, text: recipeToText(app.recipes.raw, r) }); } catch { /* dismissed */ }
        return;
      }
      case 'keepAwake':  app.wake.wanted = args[0]; break;
      case 'importOpen': app.ui.importing = { text: '' }; app.ui.scrollTo = 0; app.ui.flash = null; break;
      case 'importCancel': app.ui.importing = null; app.ui.flash = null; break;
      case 'importPaste':
        try { app.ui.importing.text = await navigator.clipboard.readText(); }
        catch { app.ui.importing.error = 'Could not read the clipboard — paste into the box instead.'; }
        break;
      case 'importParse': {
        const im = app.ui.importing;
        const parsed = parseImportPaste(im.text);
        if (!parsed) { im.error = 'Paste the recipe into the box first.'; break; }
        const draft = draftFromImport(app.recipes.raw, parsed);
        if (parsed.weak) {
          draft.error = 'Could not find "Ingredients" and "Method" headings in that text, so only the name was picked up. '
            + 'Fill in the rest, or go back and try the Grab Recipe bookmark.';
        }
        app.ui.importing = null;
        app.ui.draft = draft;
        app.ui.scrollTo = 0;
        break;
      }
      case 'copyGrabCode':
        app.ui.flash = (await copyRich(null, GRAB_RECIPE_BOOKMARKLET))
          ? 'Copied. Now make a bookmark and paste this as its address.' : 'Could not reach the clipboard on this device.';
        break;
      case 'printMenu':  printOnly('print-menu'); return;
      case 'printList':  window.print(); return;

      // -- Setup: the household's switches, staples, the ingredient list --
      case 'feature':       await settingsChange((src) => setFeature(src, args[0], args[1])); break;
      case 'stapleSet':     await settingsChange((src) => setStaple(src, args[0], args[1])); break;
      case 'stapleRemove':  await settingsChange((src) => removeStaple(src, args[0])); break;
      case 'stapleAdd': {
        const add = app.ui.stapleAdd;
        if (!add.name.trim()) break;
        if (await settingsChange((src) => setStaple(src, add.name, add.qty))) app.ui.stapleAdd = { name: '', qty: '' };
        break;
      }
      case 'ingredientSet': await settingsChange((src) => setIngredient(src, args[0], args[1])); break;
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

  /** A change to the shared settings or ingredient list. Returns whether it saved. */
  async function settingsChange(change) {
    const out = await app.changeRecipes(change);
    app.ui.settingsError = out.error ?? null;
    return !out.error;
  }

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
    app.wake.apply(app.ui.tab === 'recipes' && !!app.ui.openRecipe && !app.ui.draft && !app.ui.importing);
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
  // Which folder this account reaches — its own, or someone's through a
  // shortcut — shown in Setup, and the reason if none.
  app.checkFolder({ refresh: false }).then(background, () => {});

  window.addEventListener('hashchange', () => onAction('tab', location.hash.slice(1) || 'list'));
  return app;
}

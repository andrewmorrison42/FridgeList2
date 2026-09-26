// Application wiring: identity, storage, store, sync, presence, actions.
//
// This module owns every side effect. The rule that made FR-SYNC-7 testable is
// worth keeping as the code grows: state handling stays in core/, and adapters
// stay dumb. Nothing here decides how a conflict resolves — that lives in
// merge.js and nowhere else (§5.4), so that every such decision is somewhere a
// property test is watching.

import { createStore } from '../core/store.js';
import { currentShop, nextShopId, permissions, explainRefusal } from '../core/shop.js';
import { cookHistory } from '../core/library.js';
import { selections, carryOverTransitions } from '../core/carryover.js';
import { generate, freeTextId } from '../core/generate.js';
import { createDevice } from '../core/events.js';
import { createMemoryStorage } from '../data/storage.js';
import { createDrive, createOneDriveStorage, createOneDriveFiles } from '../data/onedrive.js';
import { createAuth } from '../data/auth.js';
import { createSync } from '../data/sync.js';
import { createPresence, staleness } from '../data/presence.js';
import { openLocal, deviceIdentity, local } from '../data/persist.js';
import { createRecipeSource } from '../data/recipes.js';
import { applyDraft } from '../core/recipes-format.js';
import { createWakeLock } from './wakelock.js';
import { VERSION, RELEASED } from '../version.js';

const SEED = 'data/recipes-data.reviewed.json';

/** The recipe file this device uses: as set in Setup, or recipes-data.json in the folder. */
export function recipesPath(config) {
  const set = (config.recipesFile ?? '').trim();
  if (set) return set.startsWith('/') ? set : `/${set}`;
  return `${config.folder.replace(/\/+$/, '')}/recipes-data.json`;
}

/** Per-device configuration. Never shared — it only decides how this phone reaches the folder. */
export function readConfig() {
  return {
    clientId: local.get('clientId', ''),
    folder: local.get('folder', '/FridgeList'),
    storageMode: local.get('storageMode', 'local'),
    recipesFile: local.get('recipesFile', ''),
    authError: null,
  };
}

export async function createApp({ storage } = {}) {
  const identity = deviceIdentity();
  const config = readConfig();

  // Storage is chosen here and nowhere else: nothing above this line knows
  // which backend it has (§15.2). Without a client id the app runs entirely on
  // this device, which is also how it degrades if the backend is unreachable.
  let auth = null;
  let drive = null;
  if (!storage && config.clientId) {
    auth = createAuth({ clientId: config.clientId });
    try {
      await auth.completeSignIn();
    } catch (err) {
      config.authError = err.message;
    }
    if (auth.connected) {
      // One view of OneDrive for this account, shared by the logs and the
      // recipe file, so the household folder is found once — through the
      // shortcut to it if it is someone else's (data/onedrive.js).
      drive = createDrive({ getToken: () => auth.getToken() });
      storage = createOneDriveStorage({ drive, root: config.folder });
      config.storageMode = 'onedrive';
    }
  }
  storage = storage ?? createMemoryStorage();
  const persisted = await openLocal();
  const store = createStore(await persisted.all());
  const device = createDevice(identity.id);
  device.observe(store.events);

  // Recipes come from a file, not the event log (§12): the household's own
  // recipes-data.json when connected, shared with the earlier app; otherwise a
  // copy on this device started from the seed.
  const recipes = createRecipeSource({
    file: drive ? createOneDriveFiles({ drive }) : null,
    path: recipesPath(config),
    cache: persisted.files,
    fetchSeed: async () => {
      const res = await fetch(SEED);
      if (!res.ok) throw new Error(`${SEED}: ${res.status}`);
      return res.text();
    },
  });
  await recipes.init();

  const sync = createSync({ storage, store, deviceId: identity.id });
  const presence = createPresence({ storage, deviceId: identity.id, nickname: identity.nickname });

  // Everything that reaches local state is persisted, so a closed tab loses
  // nothing and the next open is instant (§7.1).
  store.subscribe(() => persisted.put(store.events).catch(() => {}));

  let roster = [];
  let timer = null;

  /** Record events: local state and screen first, upload after (§7.1). */
  const record = (events) => {
    device.observe(store.events);
    return sync.record(events);
  };

  const app = {
    identity, store, sync, presence, storage, config, auth, recipes, drive,
    /** Which folder this account reaches, for Setup: { state, found, shared, owner, alsoShared, error }. */
    folder: { state: drive ? 'checking' : 'none' },
    version: VERSION, released: RELEASED,
    wake: createWakeLock(),

    get shop() { return currentShop(store.events); },
    get can() { return permissions(store.events); },
    get library() { return recipes.library; },
    get selections() { return selections(store.events); },
    get history() { return cookHistory(store.events); },
    get roster() { return roster; },
    get staleness() { return staleness(sync.status(), roster); },
    why: (action) => explainRefusal(store.events, action),

    /** The generated list for the current shop, derived — never stored (§5.5). */
    list() {
      const { id } = currentShop(store.events);
      const dismissed = new Set(
        [...store.state].filter(([k, v]) => k.startsWith(`carryover:${id}:`) && v.value === true)
          .map(([k]) => k.split(':')[2]),
      );
      const prefix = `line:${id}:`;
      const added = new Set(
        [...store.state].filter(([k, v]) => k.startsWith(prefix) && k.endsWith(':present') && v.value === true)
          .map(([k]) => k.slice(prefix.length, -':present'.length)),
      );
      return generate(this.library, {
        events: store.events, shopId: id, waitList: this.waitList(), dismissed, added,
      });
    },

    waitList() {
      const out = [];
      for (const [key, reg] of store.state) {
        const m = /^waitlist:(.+):present$/.exec(key);
        if (m && reg.value === true) {
          const p = reg.by[0]?.payload ?? {};
          out.push({ id: m[1], ingredientId: p.ingredientId ?? null, text: p.text ?? null, note: p.note ?? null, qty: p.qty ?? 1 });
        }
      }
      return out;
    },

    // -- actions ------------------------------------------------------------

    planRecipe(recipeId, servings) {
      const { id, phase } = currentShop(store.events);
      return record(device.emit('menu.selection',
        { recipeId, present: true, servings, plannedFor: id }, phase));
    },

    unplanRecipe(recipeId) {
      const { phase } = currentShop(store.events);
      return record(device.emit('menu.selection', { recipeId, present: false }, phase));
    },

    markCooked(recipeId, cooked = true) {
      const { phase } = currentShop(store.events);
      return record(device.emit('menu.cooked', { recipeId, cooked }, phase));
    },

    addWaitList(ingredientId, note = null) {
      const { phase } = currentShop(store.events);
      const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      return record(device.emit('waitlist.item', { itemId: id, ingredientId, note, present: true }, phase));
    },

    /** Something not in the ingredient list — "bin bags", "birthday candles". */
    addWaitListText(text, note = null) {
      const { phase } = currentShop(store.events);
      const id = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
      return record(device.emit('waitlist.item', { itemId: id, ingredientId: null, text: text.trim(), note, present: true }, phase));
    },

    removeWaitList(itemId) {
      const { phase } = currentShop(store.events);
      return record(device.emit('waitlist.item', { itemId, present: false }, phase));
    },

    /** The pantry check — draft only (FR-LIST-3). A Wait List line is fulfilled. */
    suppressLine(ingredientId) {
      const { id, phase } = currentShop(store.events);
      const events = [device.emit('line.suppressed', { shopId: id, ingredientId, suppressed: true }, phase)];
      for (const item of this.waitList()) {
        if ((item.ingredientId ?? freeTextId(item.text)) !== ingredientId) continue;
        // "We already have it" settles the Wait List entry just as buying it
        // would; leaving it open makes it reappear on every future shop.
        events.push(device.emit('waitlist.item', { itemId: item.id, present: false }, phase));
      }
      return record(events);
    },

    addLine(ingredientId) {
      const { id, phase } = currentShop(store.events);
      return record(device.emit('line.added', { shopId: id, ingredientId, present: true }, phase));
    },

    setDone(ingredientId, done) {
      const { id } = currentShop(store.events);
      return record(device.emit('line.done', { shopId: id, ingredientId, done }, 'open'));
    },

    dismissCarryOver(ingredientId) {
      const { id, phase } = currentShop(store.events);
      return record(device.emit('carryover.dismissed', { shopId: id, ingredientId, dismissed: true }, phase));
    },

    /** Generate: carry-over transitions, then the proposal. Draft only (§5.7). */
    generateList() {
      const { id } = currentShop(store.events);
      const transitions = carryOverTransitions(store.events, id, device);
      if (transitions.length) record(transitions);
      return this.list();
    },

    /** "Menu is settled" — one press locks it for everyone (§8.1). */
    lockShop() {
      const { id } = currentShop(store.events);
      return record(device.emit('shop.locked', { shopId: id, locked: true }, 'draft'));
    },

    /** "Shopping is completed" (FR-SHOP-4). Writes the trip record with it. */
    async closeShop() {
      const { id } = currentShop(store.events);
      const chosen = [...selections(store.events).values()].map((s) => s.recipeId);
      const ev = device.emit('shop.closed', {
        shopId: id, closed: true, nextShopId: nextShopId(id),
        selections: chosen, closedAt: new Date().toISOString(),
      }, 'open');
      // Every done line from a Wait List item fulfils it (FR-LIST-7).
      const { lines } = this.list();
      const fulfil = [];
      for (const line of lines) {
        if (!store.get(`line:${id}:${line.ingredientId}:done`)) continue;
        for (const src of line.sources) {
          if (src.kind === 'waitlist') {
            fulfil.push(device.emit('waitlist.item', { itemId: src.itemId, present: false }, 'open'));
          }
        }
      }
      record([ev, ...fulfil]);
      await presence.leave(id).catch(() => {});
      await sync.tick().catch(() => {});
      return ev;
    },

    /** What still is not done, at the point the household believes it is. FR-SYNC-4.3. */
    outstanding() {
      const { id } = currentShop(store.events);
      return this.list().lines.filter((l) => !store.get(`line:${id}:${l.ingredientId}:done`));
    },

    // -- lifecycle ----------------------------------------------------------

    async joinShop({ silent = false } = {}) {
      const { id } = currentShop(store.events);
      await presence.join(id, { silent });
      roster = await presence.roster(id);
    },

    async refresh({ force = false } = {}) {
      await Promise.all([sync.tick(), recipes.refresh({ force })]);
      const { id, phase } = currentShop(store.events);
      if (phase === 'open') {
        if (presence.joined) await presence.beat(id, { syncStatus: sync.status() });
        roster = await presence.roster(id);
      }
      return sync.status();
    },

    /** Poll fast while shopping, lazily otherwise (§7.3). */
    start(onTick = () => {}) {
      const loop = async () => {
        try { await app.refresh(); } catch { /* status() reports it */ }
        // A screen that fails to draw must not stop syncing: the next change
        // that arrives may be the one that lets it draw.
        try { onTick(); } catch (err) { console.error(err); }
        timer = setTimeout(loop, sync.intervalMs());
      };
      loop();
    },

    stop() { clearTimeout(timer); timer = null; },

    setNickname(name) {
      local.set('nickname', name);
      identity.nickname = name;
    },

    setConfig(key, value) {
      local.set(key, value);
      config[key] = value;
    },

    /** Look (again) for the household folder, through a shortcut if need be. */
    async checkFolder({ refresh = true } = {}) {
      if (!drive) return app.folder;
      drive.forget();
      app.folder = { state: 'checking' };
      try {
        const d = await drive.describe(config.folder);
        app.folder = { state: d.found ? 'found' : 'missing', ...d };
      } catch (err) {
        app.folder = { state: 'error', error: err.message };
      }
      if (refresh) await app.refresh({ force: true }).catch(() => {});
      return app.folder;
    },

    /** Start a household folder in this account's own OneDrive — only when asked. */
    async createFolder() {
      await drive.createFolder(config.folder);
      return app.checkFolder();
    },

    /** Send this device to Microsoft to sign in. Returns here afterwards. */
    async connect() {
      if (!config.clientId) throw new Error('Paste the Application (client) ID first.');
      local.set('storageMode', 'onedrive');
      await createAuth({ clientId: config.clientId }).signIn();
    },

    disconnect() {
      if (auth) auth.signOut();
      local.set('storageMode', 'local');
      config.storageMode = 'local';
    },

    /** Save a recipe from the editor to the recipe file. */
    saveRecipe(draft) {
      return app.changeRecipes((current) => applyDraft(current, draft));
    },

    /**
     * Any change to the recipe file — a recipe, the ingredient list, staples,
     * the shared switches. Guarded like every write to it (data/recipes.js).
     */
    async changeRecipes(change) {
      try {
        return await recipes.update(change);
      } catch (err) {
        return { error: `Could not save: ${err.message}. Nothing was changed — try again when you have signal.` };
      }
    },
  };

  return app;
}

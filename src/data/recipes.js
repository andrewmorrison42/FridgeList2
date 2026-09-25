// Where the recipes come from: a JSON file the household chooses. §12.
//
// Recipes are not events. They live in the same file the earlier version of
// the app reads and writes (its `recipes-data.json`), so both versions see the
// same book. On a device not connected to OneDrive, the file is a local copy
// started from the seed that ships with the app.
//
// Reading: the file is cached on the device, so the recipe book opens instantly
// and works in a dead spot. It is re-checked by its eTag, which costs one small
// request and no download when nothing has changed.
//
// Writing: the file is shared with another app that writes it whole, so a save
// never writes what was read when the editor opened. It re-reads the file,
// applies the one recipe's edit to what is there now, and writes only if the
// file has not changed since that read (If-Match). If it has, it goes round
// again. Someone else's edit to a different recipe survives; an edit to the
// same recipe is refused rather than overwritten.

import { importLibrary, applyDraft } from '../core/recipes-format.js';

export const CONFLICT = Symbol('CONFLICT');
const RECHECK_MS = 30000;
const ATTEMPTS = 4;

/**
 * @param {object} opts
 * @param {object|null} opts.file   file access (see createMemoryFiles), or null for a local copy
 * @param {string} [opts.path]      the file's path, when `file` is given
 * @param {{ get(k), set(k, v) }} opts.cache  device-local store for the last copy seen
 * @param {() => Promise<string>} opts.fetchSeed  the seed recipe book, as text
 */
export function createRecipeSource({ file, path, cache, fetchSeed, now = () => Date.now() }) {
  const mode = file ? 'file' : 'local';
  const key = mode === 'file' ? `recipes:${path}` : 'recipes:local';
  const listeners = new Set();
  let content = null;          // the file's text, as last seen
  let source = null;           // ...parsed
  let etag = null;
  let state = 'loading';       // loading | ok | missing | error
  let error = null;
  let checkedAt = 0;
  let memo = { from: null, library: null };

  const notify = () => { for (const fn of listeners) fn(); };

  async function adopt(text, tag) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.recipes) || !Array.isArray(parsed.ingredients)) {
      throw new Error('that file is not a recipe book (it has no recipes and ingredients)');
    }
    const changed = text !== content;
    content = text; source = parsed; etag = tag;
    await cache.set(key, { content: text, etag: tag }).catch(() => {});
    if (changed) notify();
  }

  const self = {
    mode, path,

    async init() {
      const cached = await cache.get(key).catch(() => null);
      if (cached?.content) {
        try { await adopt(cached.content, cached.etag ?? null); state = mode === 'local' ? 'ok' : state; }
        catch { /* a bad cache is no cache */ }
      }
      if (mode === 'local' && !source) {
        try { await adopt(await fetchSeed(), null); state = 'ok'; }
        catch (err) { state = 'error'; error = `could not load the starter recipes: ${err.message}`; }
      }
    },

    /** Look for a newer copy. Cheap when nothing changed; throttled unless forced. */
    async refresh({ force = false } = {}) {
      if (mode === 'local') return;
      if (!force && now() - checkedAt < RECHECK_MS) return;
      checkedAt = now();
      try {
        const meta = await file.stat(path);
        if (!meta) { state = 'missing'; error = null; notify(); return; }
        if (meta.etag !== etag || !source) {
          const got = await file.read(path);
          if (!got) { state = 'missing'; notify(); return; }
          await adopt(got.content, got.etag);
        }
        const was = state;
        state = 'ok'; error = null;
        if (was !== 'ok') notify();
      } catch (err) {
        state = 'error'; error = err.message;
        notify();
      }
    },

    /**
     * Save one recipe's draft.
     * @returns {Promise<{ recipeId } | { error } | { conflict: true }>}
     */
    async save(draft) {
      if (mode === 'local') {
        const out = applyDraft(source, draft);
        if (out.error || out.conflict) return out;
        if (!out.unchanged) await adopt(JSON.stringify(out.source), null);
        return { recipeId: out.recipeId };
      }
      for (let i = 0; i < ATTEMPTS; i++) {
        const got = await file.read(path);
        if (!got) { state = 'missing'; notify(); return { error: `The recipe file ${path} is not there any more.` }; }
        const current = JSON.parse(got.content);
        const out = applyDraft(current, draft);
        if (out.error || out.conflict) {
          await adopt(got.content, got.etag);    // show what is there now
          return out;
        }
        if (out.unchanged) { await adopt(got.content, got.etag); return { recipeId: out.recipeId }; }
        const text = JSON.stringify(out.source);
        const wrote = await file.put(path, text, { ifMatch: got.etag });
        if (wrote === CONFLICT) continue;        // changed between our read and write: go round
        await adopt(text, wrote.etag);
        state = 'ok'; error = null; checkedAt = now();
        return { recipeId: out.recipeId };
      }
      return { error: 'The recipe file kept changing while saving. Nothing was overwritten — try again in a moment.' };
    },

    /** Start a recipe file where there is none, from the seed. Never overwrites one. */
    async createFromSeed() {
      const text = await fetchSeed();
      // Belt and braces: look first, and also ask OneDrive to refuse the write
      // if a file has appeared since. Either way an existing file is kept.
      if (await file.stat(path)) return self.refresh({ force: true });
      const wrote = await file.put(path, text, { ifNoneMatch: '*' });
      if (wrote !== CONFLICT) await adopt(text, wrote.etag);
      await self.refresh({ force: true });
    },

    status() {
      return { mode, path, state, error, checkedAt, recipes: source?.recipes.length ?? 0 };
    },

    /** The file as it is, for the editor to start from. */
    get raw() { return source; },

    /** The shape generate.js and the views use, rebuilt only when the file changes. */
    get library() {
      if (memo.from !== source) {
        const lib = source ? importLibrary(source).library : { recipes: [], ingredients: [] };
        memo = {
          from: source,
          library: {
            recipes: new Map(lib.recipes.map((r) => [r.id, r])),
            ingredients: new Map(lib.ingredients.map((i) => [i.id, i])),
          },
        };
      }
      return memo.library;
    },

    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return self;
}

/**
 * File access in memory, with the same semantics as the OneDrive one: eTags,
 * If-Match and If-None-Match. For tests, and to show the contract.
 *
 *   stat(path)                  → { etag } | null
 *   read(path)                  → { content, etag } | null
 *   put(path, text, { ifMatch?, ifNoneMatch? }) → { etag } | CONFLICT
 */
export function createMemoryFiles(initial = {}) {
  const files = new Map(Object.entries(initial).map(([p, c]) => [p, { content: c, etag: 'v0' }]));
  let seq = 0;
  return {
    files,
    async stat(p) { const f = files.get(p); return f ? { etag: f.etag } : null; },
    async read(p) { const f = files.get(p); return f ? { content: f.content, etag: f.etag } : null; },
    async put(p, content, { ifMatch, ifNoneMatch } = {}) {
      const f = files.get(p);
      if (ifNoneMatch === '*' && f) return CONFLICT;
      if (ifMatch && (!f || f.etag !== ifMatch)) return CONFLICT;
      const etag = `v${++seq}`;
      files.set(p, { content, etag });
      return { etag };
    },
    /** Another app writing the file whole, as the earlier version does. */
    overwrite(p, content) { files.set(p, { content, etag: `v${++seq}` }); },
  };
}

// The recipe file is written by two apps. These check the save path: a save
// applies its one edit to the file as it is now, never to the copy the editor
// opened on, and never writes over a change it has not seen.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRecipeSource, createMemoryFiles, CONFLICT } from '../src/data/recipes.js';
import { recipeToDraft } from '../src/core/recipes-format.js';

const seedText = readFileSync(new URL('../data/recipes-data.reviewed.json', import.meta.url), 'utf8');
const PATH = '/FridgeList/recipes-data.json';
const memCache = () => { const m = new Map(); return { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v); } }; };
const recipe = (text, id) => JSON.parse(text).recipes.find((r) => r.id === id);

async function setup(initial = { [PATH]: seedText }) {
  const file = createMemoryFiles(initial);
  let t = 0;
  const src = createRecipeSource({ file, path: PATH, cache: memCache(), fetchSeed: async () => seedText, now: () => (t += 60000) });
  await src.init();
  await src.refresh({ force: true });
  return { file, src };
}

/** The earlier app changing another recipe, written whole. */
function otherAppEdits(file, id, notes) {
  const s = JSON.parse(file.files.get(PATH).content);
  s.recipes.find((r) => r.id === id).notes = notes;
  file.overwrite(PATH, JSON.stringify(s));
}

describe('recipe file', () => {
  it('reads the file and builds the library from it', async () => {
    const { src } = await setup();
    expect(src.status()).toMatchObject({ state: 'ok', recipes: 638 });
    expect(src.library.recipes.get('mushroom-risotto').name).toBe('Mushroom Risotto');
  });

  it('before the first read, the library is empty rather than missing', async () => {
    // A phone connecting for the first time has no saved copy yet. Every
    // screen draws from the library, so "none yet" must still be a library.
    const file = createMemoryFiles({ [PATH]: seedText });
    const src = createRecipeSource({ file, path: PATH, cache: memCache(), fetchSeed: async () => seedText });
    await src.init();
    expect(src.library.recipes.size).toBe(0);
    expect(src.library.ingredients.size).toBe(0);
    await src.refresh({ force: true });
    expect(src.library.recipes.size).toBe(638);
  });

  it('keeps an edit the other app made to a different recipe while the editor was open', async () => {
    const { file, src } = await setup();
    const draft = recipeToDraft(src.raw, 'mushroom-risotto');
    draft.notes = 'ours';
    otherAppEdits(file, 'pumpkin-and-bean-curry', 'theirs');   // after we opened, before we saved

    expect(await src.save(draft)).toEqual({ recipeId: 'mushroom-risotto' });
    const now = file.files.get(PATH).content;
    expect(recipe(now, 'mushroom-risotto').notes).toBe('ours');
    expect(recipe(now, 'pumpkin-and-bean-curry').notes).toBe('theirs');
  });

  it('goes round again when the file changes between its read and its write', async () => {
    const { file, src } = await setup();
    const put = file.put.bind(file);
    let raced = false;
    file.put = async (...args) => {
      if (!raced) { raced = true; otherAppEdits(file, 'pumpkin-and-bean-curry', 'theirs'); }
      return put(...args);
    };
    const draft = recipeToDraft(src.raw, 'mushroom-risotto');
    draft.notes = 'ours';
    expect(await src.save(draft)).toEqual({ recipeId: 'mushroom-risotto' });
    const now = file.files.get(PATH).content;
    expect(recipe(now, 'mushroom-risotto').notes).toBe('ours');
    expect(recipe(now, 'pumpkin-and-bean-curry').notes).toBe('theirs');
  });

  it('refuses, and writes nothing, when the other app changed the same recipe', async () => {
    const { file, src } = await setup();
    const draft = recipeToDraft(src.raw, 'mushroom-risotto');
    draft.notes = 'ours';
    otherAppEdits(file, 'mushroom-risotto', 'theirs');
    const before = file.files.get(PATH);

    expect(await src.save(draft)).toEqual({ conflict: true });
    expect(file.files.get(PATH)).toBe(before);
    // And the device now shows their version, to edit again from.
    expect(src.raw.recipes.find((r) => r.id === 'mushroom-risotto').notes).toBe('theirs');
  });

  it('picks up the other app\'s changes on the next check', async () => {
    const { file, src } = await setup();
    otherAppEdits(file, 'mushroom-risotto', 'theirs');
    await src.refresh({ force: true });
    expect(src.library.recipes.get('mushroom-risotto').notes).toBe('theirs');
  });

  it('works from the cached copy when OneDrive cannot be reached', async () => {
    const { file, src } = await setup();
    file.stat = async () => { throw new Error('offline'); };
    await src.refresh({ force: true });
    expect(src.status()).toMatchObject({ state: 'error', recipes: 638 });
    expect(src.library.recipes.size).toBe(638);
  });

  it('says a missing file is missing, and starting one never overwrites an existing file', async () => {
    const { file, src } = await setup({});
    expect(src.status().state).toBe('missing');
    // Someone else creates it first.
    file.overwrite(PATH, JSON.stringify({ recipes: [], ingredients: [] }));
    await src.createFromSeed();
    expect(JSON.parse(file.files.get(PATH).content).recipes).toHaveLength(0);
    expect(src.status()).toMatchObject({ state: 'ok', recipes: 0 });
  });

  it('memory files honour If-Match and If-None-Match', async () => {
    const file = createMemoryFiles({ '/a': 'x' });
    expect(await file.put('/a', 'y', { ifMatch: 'nope' })).toBe(CONFLICT);
    expect(await file.put('/a', 'y', { ifNoneMatch: '*' })).toBe(CONFLICT);
    expect(await file.put('/a', 'y', { ifMatch: 'v0' })).toEqual({ etag: 'v1' });
  });

  it('without OneDrive, edits a local copy started from the seed', async () => {
    const src = createRecipeSource({ file: null, cache: memCache(), fetchSeed: async () => seedText });
    await src.init();
    const draft = recipeToDraft(src.raw, 'mushroom-risotto');
    draft.notes = 'ours';
    await src.save(draft);
    expect(src.library.recipes.get('mushroom-risotto').notes).toBe('ours');
  });
});

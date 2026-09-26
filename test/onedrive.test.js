// The OneDrive adapter, through a fake Graph that behaves like the real one
// where it matters (test/fakes/graph.js): separate people with separate
// drives, a folder shared by one with the others and reached by a shortcut,
// and delta that reports names and parent ids rather than paths.

import { describe, it, expect } from 'vitest';
import { createFakeGraph } from './fakes/graph.js';
import { describeStorageContract } from './contract.js';
import { createDrive, createOneDriveStorage, createOneDriveFiles, FolderNotFound } from '../src/data/onedrive.js';
import { CONFLICT } from '../src/data/recipes.js';
import { createDevice } from '../src/core/events.js';
import { createStore } from '../src/core/store.js';
import { createSync } from '../src/data/sync.js';
import { isDone } from '../src/core/merge.js';

/** A household: Dad owns FridgeList and shares it; Theo has a shortcut to it; Greta does not yet. */
function household() {
  const g = createFakeGraph();
  g.addPerson('dad', 'Andrew');
  g.addPerson('theo', 'Theo');
  g.addPerson('greta', 'Greta');
  const folder = g.folder('dad', 'FridgeList');
  g.file('dad', 'FridgeList/recipes-data.json', '{"recipes":[],"ingredients":[]}');
  g.share(folder, 'theo');
  g.shortcut('theo', 'FridgeList', folder);
  return { g, folder };
}
const driveFor = (g, person) => createDrive({ getToken: async () => person, fetchImpl: g.fetch });

describeStorageContract('OneDrive (own folder, fake Graph)', () => {
  const g = createFakeGraph();
  g.addPerson('dad');
  g.folder('dad', 'FridgeList');
  return createOneDriveStorage({ drive: driveFor(g, 'dad'), root: '/FridgeList' });
});

describeStorageContract('OneDrive (shared folder through a shortcut, fake Graph)', () => {
  const { g } = household();
  return createOneDriveStorage({ drive: driveFor(g, 'theo'), root: '/FridgeList' });
});

describe('finding the household folder', () => {
  it('follows a shortcut to the folder in the owner\'s drive, and says whose it is', async () => {
    const { g, folder } = household();
    const drive = driveFor(g, 'theo');
    const ref = await drive.folder('/FridgeList');
    expect(ref).toMatchObject({ driveId: 'drive-dad', itemId: folder.id, shared: true, via: 'shortcut' });
    expect(await drive.describe('/FridgeList')).toMatchObject({ found: true, shared: true, owner: 'Andrew' });
  });

  it('finds a folder shared with you even without the shortcut', async () => {
    const { g, folder } = household();
    g.share(folder, 'greta');
    expect(await driveFor(g, 'greta').folder('/FridgeList')).toMatchObject({ itemId: folder.id, via: 'shared-with-me' });
  });

  it('says there is none, and creates nothing, when nothing is shared', async () => {
    const { g } = household();
    const drive = driveFor(g, 'greta');
    expect(await drive.folder('/FridgeList')).toBeNull();
    const storage = createOneDriveStorage({ drive, root: '/FridgeList' });
    await expect(storage.write('state/log/g.jsonl', 'x')).rejects.toBeInstanceOf(FolderNotFound);
    await expect(storage.delta()).rejects.toBeInstanceOf(FolderNotFound);
    expect(g.read('greta', 'FridgeList')).toBeNull();
    expect(g.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('warns when an account uses a folder of its own while the household\'s is shared with it', async () => {
    const { g, folder } = household();
    g.folder('greta', 'FridgeList');                // made by mistake, e.g. by an older version
    g.share(folder, 'greta');
    expect(await driveFor(g, 'greta').describe('/FridgeList')).toMatchObject({ found: true, shared: false, alsoShared: 'Andrew' });
  });

  it('creates a folder only when asked', async () => {
    const { g } = household();
    const drive = driveFor(g, 'greta');
    const ref = await drive.createFolder('/FridgeList');
    expect(ref).toMatchObject({ driveId: 'drive-greta', shared: false });
  });
});

describe('the logs, in the shared folder', () => {
  it('a phone signed in as Theo writes into Dad\'s folder, creating the log folders it needs', async () => {
    const { g } = household();
    const storage = createOneDriveStorage({ drive: driveFor(g, 'theo'), root: '/FridgeList' });
    await storage.write('shops/shop-0001/log/theo.jsonl', '{"a":1}');
    expect(g.read('dad', 'FridgeList/shops/shop-0001/log/theo.jsonl')).toBe('{"a":1}');
  });

  it('delta gives full paths, across pages, for files written by either person', async () => {
    const { g } = household();
    const dad = createOneDriveStorage({ drive: driveFor(g, 'dad'), root: '/FridgeList' });
    const theo = createOneDriveStorage({ drive: driveFor(g, 'theo'), root: '/FridgeList' });
    await dad.delta();                                  // the first call catches up on everything
    for (let i = 0; i < 5; i++) await theo.write(`state/log/t${i}.jsonl`, `${i}`);
    await theo.write('shops/shop-0001/log/theo.jsonl', 'x');
    const { changes } = await dad.delta();
    expect(changes.sort()).toEqual([
      'shops/shop-0001/log/theo.jsonl',
      ...[0, 1, 2, 3, 4].map((i) => `state/log/t${i}.jsonl`),
    ]);
  });

  it('where delta is refused, lists the folder instead and still finds every file', async () => {
    const { g } = household();
    const drive = driveFor(g, 'theo');
    const refuse = (inner) => async (url, init) => (String(url).includes('/delta')
      ? new Response('{"error":{"code":"accessDenied"}}', { status: 403 }) : inner(url, init));
    const storage = createOneDriveStorage({ drive: createDrive({ getToken: async () => 'theo', fetchImpl: refuse(g.fetch) }), root: '/FridgeList' });
    await createOneDriveStorage({ drive, root: '/FridgeList' }).write('state/log/d.jsonl', 'x');
    expect((await storage.delta()).changes.sort()).toEqual(['recipes-data.json', 'state/log/d.jsonl']);
  });
});

describe('two phones, two accounts, one shared folder', () => {
  function phone(id, storage) {
    const device = createDevice(id);
    const store = createStore();
    const sync = createSync({ storage, store, deviceId: id });
    return {
      sync, store,
      tick: (line) => sync.record(device.observe(store.events).emit('line.done', { shopId: 's1', ingredientId: line, done: true }, 'open')),
      done: (line) => isDone(store.events, 's1', line),
    };
  }

  it('a tick made on Theo\'s phone reaches Dad\'s, and back', async () => {
    const { g } = household();
    const dad = phone('dad-phone', createOneDriveStorage({ drive: driveFor(g, 'dad'), root: '/FridgeList' }));
    const theo = phone('theo-phone', createOneDriveStorage({ drive: driveFor(g, 'theo'), root: '/FridgeList' }));

    theo.tick('milk');
    await theo.sync.tick();
    await dad.sync.tick();
    expect(dad.done('milk')).toBe(true);

    dad.tick('bread');
    await dad.sync.tick();
    await theo.sync.tick();
    expect(theo.done('bread')).toBe(true);
    expect(theo.done('milk')).toBe(true);
  });
});

describe('the recipe file, in the shared folder', () => {
  it('is read through the shortcut, and written only if unchanged since read', async () => {
    const { g } = household();
    const files = createOneDriveFiles({ drive: driveFor(g, 'theo') });
    const got = await files.read('/FridgeList/recipes-data.json');
    expect(JSON.parse(got.content)).toEqual({ recipes: [], ingredients: [] });
    expect(await files.stat('/FridgeList/recipes-data.json')).toEqual({ etag: got.etag });

    g.file('dad', 'FridgeList/recipes-data.json', '{"recipes":[1],"ingredients":[]}');   // Dad's phone saves
    expect(await files.put('/FridgeList/recipes-data.json', 'mine', { ifMatch: got.etag })).toBe(CONFLICT);
    const again = await files.read('/FridgeList/recipes-data.json');
    expect(await files.put('/FridgeList/recipes-data.json', 'mine', { ifMatch: again.etag })).toHaveProperty('etag');
    expect(g.read('dad', 'FridgeList/recipes-data.json')).toBe('mine');
  });

  it('is never created over one that exists', async () => {
    const { g } = household();
    const files = createOneDriveFiles({ drive: driveFor(g, 'theo') });
    expect(await files.put('/FridgeList/recipes-data.json', 'new', { ifNoneMatch: '*' })).toBe(CONFLICT);
  });

  it('with no shared folder, says so rather than reading as missing', async () => {
    const { g } = household();
    const files = createOneDriveFiles({ drive: driveFor(g, 'greta') });
    await expect(files.stat('/FridgeList/recipes-data.json')).rejects.toBeInstanceOf(FolderNotFound);
  });
});

describe('more than one folder of the same name', () => {
  // What happened on the first real trial: Theo's account could see a
  // FridgeList started from the starter recipes by another account, as well
  // as the household's, and the app picked the wrong one.
  function twoFolders() {
    const g = createFakeGraph();
    g.addPerson('dad', 'Andrew'); g.addPerson('greta', 'Greta'); g.addPerson('theo', 'Theo');
    const greta = g.folder('greta', 'FridgeList');
    g.file('greta', 'FridgeList/recipes-data.json', JSON.stringify({ recipes: new Array(638).fill({}), ingredients: [] }));
    const dad = g.folder('dad', 'FridgeList');
    g.file('dad', 'FridgeList/recipes-data.json', JSON.stringify({ recipes: new Array(670).fill({}), ingredients: [] }));
    g.share(greta, 'theo');     // shared first, so it is the first one Microsoft lists
    g.share(dad, 'theo');
    return { g, greta, dad };
  }

  it('lists every one, with who made it and how many recipes it holds', async () => {
    const { g, greta, dad } = twoFolders();
    const list = await driveFor(g, 'theo').candidates('/FridgeList');
    expect(list.map((c) => [c.itemId, c.owner, c.recipes])).toEqual([[greta.id, 'Greta', 638], [dad.id, 'Andrew', 670]]);
    expect(list.find((c) => c.current).itemId).toBe(greta.id);
  });

  it('says there are others when describing the one in use, and names its owner even through a shortcut', async () => {
    const { g, dad } = twoFolders();
    expect(await driveFor(g, 'theo').describe('/FridgeList')).toMatchObject({ found: true, owner: 'Greta', others: 1 });
    g.shortcut('theo', 'FridgeList', dad);
    expect(await driveFor(g, 'theo').describe('/FridgeList')).toMatchObject({ found: true, owner: 'Andrew', via: 'shortcut' });
  });

  it('uses the one chosen, for the logs and the recipe file alike', async () => {
    const { g, dad } = twoFolders();
    const drive = createDrive({ getToken: async () => 'theo', fetchImpl: g.fetch,
      pins: { '/FridgeList': { driveId: 'drive-dad', itemId: dad.id } } });
    expect(await drive.folder('/FridgeList')).toMatchObject({ itemId: dad.id, shared: true, via: 'chosen' });
    const got = await createOneDriveFiles({ drive }).read('/FridgeList/recipes-data.json');
    expect(JSON.parse(got.content).recipes).toHaveLength(670);
    await createOneDriveStorage({ drive, root: '/FridgeList' }).write('state/log/theo.jsonl', 'x');
    expect(g.read('dad', 'FridgeList/state/log/theo.jsonl')).toBe('x');
  });

  it('falls back to looking it up if the chosen folder is no longer shared', async () => {
    const { g } = twoFolders();
    const drive = createDrive({ getToken: async () => 'theo', fetchImpl: g.fetch,
      pins: { '/FridgeList': { driveId: 'drive-dad', itemId: 'gone' } } });
    expect(await drive.folder('/FridgeList')).toMatchObject({ via: 'shared-with-me' });
  });
});

describe('changes made before a reload', () => {
  // The second real trial: a menu picked on Dad's phone never reached Mum's.
  // The upload queue lived in memory, so anything not uploaded before the
  // app closed stayed on that phone for ever.
  it('are uploaded when the app starts again, and reach the other phone', async () => {
    const { g } = household();
    const dadStorage = createOneDriveStorage({ drive: driveFor(g, 'dad'), root: '/FridgeList' });
    const device = createDevice('dad-phone');
    const store = createStore();
    const first = createSync({ storage: dadStorage, store, deviceId: 'dad-phone' });
    first.record(device.observe(store.events).emit('menu.selection', { recipeId: 'risotto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft'));
    // The app closes before the upload happens.

    const reopened = createSync({ storage: dadStorage, store: createStore(store.events), deviceId: 'dad-phone' });
    expect(reopened.status().unsent).toBe(1);
    await reopened.tick();
    expect(reopened.status().unsent).toBe(0);

    const mumStore = createStore();
    const mum = createSync({ storage: createOneDriveStorage({ drive: driveFor(g, 'theo'), root: '/FridgeList' }), store: mumStore, deviceId: 'mum-phone' });
    await mum.tick();
    expect(mumStore.events.some((e) => e.type === 'menu.selection' && e.payload.recipeId === 'risotto')).toBe(true);
  });

  it('a failed upload is reported, not hidden behind "synced"', async () => {
    const { staleness } = await import('../src/data/presence.js');
    const { g } = household();
    const broken = createDrive({ getToken: async () => 'dad', fetchImpl: (url, init) =>
      (init?.method === 'PUT' ? Promise.resolve(new Response('{"error":{"code":"quotaLimitReached"}}', { status: 507 })) : g.fetch(url, init)) });
    const device = createDevice('dad-phone');
    const store = createStore();
    const sync = createSync({ storage: createOneDriveStorage({ drive: broken, root: '/FridgeList' }), store, deviceId: 'dad-phone' });
    sync.record(device.observe(store.events).emit('menu.selection', { recipeId: 'risotto', present: true, servings: 4, plannedFor: 'shop-0001' }, 'draft'));
    await sync.tick();
    const s = staleness(sync.status(), []);
    expect(s.selfText).toBe('1 change not saved to OneDrive');
    expect(s.warnText).toMatch(/Not saved to OneDrive yet.*507/);
  });
});

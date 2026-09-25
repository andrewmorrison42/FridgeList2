// The service worker's offline shell. Review #7.
//
// sw.js lists by hand every file the app needs to open with no signal. It has
// already drifted once — connect.js and auth.js shipped uncached until caught
// by eye — and a missing module means the app fails to load in exactly the dead
// spot the service worker exists for. So the list is checked, not trusted.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const shell = [...readFileSync('sw.js', 'utf8').matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);

function filesUnder(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('service worker shell (review #7)', () => {
  it('caches every module and stylesheet the app loads', () => {
    const needed = [
      'index.html', 'manifest.webmanifest', 'icon.svg',
      ...filesUnder('src').filter((f) => f.endsWith('.js') || f.endsWith('.css')),
    ];
    expect(needed.filter((f) => !shell.includes(f))).toEqual([]);
  });

  it('lists nothing that does not exist', () => {
    // A stale entry fails the whole install: cache.addAll is all-or-nothing.
    expect(shell.filter((f) => !existsSync(f))).toEqual([]);
  });
});

describe('sharing an origin with the original FridgeList', () => {
  it('activating the service worker deletes only this app\'s old caches', async () => {
    const handlers = {};
    const caches = new Map([['fridgelist-v1', 1], ['fridgelist2-v1', 1], ['other-app', 1]]);
    const self = {
      location: { origin: 'https://x.github.io' },
      addEventListener: (type, fn) => { handlers[type] = fn; },
      clients: { claim: async () => {} },
    };
    const cacheApi = { keys: async () => [...caches.keys()], delete: async (k) => caches.delete(k) };
    new Function('self', 'caches', readFileSync('sw.js', 'utf8'))(self, cacheApi);
    let done;
    handlers.activate({ waitUntil: (p) => { done = p; } });
    await done;
    expect([...caches.keys()].sort()).toEqual(['fridgelist-v1', 'other-app']);
  });

  it('every name stored on the device is this app\'s own', () => {
    for (const f of ['src/data/persist.js', 'src/data/auth.js']) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/['`]fridgelist[.'-]/);
    }
  });
});

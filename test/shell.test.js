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

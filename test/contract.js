// The storage contract every backend must satisfy — as a function each
// backend's test calls with a way to make a fresh store. See
// storage-contract.test.js (the fakes) and onedrive.test.js (OneDrive, through
// a fake Graph).

import { describe, it, expect } from 'vitest';
import { NOT_MODIFIED as APP_NOT_MODIFIED } from '../src/data/storage.js';

export function describeStorageContract(name, makeStorage, { NOT_MODIFIED = APP_NOT_MODIFIED } = {}) {
  describe(`storage contract: ${name}`, () => {
    it('reads back what was written', async () => {
      const s = makeStorage();
      const { etag } = await s.write('a/b.jsonl', 'hello');
      const got = await s.read('a/b.jsonl');
      expect(got.content).toBe('hello');
      expect(got.etag).toBe(etag);
    });

    it('reports NOT_MODIFIED for an unchanged file', async () => {
      const s = makeStorage();
      const { etag } = await s.write('x', 'one');
      expect(await s.read('x', etag)).toBe(NOT_MODIFIED);
      await s.write('x', 'two');
      expect(await s.read('x', etag)).not.toBe(NOT_MODIFIED);
    });

    it('returns null for a file that does not exist', async () => {
      expect(await makeStorage().read('nope')).toBe(null);
    });

    it('changes the etag on every write', async () => {
      const s = makeStorage();
      const a = await s.write('x', 'one');
      const b = await s.write('x', 'one');   // same content, still a new version
      expect(a.etag).not.toBe(b.etag);
    });

    it('writing one path never affects another', async () => {
      const s = makeStorage();
      await s.write('log/d0.jsonl', 'device zero');
      await s.write('log/d1.jsonl', 'device one');
      await s.write('log/d0.jsonl', 'device zero, again');
      expect((await s.read('log/d1.jsonl')).content).toBe('device one');
    });

    it('lists by prefix', async () => {
      const s = makeStorage();
      await s.write('shops/s1/log/d0.jsonl', '[]');
      await s.write('shops/s1/log/d1.jsonl', '[]');
      await s.write('state/log/d0.jsonl', '[]');
      expect((await s.list('shops/s1/')).map((f) => f.path).sort())
        .toEqual(['shops/s1/log/d0.jsonl', 'shops/s1/log/d1.jsonl']);
    });

    it('delta never misses a change', async () => {
      const s = makeStorage();
      let { cursor } = await s.delta(0);
      await s.write('a', '1');
      await s.write('b', '2');
      const first = await s.delta(cursor);
      expect(first.changes.sort()).toEqual(['a', 'b']);
      await s.write('c', '3');
      const second = await s.delta(first.cursor);
      expect(second.changes).toEqual(['c']);
    });

    it('delta names nested files by their full path', async () => {
      // Real OneDrive reports names and parent ids, never paths; a backend
      // that returns bare names here means no phone hears another's changes.
      const s = makeStorage();
      let { cursor } = await s.delta(0);
      await s.write('state/log/d1.jsonl', 'x');
      await s.write('shops/s1/log/d1.jsonl', 'y');
      ({ cursor } = await s.delta(cursor));
      await s.write('shops/s1/log/d2.jsonl', 'z');
      expect((await s.delta(cursor)).changes).toEqual(['shops/s1/log/d2.jsonl']);
    });

    it('removes files', async () => {
      const s = makeStorage();
      await s.write('gone', 'x');
      await s.remove('gone');
      expect(await s.read('gone')).toBe(null);
    });
  });
}


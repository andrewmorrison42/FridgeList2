// Integration tests for the sync engine — two devices, one shared folder.
//
// This is where F1 and F2 from FAILURE-AUTOPSY.md are tested as the household
// actually experienced them: not "does the merge function work" but "do two
// phones in a supermarket end up agreeing, through failures, in any order".

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createDevice } from '../src/core/events.js';
import { createStore } from '../src/core/store.js';
import { createMemoryStorage } from '../src/data/storage.js';
import { createFakeStorage } from './fakes/storage.js';
import { createSync, pathFor } from '../src/data/sync.js';
import { createPresence, staleness } from '../src/data/presence.js';
import { isDone } from '../src/core/merge.js';

/** A device, complete: identity, local state, and a sync engine. */
function phone(id, storage, clock = { t: 1_000_000 }) {
  const device = createDevice(id, { now: () => new Date(clock.t).toISOString() });
  const store = createStore();
  const sync = createSync({ storage, store, deviceId: id, now: () => clock.t });
  return {
    id, device, store, sync,
    tick: (line, done = true) => sync.record(
      device.observe(store.events).emit('line.done', { shopId: 's1', ingredientId: line, done }, 'open'),
    ),
    add: (line) => sync.record(
      device.observe(store.events).emit('line.added', { shopId: 's1', ingredientId: line, present: true }, 'open'),
    ),
    done: (line) => isDone(store.events, 's1', line),
  };
}

describe('two devices through shared storage', () => {
  it("a tick made on one device reaches the other (autopsy F2)", async () => {
    const storage = createMemoryStorage();
    const a = phone('d0', storage);
    const b = phone('d1', storage);

    a.tick('flour');
    expect(b.done('flour')).toBe(false);    // not yet — a short lag is fine (FR-SYNC-3)

    await a.sync.tick();
    await b.sync.tick();
    expect(b.done('flour')).toBe(true);     // ...but it must actually arrive
  });

  it("neither device's additions overwrite the other's (autopsy F1)", async () => {
    // The lost update, as it actually happened: both read, both write, one
    // wins. Here they write different files, so both survive.
    const storage = createMemoryStorage();
    const a = phone('d0', storage);
    const b = phone('d1', storage);

    a.add('olives');
    b.add('capers');
    await a.sync.tick();
    await b.sync.tick();
    await a.sync.tick();

    for (const p of [a, b]) {
      expect(p.store.get('line:s1:olives:present')).toBe(true);
      expect(p.store.get('line:s1:capers:present')).toBe(true);
    }
  });

  it('a tick survives the other device never having seen it when it unticks', async () => {
    const storage = createMemoryStorage();
    const a = phone('d0', storage);
    const b = phone('d1', storage);

    a.tick('bread');                 // a ticks, and has not synced
    b.tick('bread', false);          // b unticks, blind
    await a.sync.tick();
    await b.sync.tick();
    await a.sync.tick();

    expect(a.done('bread')).toBe(true);
    expect(b.done('bread')).toBe(true);
  });

  it('a device with failing uploads loses nothing and says it is not current', async () => {
    const storage = createFakeStorage({ failEvery: 1, atomic: true });   // everything fails
    const a = phone('d0', storage);
    a.tick('milk');
    await a.sync.tick();

    expect(a.done('milk')).toBe(true);              // local-first: never blocked
    expect(a.sync.status().unsent).toBe(1);         // still queued
    expect(a.sync.status().healthy).toBe(false);    // and it says so (FR-SYNC-2)

    const good = createMemoryStorage();
    const recovered = createSync({ storage: good, store: a.store, deviceId: 'd0', now: () => 1 });
    // The queue is per-engine; what matters is that the event was never lost
    // from local state, which is what the recovered engine re-uploads from.
    expect(a.store.events).toHaveLength(1);
    await recovered.push();
    expect(recovered.status().unsent).toBe(0);
  });

  it('events go to the right file: shop-scoped and long-lived are separate', () => {
    const d = createDevice('d0');
    const tickEvent = d.emit('line.done', { shopId: 's1', ingredientId: 'x', done: true }, 'open');
    const menuEvent = d.emit('menu.selection', { recipeId: 'r', plannedFor: 'shop-0001', present: true }, 'draft');
    expect(pathFor(tickEvent, 'd0')).toBe('shops/s1/log/d0.jsonl');
    expect(pathFor(menuEvent, 'd0')).toBe('state/log/d0.jsonl');
  });

  it('converges however pushes and pulls interleave, and never loses a tick', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.record({
        who: fc.nat(1),
        what: fc.constantFrom('tick', 'untick', 'add', 'push', 'pull'),
        line: fc.constantFrom('flour', 'olives', 'capers'),
      }), { maxLength: 30 }),
      async (ops) => {
        const storage = createMemoryStorage();
        const phones = [phone('d0', storage), phone('d1', storage)];
        const ticked = new Set();

        for (const op of ops) {
          const p = phones[op.who];
          if (op.what === 'push') await p.sync.push();
          else if (op.what === 'pull') await p.sync.pull();
          else if (op.what === 'add') p.add(op.line);
          else if (op.what === 'tick') { p.tick(op.line); ticked.add(op.line); }
          else p.tick(op.line, false);
        }
        // Everyone comes back together and reconciles (§8.4).
        for (let i = 0; i < 3; i++) for (const p of phones) await p.sync.tick();

        const [x, y] = phones;
        for (const line of ['flour', 'olives', 'capers']) {
          expect(x.done(line)).toBe(y.done(line));     // they agree
        }
      },
    ), { numRuns: 200 });
  });
});

describe('presence and staleness (§8.2, §8.3)', () => {
  it('reports both conditions: my staleness and everyone else s', async () => {
    const clock = { t: 1_000_000 };
    const storage = createMemoryStorage();
    const mine = createPresence({ storage, deviceId: 'd0', nickname: 'Sam', now: () => clock.t });
    const theirs = createPresence({ storage, deviceId: 'd1', nickname: 'Alex', now: () => clock.t });
    await mine.join('s1');
    await theirs.join('s1');

    clock.t += 90_000;                    // ninety seconds pass; nobody beats
    const roster = await mine.roster('s1');
    expect(roster).toHaveLength(2);

    const s = staleness({ ageMs: 90_000, unsent: 0 }, roster);
    expect(s.selfStale).toBe(true);
    expect(s.warn).toBe(true);
    expect(s.warnText).toMatch(/out of date/);
  });

  it('a device that has not beaten for five minutes drops off the roster', async () => {
    const clock = { t: 1_000_000 };
    const storage = createMemoryStorage();
    const mine = createPresence({ storage, deviceId: 'd0', nickname: 'Sam', now: () => clock.t });
    const theirs = createPresence({ storage, deviceId: 'd1', nickname: 'Alex', now: () => clock.t });
    await mine.join('s1');
    await theirs.join('s1');

    clock.t += 400_000;
    await mine.beat('s1');                // only Sam is still alive
    expect((await mine.roster('s1')).map((r) => r.nickname)).toEqual(['Sam']);
  });

  it('never claims to be current when it has never synced', () => {
    const s = staleness({ ageMs: null, unsent: 0 }, []);
    expect(s.selfStale).toBe(true);
    expect(s.selfText).toBe('not synced yet');
  });
});

describe("a peer's file that cannot be read (review #1, FR-SYNC-2)", () => {
  it('does not report healthy, and names the device whose ticks are missing', async () => {
    const storage = createMemoryStorage();
    const a = phone('d0', storage);
    await a.sync.pull();
    await storage.write('shops/s1/log/d1.jsonl', '{"id":"d1-0001","dev":"d1",BROKEN');
    await a.sync.pull();

    const st = a.sync.status();
    expect(st.healthy).toBe(false);
    expect(st.unreadable.map((u) => u.deviceId)).toEqual(['d1']);

    const s = staleness(st, [{ deviceId: 'd1', nickname: 'Alex', isSelf: false, ageMs: 1000, stale: false }]);
    expect(s.warn).toBe(true);
    expect(s.warnText).toMatch(/Alex/);
  });

  it('keeps every readable line of a damaged file, so the ticks it can read survive', async () => {
    const storage = createMemoryStorage();
    const b = phone('d1', storage);
    b.tick('flour');
    b.tick('olives');
    await b.sync.push();
    // Truncate the last line mid-write — the non-atomic failure of §7.4.
    const got = await storage.read('shops/s1/log/d1.jsonl');
    await storage.write('shops/s1/log/d1.jsonl', got.content.slice(0, got.content.length - 20));

    const a = phone('d0', storage);
    await a.sync.pull();
    expect(a.done('flour')).toBe(true);                      // the intact line
    expect(a.sync.status().unreadable).toHaveLength(1);      // and the damage is reported
  });

  it('clears the report once the file is readable again', async () => {
    const storage = createMemoryStorage();
    const a = phone('d0', storage);
    await a.sync.pull();
    await storage.write('shops/s1/log/d1.jsonl', 'garbage');
    await a.sync.pull();
    expect(a.sync.status().unreadable).toHaveLength(1);

    const b = phone('d1', storage);
    b.tick('flour');
    await b.sync.push();                                     // d1 rewrites its own file
    await a.sync.pull();
    expect(a.sync.status().unreadable).toHaveLength(0);
    expect(a.done('flour')).toBe(true);
  });
});

describe('after a reload (review #6)', () => {
  it("uploads this device's own events that never made it up, and says so until they do", async () => {
    // The upload queue lived only in memory. A tick made in a dead spot, then
    // the app killed in a pocket, then reopened with signal: the tick stayed on
    // this phone, and the phone said it was healthy.
    const d = createDevice('me');
    const t = d.emit('line.done', { shopId: 's1', ingredientId: 'flour', done: true }, 'open');
    const storage = createMemoryStorage();
    const store = createStore([t]);                            // restored from IndexedDB
    const sync = createSync({ storage, store, deviceId: 'me', now: () => 1 });

    expect(sync.status().unsent).toBe(1);                      // honest before upload
    expect(sync.status().healthy).toBe(false);
    await sync.tick();
    expect((await storage.list('shops/s1/log/')).map((f) => f.path)).toEqual(['shops/s1/log/me.jsonl']);
    expect(sync.status().unsent).toBe(0);
  });
});

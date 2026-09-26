// The storage contract, as an executable specification.
//
// ARCHITECTURE.md §15.2 says the backend is swappable behind five functions.
// This is what "swappable" has to mean in practice: any implementation must
// pass these, and the OneDrive adapter will call describeStorageContract when
// it exists. Until then this validates the fake — which is honest about what
// it proves, but the contract itself is the deliverable.
//
// The atomicity case is here because the failure autopsy found the design was
// relying on it silently (F1, residual risk).

import { describe, it, expect } from 'vitest';
import { createFakeStorage, NOT_MODIFIED } from './fakes/storage.js';
import { describeStorageContract } from './contract.js';
import { createDevice } from '../src/core/events.js';
import { createStore } from '../src/core/store.js';

describeStorageContract('in-memory fake', () => createFakeStorage(), { NOT_MODIFIED });

// ---------------------------------------------------------------------------
// Atomicity — §7.4
// ---------------------------------------------------------------------------

/** What a device does on every upload: rewrite its own log with its events. */
async function uploadLog(storage, path, events) {
  try {
    await storage.write(path, JSON.stringify(events));
    return true;
  } catch {
    return false;               // queued for retry (§7.4); nothing is lost
  }
}

async function readLog(storage, path) {
  const got = await storage.read(path);
  if (!got) return [];
  try { return JSON.parse(got.content); } catch { return null; }   // null = corrupt
}

describe('atomicity of writes (§7.4, autopsy F1)', () => {
  it('a failed write leaves the previous version intact', async () => {
    const s = createFakeStorage({ failEvery: 2, atomic: true });
    const d = createDevice('d0');
    const first = [d.emit('line.done', { shopId: 's1', ingredientId: 'flour', done: true }, 'open')];
    expect(await uploadLog(s, 'log/d0.jsonl', first)).toBe(true);

    const second = [...first, d.emit('line.done', { shopId: 's1', ingredientId: 'olives', done: true }, 'open')];
    expect(await uploadLog(s, 'log/d0.jsonl', second)).toBe(false);   // this one fails

    // The earlier tick is still there, and still readable.
    expect(await readLog(s, 'log/d0.jsonl')).toEqual(first);
  });

  it('a device never loses its own events when writes are atomic', async () => {
    const s = createFakeStorage({ failEvery: 3, atomic: true });
    const d = createDevice('d0');
    const events = [];
    for (const line of ['flour', 'olives', 'capers', 'bread', 'milk']) {
      events.push(d.emit('line.done', { shopId: 's1', ingredientId: line, done: true }, 'open'));
      // Retry until it lands, exactly as the upload queue does.
      for (let attempt = 0; attempt < 5; attempt++) {
        if (await uploadLog(s, 'log/d0.jsonl', events)) break;
      }
    }
    const stored = await readLog(s, 'log/d0.jsonl');
    expect(stored).not.toBe(null);
    expect(stored.map((e) => e.payload.ingredientId))
      .toEqual(['flour', 'olives', 'capers', 'bread', 'milk']);

    // And the merged answer on any device reading it is the same five ticks.
    const store = createStore(stored);
    for (const line of ['flour', 'olives', 'capers', 'bread', 'milk']) {
      expect(store.get(`line:s1:${line}:done`)).toBe(true);
    }
  });

  it('DEMONSTRATION: without atomicity a device destroys its own log', async () => {
    // This is why the contract above is not decorative. A backend that can
    // land a partial write lets a device truncate its own file — losing ticks
    // no other device has a copy of, since no other device writes this file.
    //
    // Note the condition, which the first draft of this test missed: a retry
    // immediately after the bad write *heals* the corruption, so the loss only
    // becomes permanent when the device does not get to retry. That is not an
    // exotic case — it is a phone going back in a pocket, the app suspending,
    // or a flat battery by the freezers, which is precisely where this system
    // is used. A durability property that holds only while the app stays
    // awake is not durability.
    const s = createFakeStorage({ failEvery: 3, atomic: false });
    const d = createDevice('d0');
    const events = [];
    let died = false;
    for (const line of ['flour', 'olives', 'capers', 'bread', 'milk']) {
      events.push(d.emit('line.done', { shopId: 's1', ingredientId: line, done: true }, 'open'));
      if (!(await uploadLog(s, 'log/d0.jsonl', events))) { died = true; break; }  // phone dies
    }
    expect(died).toBe(true);

    const stored = await readLog(s, 'log/d0.jsonl');
    const lost = stored === null || stored.length < events.length;
    expect(lost).toBe(true);   // ticks gone, silently — the failure we forbid
  });

  it('with atomicity, the same interrupted device loses nothing it had confirmed', async () => {
    const s = createFakeStorage({ failEvery: 3, atomic: true });
    const d = createDevice('d0');
    const events = [];
    let confirmed = [];
    for (const line of ['flour', 'olives', 'capers', 'bread', 'milk']) {
      events.push(d.emit('line.done', { shopId: 's1', ingredientId: line, done: true }, 'open'));
      if (await uploadLog(s, 'log/d0.jsonl', events)) confirmed = [...events];
      else break;              // same interruption, same point
    }
    // Everything previously confirmed is intact and readable. The unconfirmed
    // tick is still in the device's own queue (§7.4), not lost — it is simply
    // not in the cloud yet, which is staleness, not loss.
    expect(await readLog(s, 'log/d0.jsonl')).toEqual(confirmed);
    expect(confirmed.length).toBeGreaterThan(0);
  });
});

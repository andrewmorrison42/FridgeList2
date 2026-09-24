// Register keys. Review #3.
//
// The format used to live in six files, and a drift between building a key and
// reading it back makes a lookup return undefined — a tick reading as "not
// done", with no error. These tests make that drift fail loudly instead.

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { K, parseKey, keyOf } from '../src/core/keys.js';
import { createDevice } from '../src/core/events.js';
import { merge, isDone } from '../src/core/merge.js';

const id = fc.stringMatching(/^[a-z0-9][a-z0-9_.-]{0,15}$/);

describe('keys.js (review #3)', () => {
  it('every builder round-trips through parseKey', () => {
    const ARGS = {
      lineDone: ['shopId', 'ingredientId'], linePresent: ['shopId', 'ingredientId'],
      lineSuppressed: ['shopId', 'ingredientId'], menuPresent: ['recipeId', 'plannedFor'],
      menuCooked: ['recipeId', 'plannedFor'], waitlistPresent: ['itemId'],
      carryoverDismissed: ['shopId', 'ingredientId'], shopLocked: ['shopId'], shopClosed: ['shopId'],
      recipe: ['recipeId'], ingredient: ['ingredientId'], historyImported: [],
    };
    expect(Object.keys(ARGS).sort()).toEqual(Object.keys(K).sort());   // no builder untested
    fc.assert(fc.property(fc.constantFrom(...Object.keys(ARGS)), id, id, (kind, a, b) => {
      const names = ARGS[kind];
      const values = [a, b].slice(0, names.length);
      const parsed = parseKey(K[kind](...values));
      expect(parsed).toEqual(Object.fromEntries([['kind', kind], ...names.map((n, i) => [n, values[i]])]));
    }), { numRuns: 1000 });
  });

  it("an event's key reads back to the fields it was made from", () => {
    const d = createDevice('d');
    const cases = [
      [d.emit('line.done', { shopId: 's1', ingredientId: 'flour', done: true }, 'open'), { kind: 'lineDone', shopId: 's1', ingredientId: 'flour' }],
      [d.emit('menu.selection', { recipeId: 'cake', plannedFor: 's2', present: true }, 'draft'), { kind: 'menuPresent', recipeId: 'cake', plannedFor: 's2' }],
      [d.emit('waitlist.item', { itemId: 'w1', ingredientId: 'mayo', present: true }, 'open'), { kind: 'waitlistPresent', itemId: 'w1' }],
    ];
    for (const [event, fields] of cases) expect(parseKey(keyOf(event))).toEqual(fields);
  });

  it('refuses, at creation, an id that would make a key ambiguous', () => {
    const d = createDevice('d');
    expect(() => d.emit('line.done', { shopId: 's1', ingredientId: 'a:b', done: true }, 'open')).toThrow(/cannot be used in a key/);
    expect(d.seq).toBe(0);                               // nothing was created
  });

  it("an event type this version doesn't know is skipped, not fatal", () => {
    // Phones update at different times. A newer phone's new event type must
    // not take down an older phone's list.
    const d = createDevice('d');
    const tick = d.emit('line.done', { shopId: 's1', ingredientId: 'flour', done: true }, 'open');
    const fromTheFuture = { id: 'n-0001', dev: 'n', seq: 1, deps: { n: 1 }, ts: tick.ts,
      type: 'line.photographed', payload: { shopId: 's1', ingredientId: 'flour' } };
    expect(() => merge([tick, fromTheFuture])).not.toThrow();
    expect(isDone([tick, fromTheFuture], 's1', 'flour')).toBe(true);
  });

  it('no module outside keys.js builds or parses a register key by hand', () => {
    // The rule this review found broken in five files. Enforced here so it
    // cannot quietly come back.
    const handMade = /`(line|menu|waitlist|carryover|shop|recipe|ingredient):\$\{|\/\^(line|menu|waitlist|carryover|shop|recipe|ingredient):/;
    const offenders = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.js') && !path.endsWith(join('core', 'keys.js'))) {
          readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
            if (handMade.test(line)) offenders.push(`${path}:${i + 1}`);
          });
        }
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });
});

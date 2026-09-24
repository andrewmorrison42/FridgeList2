// The documents and the tests must agree.
//
// ARCHITECTURE §14 listed P8 ("Wait List closure") from v0.3 and P4
// ("regeneration safety") from v0.1, and neither was ever written. Meanwhile
// completing any shop with a ticked Wait List item threw. A property a document
// claims and no test checks is the documentation version of a test that cannot
// fail — so every property the architecture lists must be named by a test.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.test.js') ? [p] : [];
});

describe('documents and tests agree', () => {
  it('every property ARCHITECTURE.md lists is named by at least one test', () => {
    const claimed = [...readFileSync('ARCHITECTURE.md', 'utf8').matchAll(/\*\*(P\d+)\*\*/g)].map((m) => m[1]);
    const tests = files('test').filter((f) => !f.endsWith('docs.test.js')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const untested = [...new Set(claimed)].filter((p) => !new RegExp(`it\\(['"\`]${p} `).test(tests)
      && !new RegExp(`describe\\(['"\`]${p} `).test(tests));
    expect(claimed.length).toBeGreaterThan(5);
    expect(untested).toEqual([]);
  });
});

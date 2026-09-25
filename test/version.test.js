import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION, RELEASED } from '../src/version.js';

describe('version', () => {
  it('is the same in package.json and src/version.js', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.version).toBe(VERSION);
  });

  it('has a release date Setup can show', () => {
    expect(RELEASED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

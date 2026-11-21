// Sign-in token refresh. Run without a browser: localStorage and fetch are stubbed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createAuth } from '../src/data/auth.js';

describe('token refresh', () => {
  let calls;
  beforeEach(() => {
    const mem = new Map([['fridgelist.auth', JSON.stringify({ refresh_token: 'r1', access_token: 'old', expiresAt: 0 })]]);
    vi.stubGlobal('localStorage', {
      getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k),
    });
    calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return { ok: true, json: async () => ({ access_token: `new${calls}`, refresh_token: 'r2', expires_in: 3600 }) };
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks Microsoft once when two callers need a token at the same time', async () => {
    const auth = createAuth({ clientId: 'c', redirectUri: 'https://example.test/' });
    const [a, b] = await Promise.all([auth.getToken(), auth.getToken()]);
    expect(calls).toBe(1);
    expect(a).toBe('new1');
    expect(b).toBe('new1');
  });
});

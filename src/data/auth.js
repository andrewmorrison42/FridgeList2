// Microsoft sign-in for a static page. ARCHITECTURE.md §3.3.
//
// Authorisation code flow with PKCE — the only flow appropriate for a public
// client that cannot keep a secret. The client id is public by design; PKCE is
// what makes that safe, since an intercepted code is useless without the
// verifier that never leaves this device.
//
// Written by hand rather than pulled from a CDN: it is about seventy lines of
// a well-specified flow, and it keeps the app's "no runtime dependencies" rule
// (D7) genuinely true rather than nearly true.

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
const SCOPES = 'Files.ReadWrite offline_access User.Read';
const KEY = 'fridgelist2.auth';   // one origin, two apps: see persist.js

const load = () => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? localStorage.getItem(KEY) ?? 'null'); } catch { return null; } };
const save = (t) => { try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* private window */ } };
const forget = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } };

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(digest);
}

const randomVerifier = () => b64url(crypto.getRandomValues(new Uint8Array(48)));

export function createAuth({ clientId, redirectUri = location.origin + location.pathname }) {
  let tokens = load();

  async function exchange(body) {
    const res = await fetch(`${AUTHORITY}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, ...body }),
    });
    if (!res.ok) throw new Error(`sign-in failed (${res.status}): ${await res.text()}`);
    const t = await res.json();
    tokens = { ...t, expiresAt: Date.now() + (t.expires_in - 120) * 1000 };
    save(tokens);
    return tokens;
  }

  return {
    get connected() { return !!tokens?.refresh_token; },

    /** Send the browser to Microsoft. Returns to `redirectUri` with a code. */
    async signIn() {
      const verifier = randomVerifier();
      sessionStorage.setItem('fridgelist2.pkce', verifier);
      const params = new URLSearchParams({
        client_id: clientId, response_type: 'code', redirect_uri: redirectUri,
        scope: SCOPES, code_challenge: await challengeFor(verifier), code_challenge_method: 'S256',
      });
      location.assign(`${AUTHORITY}/authorize?${params}`);
    },

    /**
     * Complete a sign-in if we have just come back from Microsoft.
     * Returns true if this call consumed a code.
     */
    async completeSignIn() {
      const url = new URL(location.href);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
      if (error) { history.replaceState({}, '', redirectUri); throw new Error(error); }
      if (!code) return false;
      const verifier = sessionStorage.getItem('fridgelist2.pkce');
      history.replaceState({}, '', redirectUri);        // keep the code out of history
      if (!verifier) throw new Error('sign-in could not be completed on this device');
      sessionStorage.removeItem('fridgelist2.pkce');
      await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
      return true;
    },

    /**
     * A current access token, refreshing silently when it has expired.
     * In practice nobody signs in twice.
     */
    async getToken() {
      if (!tokens?.refresh_token) throw new Error('not signed in');
      if (Date.now() < (tokens.expiresAt ?? 0)) return tokens.access_token;
      await exchange({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, scope: SCOPES });
      return tokens.access_token;
    },

    signOut() { tokens = null; forget(); },
  };
}

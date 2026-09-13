// OneDrive, behind the five functions of storage.js. ARCHITECTURE.md §3.3, §15.2.
//
// The household's data goes browser ⇄ OneDrive directly. The app's own host
// (GitHub Pages) never sees any of it.
//
// Auth is one shared Microsoft account per household, signed in on each device.
// A static page cannot keep a secret, so this uses the authorisation code flow
// with PKCE — the only flow appropriate for a public client — and the client id
// is public by design.

import { NOT_MODIFIED } from './storage.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

/**
 * @param {object} opts
 * @param {() => Promise<string>} opts.getToken  supplies a current access token
 * @param {string} [opts.root]  folder path within the drive
 */
export function createOneDriveStorage({ getToken, root = '/FridgeList' }) {
  const itemPath = (path) => `${GRAPH}/me/drive/root:${root}/${path}`;
  let deltaLink = null;

  async function call(url, init = {}) {
    const token = await getToken();
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    if (res.status === 304) return NOT_MODIFIED;
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`OneDrive ${init.method ?? 'GET'} ${res.status}: ${await res.text()}`);
    return res;
  }

  return {
    async list(prefix = '') {
      const res = await call(`${itemPath(prefix)}:/children?$select=name,eTag,size`);
      if (!res || res === NOT_MODIFIED) return [];
      const body = await res.json();
      return (body.value ?? []).map((f) => ({
        path: `${prefix}${f.name}`, etag: f.eTag, size: f.size,
      }));
    },

    async read(path, etag) {
      // A conditional GET costs a 304 and no body when nothing has changed,
      // which is what keeps the 1 MB library off every poll (§7.2).
      const res = await call(`${itemPath(path)}:/content`, {
        headers: etag ? { 'If-None-Match': etag } : {},
      });
      if (res === NOT_MODIFIED || res === null) return res;
      return { content: await res.text(), etag: res.headers.get('ETag') };
    },

    async write(path, content) {
      // A simple upload replaces the item's content as a new version: atomic,
      // which §7.4 depends on. Files here are small; the chunked upload-session
      // API, which is not atomic in the same way, is never needed.
      const res = await call(`${itemPath(path)}:/content`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: content,
      });
      const body = await res.json();
      return { etag: body.eTag };
    },

    async remove(path) {
      await call(itemPath(path), { method: 'DELETE' });
    },

    async delta() {
      // Delta returns only what changed, so a poll costs the same however much
      // is stored (§7.2).
      const url = deltaLink ?? `${itemPath('')}:/delta`;
      const res = await call(url);
      if (!res || res === NOT_MODIFIED) return { changes: [], cursor: deltaLink };
      const body = await res.json();
      deltaLink = body['@odata.deltaLink'] ?? deltaLink;
      const changes = (body.value ?? [])
        .filter((i) => i.file)
        .map((i) => i.name);
      return { changes, cursor: deltaLink };
    },
  };
}

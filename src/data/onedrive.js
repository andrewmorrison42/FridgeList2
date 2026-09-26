// OneDrive, behind the five functions of storage.js and the file access of
// recipes.js. ARCHITECTURE.md §3.3, §15.2.
//
// The household's data goes browser ⇄ OneDrive directly. The app's own host
// (GitHub Pages) never sees any of it.
//
// Each person signs in with their own Microsoft account. One of them owns the
// FridgeList folder and shares it (with editing) with the rest, who each add a
// shortcut to it in their own OneDrive — as with the earlier app. So a path
// like "/FridgeList" is resolved once, through the shortcut if there is one,
// to the folder's drive and id; everything else is addressed relative to that
// folder, wherever it lives. Graph's path addressing does not pass through a
// shortcut, which is why the resolving has to be done here.
//
// A folder is never created without being asked. A phone that cannot find the
// shared folder says so, rather than quietly starting its own list that no one
// else can see.

import { NOT_MODIFIED } from './storage.js';
import { CONFLICT } from './recipes.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const enc = (path) => path.split('/').filter(Boolean).map(encodeURIComponent).join('/');

export class FolderNotFound extends Error {
  constructor(path) {
    super(`No "${path}" folder in this account's OneDrive, and none shared with it`);
    this.path = path;
  }
}

/**
 * One signed-in account's view of OneDrive: requests, and folders resolved
 * through shortcuts. Shared by the storage and the recipe file, so a folder is
 * looked up once.
 */
export function createDrive({ getToken, fetchImpl = (...a) => fetch(...a), pins = {} }) {
  const folders = new Map();      // path → Promise<ref | null>
  // A folder chosen by hand in Setup, by path: { driveId, itemId }. Used in
  // preference to looking one up, for an account that can see more than one
  // folder of that name — its own, and one or more shared with it.
  const pinned = (path) => pins[`/${enc(path)}`] ?? null;
  let myDriveId = null;

  async function call(url, init = {}) {
    const token = await getToken();
    return fetchImpl(url.startsWith('http') ? url : GRAPH + url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
  }
  const fail = async (what, res) => new Error(`OneDrive ${what} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);

  const refOf = (item, via = null) => (item.remoteItem
    ? { driveId: item.remoteItem.parentReference.driveId, itemId: item.remoteItem.id, shared: true,
        owner: item.remoteItem.shared?.owner?.user?.displayName ?? null, via: via ?? 'shortcut' }
    : { driveId: item.parentReference.driveId, itemId: item.id, shared: false, owner: null, via: via ?? 'own' });

  /**
   * A folder by path from the signed-in account's own root: `{ driveId,
   * itemId, shared, owner, via }`, or null if there is none. A shortcut on the
   * way is followed; failing that, a folder of the first segment's name that
   * has been shared with this account.
   */
  async function lookup(path) {
    const pin = pinned(path);
    if (pin) {
      const res = await call(`/drives/${pin.driveId}/items/${pin.itemId}`);
      if (res.ok) {
        const mine = await ownDriveId();
        return { driveId: pin.driveId, itemId: pin.itemId, shared: pin.driveId !== mine, owner: null, via: 'chosen' };
      }
      if (res.status !== 404 && res.status !== 403) throw await fail('read', res);
      // Chosen folder gone, or no longer shared: look it up afresh.
    }
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 0) {
      const res = await call('/me/drive/root');
      if (!res.ok) throw await fail('read', res);
      const root = await res.json();
      return { driveId: root.parentReference?.driveId ?? root.id, itemId: root.id, shared: false, owner: null, via: 'own' };
    }
    let ref = null;
    for (let i = 0; i < segs.length; i++) {
      const url = ref ? `/drives/${ref.driveId}/items/${ref.itemId}:/${encodeURIComponent(segs[i])}` : `/me/drive/root:/${encodeURIComponent(segs[i])}`;
      const res = await call(url);
      if (res.status === 404) {
        if (i === 0) {
          const [shared] = await sharedWithMe(segs[0]);
          if (shared) { ref = shared; continue; }
        }
        return null;
      }
      if (!res.ok) throw await fail('read', res);
      const item = await res.json();
      if (!item.folder && !item.remoteItem?.folder) return null;
      const next = refOf(item);
      ref = ref?.shared ? { ...next, shared: true, owner: ref.owner, via: ref.via } : next;
    }
    return ref;
  }

  /** Folders of this name shared with this account. Best effort only: Microsoft throttles this list and is retiring it. */
  async function sharedWithMe(name) {
    try {
      const res = await call('/me/drive/sharedWithMe');
      if (!res.ok) return [];
      return ((await res.json()).value ?? [])
        .filter((i) => i.name === name && (i.folder || i.remoteItem?.folder) && i.remoteItem)
        .map((i) => refOf(i, 'shared-with-me'));
    } catch { return []; }
  }

  async function ownDriveId() {
    if (!myDriveId) {
      const res = await call('/me/drive?$select=id');
      if (!res.ok) throw await fail('read', res);
      myDriveId = (await res.json()).id;
    }
    return myDriveId;
  }

  /** Who made a folder, and when it last changed — for telling two of the same name apart. */
  async function detailsOf(ref) {
    const res = await call(`/drives/${ref.driveId}/items/${ref.itemId}?$select=name,createdBy,lastModifiedDateTime`);
    if (!res.ok) return { owner: ref.owner, modified: null };
    const j = await res.json();
    return { owner: ref.owner ?? j.createdBy?.user?.displayName ?? null, modified: j.lastModifiedDateTime ?? null };
  }

  const drive = {
    call, fail,
    download: (url) => fetchImpl(url),
    /** Resolve a folder once per session. A failure (not an absence) is retried next time. */
    folder(path) {
      const key = `/${enc(path)}`;
      if (!folders.has(key)) {
        const p = lookup(key).catch((err) => { folders.delete(key); throw err; });
        folders.set(key, p);
      }
      return folders.get(key);
    },
    forget() { folders.clear(); },

    /** Make a top-level folder in this account's own OneDrive. Only ever on request. */
    /**
     * Every folder of this name the account can see — its own (or its
     * shortcut's target), and each one shared with it — with who made it,
     * when it last changed, and how many recipes its recipe file holds. For
     * choosing between them in Setup.
     */
    async candidates(path, { counts = true } = {}) {
      const name = path.split('/').filter(Boolean)[0];
      const found = [];
      const res = await call(`/me/drive/root:/${encodeURIComponent(name)}`);
      if (res.ok) {
        const item = await res.json();
        if (item.folder || item.remoteItem?.folder) found.push(refOf(item));
      } else if (res.status !== 404) throw await fail('read', res);
      found.push(...await sharedWithMe(name));
      const current = await drive.folder(path).catch(() => null);
      const seen = new Set();
      const out = [];
      for (const ref of found) {
        const key = `${ref.driveId}/${ref.itemId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { owner, modified } = await detailsOf(ref);
        let recipes = null;
        if (counts) try {
          const f = await call(`/drives/${ref.driveId}/items/${ref.itemId}:/recipes-data.json`);
          if (f.ok) {
            const text = await (await drive.download((await f.json())['@microsoft.graph.downloadUrl'])).text();
            recipes = JSON.parse(text).recipes?.length ?? null;
          } else if (f.status === 404) recipes = 0;
        } catch { /* unknown */ }
        out.push({ driveId: ref.driveId, itemId: ref.itemId, shared: ref.shared, via: ref.via, owner, modified, recipes,
          current: !!current && current.driveId === ref.driveId && current.itemId === ref.itemId });
      }
      return out;
    },

    async createFolder(path) {
      const segs = path.split('/').filter(Boolean);
      if (segs.length !== 1) throw new Error('Only a folder directly in your OneDrive can be created here — make it in OneDrive instead.');
      const res = await call('/me/drive/root/children', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: segs[0], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      });
      if (!res.ok && res.status !== 409) throw await fail('create', res);
      folders.delete(`/${enc(path)}`);
      return drive.folder(path);
    },

    /** The folder's name and, if it is someone else's, whose — for Setup. */
    async describe(path) {
      const ref = await drive.folder(path);
      if (!ref) return { found: false, path };
      const { owner } = await detailsOf(ref);
      let alsoShared = null;
      if (!ref.shared) {
        // Using a folder of your own when the household's has been shared with
        // you is the classic wrong turn; say so.
        const [s] = await sharedWithMe(path.split('/').filter(Boolean)[0]);
        if (s) alsoShared = (await detailsOf(s)).owner ?? 'someone';
      }
      // Another folder of the same name in view — the likeliest reason for a
      // phone seeing a different recipe book from the rest.
      const others = (await drive.candidates(path, { counts: false }).catch(() => [])).filter((c) => !c.current).length;
      return { found: true, path, shared: ref.shared, owner, via: ref.via, alsoShared, others };
    },
  };
  return drive;
}

/** An item under a resolved folder, by path relative to it. */
const under = (ref, rel) => {
  const p = enc(rel);
  return p ? `/drives/${ref.driveId}/items/${ref.itemId}:/${p}` : `/drives/${ref.driveId}/items/${ref.itemId}`;
};
/** The same, followed by a sub-resource such as /content or /children. */
const underWith = (ref, rel, what) => (enc(rel) ? `${under(ref, rel)}:${what}` : `${under(ref, rel)}${what}`);

/**
 * The per-device logs, in the household folder: the five functions of
 * storage.js. Paths are relative to the folder, e.g. "state/log/d1.jsonl".
 */
export function createOneDriveStorage({ drive, root = '/FridgeList' }) {
  let deltaLink = null;
  let deltaBroken = false;
  const nodes = new Map();        // item id → { name, parentId, folder }

  async function folder() {
    const ref = await drive.folder(root);
    if (!ref) throw new FolderNotFound(root);
    return ref;
  }

  /** Make the folders a path needs. Uploads do not reliably create them. */
  async function ensureDirs(ref, dir) {
    const segs = dir.split('/').filter(Boolean);
    for (let i = 0; i < segs.length; i++) {
      const here = segs.slice(0, i + 1).join('/');
      const res = await drive.call(under(ref, here));
      if (res.ok) continue;
      if (res.status !== 404) throw await drive.fail('read', res);
      const made = await drive.call(underWith(ref, segs.slice(0, i).join('/'), '/children'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: segs[i], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }),
      });
      if (!made.ok && made.status !== 409) throw await drive.fail('create folder', made);
    }
  }

  /** Where an item sits, relative to the folder, from the ids delta gives. */
  function pathOf(id, rootId) {
    const parts = [];
    for (let cur = nodes.get(id), guard = 0; cur && guard < 50; cur = nodes.get(cur.parentId), guard++) {
      parts.unshift(cur.name);
      if (cur.parentId === rootId) return parts.join('/');
    }
    return null;                  // not (yet) connected to the folder
  }

  /** Every file under a folder, by listing: paths, or { path, etag, size } with `detail`. */
  async function listAll(ref, rel = '', detail = false) {
    const out = [];
    let url = underWith(ref, rel, '/children');
    while (url) {
      const res = await drive.call(url);
      if (res.status === 404) return out;
      if (!res.ok) throw await drive.fail('list', res);
      const body = await res.json();
      for (const item of body.value ?? []) {
        const path = rel ? `${rel}/${item.name}` : item.name;
        if (item.folder) out.push(...await listAll(ref, path, detail));
        else out.push(detail ? { path, etag: item.eTag, size: item.size } : path);
      }
      url = body['@odata.nextLink'] ?? null;
    }
    return out;
  }

  return {
    async list(prefix = '') {
      // Everything under the prefix, subfolders included — the same as a
      // prefix match on paths, which is what the contract means by it.
      const ref = await folder();
      return listAll(ref, prefix.replace(/\/+$/, ''), true);
    },

    async read(path, etag) {
      // The item's metadata first — a 304 costs nothing when it has not
      // changed (§7.2) — then its content from the download link it carries.
      const ref = await folder();
      const res = await drive.call(under(ref, path), { headers: etag ? { 'If-None-Match': etag } : {} });
      if (res.status === 304) return NOT_MODIFIED;
      if (res.status === 404) return null;
      if (!res.ok) throw await drive.fail('read', res);
      const meta = await res.json();
      const dl = await fetchDownload(drive, meta);
      return { content: dl, etag: meta.eTag };
    },

    async write(path, content) {
      // A simple upload replaces the item's content as a new version: atomic,
      // which §7.4 depends on. Files here are small; the chunked upload-session
      // API, which is not atomic in the same way, is never needed.
      const ref = await folder();
      const put = () => drive.call(underWith(ref, path, '/content'), {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: content,
      });
      let res = await put();
      if (res.status === 404) {                         // a folder on the way is missing
        await ensureDirs(ref, path.split('/').slice(0, -1).join('/'));
        res = await put();
      }
      if (!res.ok) throw await drive.fail('save', res);
      return { etag: (await res.json()).eTag };
    },

    async remove(path) {
      const ref = await folder();
      const res = await drive.call(under(ref, path), { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw await drive.fail('delete', res);
    },

    /**
     * What changed since the last call, as paths relative to the folder.
     *
     * Delta names items and their parent ids, never their paths, and comes in
     * pages; the paths are rebuilt from the folders it reports. Where delta is
     * refused (it can be, on a folder in someone else's drive), every file is
     * listed instead and the sync engine reads each conditionally — slower,
     * never wrong.
     */
    async delta() {
      const ref = await folder();
      if (!deltaBroken) {
        try {
          const changed = new Set();
          let url = deltaLink ?? `${under(ref, '')}/delta`;
          const pageItems = [];
          while (url) {
            const res = await drive.call(url);
            if (!res.ok) throw Object.assign(await drive.fail('changes', res), { status: res.status });
            const body = await res.json();
            pageItems.push(...(body.value ?? []));
            if (body['@odata.deltaLink']) { deltaLink = body['@odata.deltaLink']; url = null; }
            else url = body['@odata.nextLink'] ?? null;
          }
          for (const item of pageItems) {
            if (item.deleted) { nodes.delete(item.id); continue; }
            nodes.set(item.id, { name: item.name, parentId: item.parentReference?.id ?? null, folder: !!item.folder });
          }
          for (const item of pageItems) {
            if (item.deleted || item.folder || item.id === ref.itemId) continue;
            const path = pathOf(item.id, ref.itemId);
            if (path) changed.add(path);
          }
          return { changes: [...changed], cursor: deltaLink };
        } catch (err) {
          // A refusal (4xx) means delta is not available here: list instead.
          // A network failure is just a failed poll, and says so.
          if (!(err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 429)) throw err;
          deltaBroken = true;
        }
      }
      return { changes: await listAll(ref), cursor: null };
    },
  };
}

/** A file's content, from the pre-authenticated link in its metadata: a plain GET, no token needed. */
async function fetchDownload(drive, meta) {
  const url = meta['@microsoft.graph.downloadUrl'];
  if (!url) throw new Error('OneDrive gave no download link for that file');
  const res = await drive.download(url);
  if (!res.ok) throw new Error(`OneDrive download ${res.status}`);
  return res.text();
}

/**
 * A single file by path, with eTag guards — the recipe file (data/recipes.js).
 * Its folder is resolved the same way, so a recipe file in a shared folder is
 * reached through the shortcut. Same contract as createMemoryFiles.
 */
export function createOneDriveFiles({ drive }) {
  async function locate(path) {
    const segs = path.split('/').filter(Boolean);
    const name = segs.pop();
    const ref = await drive.folder(`/${segs.join('/')}`);
    if (!ref) throw new FolderNotFound(`/${segs.join('/')}`);
    return { ref, name };
  }

  return {
    async stat(path) {
      const { ref, name } = await locate(path);
      const res = await drive.call(under(ref, name));
      if (res.status === 404) return null;
      if (!res.ok) throw await drive.fail('check', res);
      return { etag: (await res.json()).eTag };
    },

    async read(path) {
      // The item's metadata carries its eTag and a short-lived download link.
      // Reading both from one response ties the content to the eTag that
      // If-Match will later be checked against.
      const { ref, name } = await locate(path);
      const res = await drive.call(under(ref, name));
      if (res.status === 404) return null;
      if (!res.ok) throw await drive.fail('read', res);
      const meta = await res.json();
      return { content: await fetchDownload(drive, meta), etag: meta.eTag };
    },

    async put(path, content, { ifMatch, ifNoneMatch } = {}) {
      const { ref, name } = await locate(path);
      const headers = { 'Content-Type': 'application/json' };
      if (ifMatch) headers['If-Match'] = ifMatch;
      if (ifNoneMatch) headers['If-None-Match'] = ifNoneMatch;
      const res = await drive.call(underWith(ref, name, '/content'), { method: 'PUT', headers, body: content });
      if (res.status === 412 || res.status === 409) return CONFLICT;
      if (!res.ok) throw await drive.fail('save', res);
      return { etag: (await res.json()).eTag };
    },
  };
}

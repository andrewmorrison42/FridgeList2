// A fake Microsoft Graph, faithful where the OneDrive adapter depends on it.
//
// The adapter was first tested only against a storage fake that returned
// full paths from delta. Real OneDrive does not: delta items carry a name and
// a parent id, never a path, and come in pages. That gap hid a bug that meant
// no phone ever received another phone's changes. So this fake models what
// the adapter actually meets:
//
//  - several people, each with their own drive; a bearer token names the person
//  - path addressing from a drive root, and relative to an item (…/items/{id}:/a/b)
//  - a folder shared with someone, reached through a shortcut in their drive
//    (an item with `remoteItem`) or through /me/drive/sharedWithMe
//  - items outside what you own or were shared answer 404, as Graph does
//  - delta without paths, in pages of three, with a deltaLink to resume from
//  - uploads that need the parent folder to exist (Graph may create it; the
//    adapter must not depend on that), If-Match / If-None-Match on upload,
//    If-None-Match on metadata (304)
//  - content downloaded from a separate pre-authenticated URL

export function createFakeGraph() {
  let seq = 0;
  const items = new Map();            // id → item
  const drives = new Map();           // driveId → { rootId, owner }
  const shares = new Map();           // itemId → Set(person)
  const shortcuts = [];               // { person, name, targetId }
  let changeSeq = 0;
  const changeLog = [];               // { seq, id }
  const calls = [];

  const id = () => `i${++seq}`;
  const etag = () => `"e${++seq}"`;
  const touch = (itemId) => { changeLog.push({ seq: ++changeSeq, id: itemId }); };

  function addPerson(person, displayName = person) {
    const driveId = `drive-${person}`;
    const rootId = id();
    items.set(rootId, { id: rootId, name: 'root', parentId: null, driveId, folder: true, eTag: etag(), createdBy: displayName });
    drives.set(driveId, { rootId, owner: person, displayName });
    return driveId;
  }

  const childrenOf = (parentId) => [...items.values()].filter((i) => i.parentId === parentId && !i.deleted);
  const childNamed = (parentId, name) => childrenOf(parentId).find((i) => i.name.toLowerCase() === name.toLowerCase());
  const ancestors = (item) => { const out = []; for (let x = item; x; x = items.get(x.parentId)) out.push(x); return out; };
  const canSee = (person, item) => drives.get(item.driveId).owner === person
    || ancestors(item).some((a) => shares.get(a.id)?.has(person));

  function walk(fromId, path) {
    let cur = items.get(fromId);
    for (const seg of path.split('/').filter(Boolean).map(decodeURIComponent)) {
      if (!cur) return null;
      if (cur.shortcutTo) cur = items.get(cur.shortcutTo);       // Graph does NOT do this for path addressing …
      cur = childNamed(cur.id, seg);
    }
    return cur ?? null;
  }

  const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const notFound = () => json({ error: { code: 'itemNotFound' } }, 404);

  function view(item) {
    const out = { id: item.id, name: item.name, eTag: item.eTag, parentReference: { driveId: item.driveId, id: item.parentId },
      createdBy: { user: { displayName: drives.get(item.driveId).displayName } }, lastModifiedDateTime: item.modified ?? '2026-09-20T10:00:00Z' };
    if (item.folder) out.folder = { childCount: childrenOf(item.id).length };
    if (!item.folder && !item.shortcutTo) {
      out.file = {};
      out.size = item.content.length;
      out['@microsoft.graph.downloadUrl'] = `https://download.fake/${item.id}/${item.eTag.replace(/"/g, '')}`;
    }
    if (item.shortcutTo) {
      const t = items.get(item.shortcutTo);
      out.remoteItem = { id: t.id, name: t.name, folder: {}, parentReference: { driveId: t.driveId } };
      delete out.file;
    }
    return out;
  }

  function create(parent, name, fields) {
    const item = { id: id(), name, parentId: parent.id, driveId: parent.driveId, eTag: etag(), ...fields };
    items.set(item.id, item);
    touch(item.id);
    return item;
  }

  async function handle(url, init, person) {
    const u = new URL(url);
    let path = decodeURIComponent(u.pathname.replace(/^\/v1\.0/, ''));
    const method = (init.method ?? 'GET').toUpperCase();
    const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

    // -- resolve the addressed item ---------------------------------------
    let base; let rest = '';
    let m;
    if (path === '/me/drive') return json({ id: `drive-${person}` });
    if ((m = path.match(/^\/me\/drive\/sharedWithMe$/))) {
      const value = [...shares.entries()].filter(([, who]) => who.has(person))
        .map(([itemId]) => items.get(itemId)).map((t) => ({ id: `sw-${t.id}`, name: t.name, folder: {},
          remoteItem: { id: t.id, name: t.name, folder: {}, parentReference: { driveId: t.driveId },
            shared: { owner: { user: { displayName: drives.get(t.driveId).displayName } } } } }));
      return json({ value });
    }
    if ((m = path.match(/^\/me\/drive\/root(?::(.*?))?(?::)?(\/children|\/content|\/delta)?$/))) {
      base = items.get(drives.get(`drive-${person}`).rootId);
      rest = m[1] ?? '';
      path = m[2] ?? '';
    } else if ((m = path.match(/^\/drives\/([^/]+)\/items\/([^/:]+)(?::(.*?))?(?::)?(\/children|\/content|\/delta)?$/))) {
      base = items.get(m[2]);
      if (!base || base.driveId !== m[1] || !canSee(person, base)) return notFound();
      rest = m[3] ?? '';
      path = m[4] ?? '';
    } else {
      return json({ error: { code: 'invalidRequest', path } }, 400);
    }
    const suffix = path;
    // Path addressing does not pass through shortcuts: a path through one is 404.
    const segs = rest.split('/').filter(Boolean);
    let item = base;
    let parent = null;
    for (let i = 0; i < segs.length; i++) {
      if (item.shortcutTo) return notFound();
      parent = item;
      const next = childNamed(item.id, segs[i]);
      if (!next) { item = null; break; }
      item = next;
    }

    // -- uploads ------------------------------------------------------------
    if (method === 'PUT' && suffix === '/content') {
      const body = typeof init.body === 'string' ? init.body : String(init.body ?? '');
      if (!item) {
        if (!parent || segs.length === 0) return notFound();
        const expectedParentDepth = segs.length - 1;
        // The parent itself must exist (the loop broke at the last segment).
        const parentPath = segs.slice(0, expectedParentDepth);
        let p = base;
        for (const s of parentPath) { p = p && childNamed(p.id, s); }
        if (!p) return notFound();
        if (h['if-match']) return json({ error: { code: 'preconditionFailed' } }, 412);
        const made = create(p, segs.at(-1), { content: body });
        return json(view(made), 201);
      }
      if (h['if-none-match'] === '*') return json({ error: { code: 'nameAlreadyExists' } }, 412);
      if (h['if-match'] && h['if-match'] !== item.eTag) return json({ error: { code: 'preconditionFailed' } }, 412);
      item.content = body; item.eTag = etag(); touch(item.id);
      return json(view(item));
    }

    // -- make a folder ------------------------------------------------------
    if (method === 'POST' && suffix === '/children') {
      if (!item) return notFound();
      const body = JSON.parse(init.body);
      if (childNamed(item.id, body.name)) return json({ error: { code: 'nameAlreadyExists' } }, 409);
      return json(view(create(item, body.name, { folder: true })), 201);
    }

    if (method === 'DELETE') {
      if (!item) return notFound();
      item.deleted = true; touch(item.id);
      return new Response(null, { status: 204 });
    }

    if (!item) return notFound();

    // -- reads --------------------------------------------------------------
    if (suffix === '/children') {
      const target = item.shortcutTo ? null : item;
      if (!target) return notFound();
      return json({ value: childrenOf(target.id).map(view) });
    }
    if (suffix === '/content') {
      if (item.folder) return notFound();
      if (h['if-none-match'] && h['if-none-match'] === item.eTag) return new Response(null, { status: 304 });
      return new Response(null, { status: 302, headers: { location: view(item)['@microsoft.graph.downloadUrl'] } });
    }
    if (suffix === '/delta') {
      const after = Number(u.searchParams.get('token') ?? 0);
      const page = Number(u.searchParams.get('page') ?? 0);
      const inScope = (x) => ancestors(x).some((a) => a.id === item.id);
      const since = [...new Map(changeLog.filter((c) => c.seq > after).map((c) => [c.id, c])).values()]
        .map((c) => items.get(c.id)).filter((x) => x && inScope(x));
      const all = after === 0 ? [...items.values()].filter((x) => inScope(x) && !x.deleted) : since;
      const chunk = all.slice(page * 3, page * 3 + 3).map((x) => {
        const v = view(x);
        delete v['@microsoft.graph.downloadUrl'];
        if (x.deleted) v.deleted = { state: 'deleted' };
        return v;                                            // no parentReference.path — as Graph's delta
      });
      const baseUrl = `https://graph.microsoft.com/v1.0/drives/${item.driveId}/items/${item.id}/delta`;
      const more = (page + 1) * 3 < all.length;
      return json({ value: chunk, ...(more
        ? { '@odata.nextLink': `${baseUrl}?token=${after}&page=${page + 1}` }
        : { '@odata.deltaLink': `${baseUrl}?token=${changeSeq}` }) });
    }
    if (h['if-none-match'] && h['if-none-match'] === item.eTag) return new Response(null, { status: 304 });
    return json(view(item));
  }

  async function fetchImpl(input, init = {}) {
    const url = String(input);
    calls.push({ method: init.method ?? 'GET', url });
    if (url.startsWith('https://download.fake/')) {
      const [, , , itemId] = url.split('/');
      const item = items.get(itemId);
      return item && !item.deleted ? new Response(item.content, { status: 200 }) : new Response('gone', { status: 404 });
    }
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? '';
    const person = auth.replace(/^Bearer /, '');
    if (!person || !drives.has(`drive-${person}`)) return json({ error: { code: 'InvalidAuthenticationToken' } }, 401);
    const res = await handle(url, init, person);
    if (res.status === 302) return fetchImpl(res.headers.get('location'), {});   // fetch follows redirects
    return res;
  }

  return {
    fetch: fetchImpl,
    calls,
    addPerson,
    /** A folder in someone's drive, by path from their root. Created if missing. */
    folder(person, path) {
      let cur = items.get(drives.get(`drive-${person}`).rootId);
      for (const seg of path.split('/').filter(Boolean)) cur = childNamed(cur.id, seg) ?? create(cur, seg, { folder: true });
      return cur;
    },
    file(person, path, content) {
      const segs = path.split('/').filter(Boolean);
      const dir = this.folder(person, segs.slice(0, -1).join('/'));
      const existing = childNamed(dir.id, segs.at(-1));
      if (existing) { existing.content = content; existing.eTag = etag(); touch(existing.id); return existing; }
      return create(dir, segs.at(-1), { content });
    },
    read(person, path) { return walk(drives.get(`drive-${person}`).rootId, path)?.content ?? null; },
    share(item, person) { if (!shares.has(item.id)) shares.set(item.id, new Set()); shares.get(item.id).add(person); },
    shortcut(person, name, target) {
      const root = items.get(drives.get(`drive-${person}`).rootId);
      return create(root, name, { shortcutTo: target.id });
    },
  };
}

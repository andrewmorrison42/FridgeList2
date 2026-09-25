// Local persistence. ARCHITECTURE.md §7.1.
//
// Every device holds the complete event history. This is what makes each one a
// full replica rather than a cache, and it is the whole answer to "what if the
// backend disappears": five devices still hold everything, and the storage
// layer is pointed somewhere else.
//
// Falls back to memory where IndexedDB is unavailable (private windows, tests),
// because an app that refuses to run is worse than one that forgets.

const DB = 'fridgelist';
const STORE = 'events';
const FILES = 'files';        // the last copy seen of a shared file, e.g. the recipes

export async function openLocal() {
  if (typeof indexedDB === 'undefined') return memoryFallback();
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        }
        if (!req.result.objectStoreNames.contains(FILES)) req.result.createObjectStore(FILES);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const tx = (mode, name = STORE) => db.transaction(name, mode).objectStore(name);
    const done = (req) => new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return {
      files: {
        get: (key) => done(tx('readonly', FILES).get(key)),
        set: (key, value) => done(tx('readwrite', FILES).put(value, key)),
      },
      async all() {
        return new Promise((resolve, reject) => {
          const req = tx('readonly').getAll();
          req.onsuccess = () => resolve(req.result ?? []);
          req.onerror = () => reject(req.error);
        });
      },
      async put(events) {
        const store = tx('readwrite');
        for (const e of [].concat(events)) store.put(e);
        return new Promise((resolve, reject) => {
          store.transaction.oncomplete = () => resolve();
          store.transaction.onerror = () => reject(store.transaction.error);
        });
      },
      async clear() {
        return new Promise((resolve) => { tx('readwrite').clear().onsuccess = () => resolve(); });
      },
    };
  } catch {
    return memoryFallback();
  }
}

function memoryFallback() {
  const events = new Map();
  const files = new Map();
  return {
    files: { async get(k) { return files.get(k); }, async set(k, v) { files.set(k, v); } },
    async all() { return [...events.values()]; },
    async put(list) { for (const e of [].concat(list)) events.set(e.id, e); },
    async clear() { events.clear(); },
    isMemoryOnly: true,
  };
}

/** Small per-device settings that are not shared: id, nickname, backend choice. */
export const local = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(`fridgelist.${key}`); return v === null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`fridgelist.${key}`, JSON.stringify(value)); } catch { /* private window */ }
  },
};

/** This device's identity: random, persistent, not tied to the login. §5.2. */
export function deviceIdentity() {
  let id = local.get('deviceId');
  if (!id) {
    id = 'd' + Math.random().toString(36).slice(2, 8);
    local.set('deviceId', id);
  }
  return { id, nickname: local.get('nickname', id) };
}

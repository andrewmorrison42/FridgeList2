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

export async function openLocal() {
  if (typeof indexedDB === 'undefined') return memoryFallback();
  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    const tx = (mode) => db.transaction(STORE, mode).objectStore(STORE);
    return {
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
  return {
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
  // Unnamed until someone names it — not the random id, which read as
  // gibberish ("d6yeg74") in Setup and on everyone's roster (glitch #17).
  return { id, nickname: local.get('nickname', '') };
}

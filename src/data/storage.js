// The storage interface, and the one implementation that needs no network.
//
// Nothing above this line knows what OneDrive is. Porting to Dropbox, Google
// Drive, a WebDAV share or the File System Access API is a day's work against
// these five functions, and the storage contract in test/ re-runs unchanged to
// prove the port did not break the guarantee. ARCHITECTURE.md §15.2.

export const NOT_MODIFIED = Symbol('NOT_MODIFIED');

/**
 * The contract every backend must satisfy:
 *
 *   list(prefix)        → [{ path, etag, size }]
 *   read(path, etag?)   → { content, etag } | NOT_MODIFIED | null
 *   write(path, content)→ { etag }          — MUST be atomic (see below)
 *   remove(path)        → void
 *   delta(cursor)       → { changes: [path], cursor }
 *
 * `write` being atomic is not optional. A device rewrites its own log with new
 * events appended; a partial write would truncate that log and destroy events
 * no other device holds a copy of — the failure the whole per-device file
 * layout exists to prevent, self-inflicted. A retry heals it only if the device
 * is still awake to retry, and the device in question is a phone going back
 * into a pocket. §7.4.
 */

/** In-memory backend. Used by tests, and by the app before a backend is linked. */
export function createMemoryStorage() {
  const files = new Map();
  const changes = [];
  let etagSeq = 0;

  return {
    async list(prefix = '') {
      return [...files.entries()]
        .filter(([p]) => p.startsWith(prefix))
        .map(([path, f]) => ({ path, etag: f.etag, size: f.content.length }));
    },
    async read(path, etag) {
      const f = files.get(path);
      if (!f) return null;
      if (etag && etag === f.etag) return NOT_MODIFIED;
      return { content: f.content, etag: f.etag };
    },
    async write(path, content) {
      const etag = `e${++etagSeq}`;
      files.set(path, { content, etag });
      changes.push(path);
      return { etag };
    },
    async remove(path) {
      files.delete(path);
      changes.push(path);
    },
    async delta(cursor = 0) {
      return { changes: [...new Set(changes.slice(cursor))], cursor: changes.length };
    },
  };
}

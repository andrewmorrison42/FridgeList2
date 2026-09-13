// An in-memory storage backend that misbehaves on purpose.
//
// The real backend is a network service that fails halfway, returns stale
// reads, and hands back changes out of order. Testing against a well-behaved
// fake proves nothing about any of that, so this one can be told to fail,
// and — importantly — can be told to fail *non-atomically*, so the tests can
// demonstrate why atomicity is a requirement rather than a nicety.
//
// Implements the five-function interface of ARCHITECTURE.md §15.2.

export const NOT_MODIFIED = Symbol('NOT_MODIFIED');

export function createFakeStorage({ failEvery = 0, atomic = true, seed = 1 } = {}) {
  const files = new Map();       // path -> { content, etag }
  const changes = [];            // append-only change log, for delta()
  let etagSeq = 0;
  let calls = 0;
  let rand = seed >>> 0;

  const nextRand = () => (rand = (Math.imul(rand, 1103515245) + 12345) & 0x7fffffff);
  const shouldFail = () => failEvery > 0 && ++calls % failEvery === 0;

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
      if (shouldFail()) {
        if (!atomic) {
          // The failure mode the contract forbids: a partial write that
          // replaces good content with a truncated fragment. A device doing
          // this to its own log destroys its own events — the very failure
          // the whole per-device file layout exists to prevent, self-inflicted.
          const cut = nextRand() % Math.max(1, content.length);
          files.set(path, { content: content.slice(0, cut), etag: `e${++etagSeq}` });
          changes.push(path);
        }
        throw new Error(`simulated write failure: ${path}`);
      }
      files.set(path, { content, etag: `e${++etagSeq}` });
      changes.push(path);
      return { etag: files.get(path).etag };
    },

    async remove(path) {
      if (shouldFail()) throw new Error(`simulated remove failure: ${path}`);
      files.delete(path);
      changes.push(path);
    },

    async delta(cursor = 0) {
      return { changes: [...new Set(changes.slice(cursor))], cursor: changes.length };
    },
  };
}

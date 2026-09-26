// The shopper roster and staleness reporting. ARCHITECTURE.md §8.2, §8.3.
//
// Bluetooth proximity is unavailable to a PWA, and would have answered the
// wrong question anyway: what matters is who is *live*, not who is within ten
// metres. A heartbeat file per device answers that across the whole store.

const HEARTBEAT_MS = 15000;
const STALE_MS = 60000;
const DROP_MS = 300000;           // five minutes without a heartbeat leaves the roster

export function presencePath(shopId, deviceId) {
  return `shops/${shopId}/presence/${deviceId}.json`;
}

export function createPresence({ storage, deviceId, nickname, now = () => Date.now() }) {
  let joined = false;

  return {
    get joined() { return joined; },

    /**
     * Nominate this device as shopping. Explicit by preference — the roster is
     * what staleness reporting is scoped to — but a device that starts ticking
     * without nominating is enrolled silently, so nobody's work is invisible.
     */
    async join(shopId, { silent = false } = {}) {
      joined = true;
      await this.beat(shopId, { silent });
    },

    async leave(shopId) {
      joined = false;
      await storage.remove(presencePath(shopId, deviceId)).catch(() => {});
    },

    /** Its own file, per §4. Nobody writes anyone else's presence. */
    async beat(shopId, { syncStatus = {}, silent = false } = {}) {
      await storage.write(presencePath(shopId, deviceId), JSON.stringify({
        deviceId, nickname, at: now(), silent,
        unsent: syncStatus.unsent ?? 0,
        lastPullAt: syncStatus.lastPullAt ?? null,
      }));
    },

    /** Everyone currently on the roster, with how current each one is. */
    async roster(shopId) {
      const files = await storage.list(`shops/${shopId}/presence/`);
      const out = [];
      for (const f of files) {
        const got = await storage.read(f.path);
        if (!got || !got.content) continue;
        let p;
        try { p = JSON.parse(got.content); } catch { continue; }
        const ageMs = now() - p.at;
        if (ageMs > DROP_MS) continue;              // dropped off; cannot hold up a close
        out.push({
          deviceId: p.deviceId,
          nickname: p.nickname ?? p.deviceId,
          isSelf: p.deviceId === deviceId,
          silent: !!p.silent,
          ageMs,
          unsent: p.unsent ?? 0,
          stale: ageMs > STALE_MS,
        });
      }
      return out.sort((a, b) => a.nickname.localeCompare(b.nickname));
    },

    heartbeatMs: HEARTBEAT_MS,
  };
}

/**
 * What the device shows about how current it is. Both conditions are surfaced,
 * per the household's requirement: whether *I* have lost sync, and whether any
 * other active shopper has. FR-SYNC-2.
 *
 * A brief lag is fine and is stated (FR-SYNC-3). A confident-looking lie is the
 * defect — so when sync state is unknown, this says unknown.
 */
export function staleness(syncStatus, roster) {
  const others = roster.filter((r) => !r.isSelf);
  const selfAge = syncStatus.ageMs;
  // Unsent *shop* events mean this device is holding ticks nobody else can
  // see, which is exactly what staleness is for. Unsent library events —
  // a bulk import, or a recipe edited at the table — are not urgent (§7.3) and
  // must not make a working list look broken.
  const unsentUrgent = syncStatus.unsentShop ?? syncStatus.unsent;
  // Any change not yet uploaded after a failed attempt is worth saying: a
  // menu picked on one phone that never reaches the others looks, to both
  // people, exactly like a working app.
  const stuck = syncStatus.pushError ? syncStatus.unsent : 0;
  const selfStale = selfAge === null || selfAge > STALE_MS || unsentUrgent > 0 || stuck > 0;
  const staleOthers = others.filter((r) => r.stale);

  return {
    selfStale,
    selfText:
      selfAge === null ? 'not synced yet'
      : stuck > 0 ? `${stuck} change${stuck === 1 ? '' : 's'} not saved to OneDrive`
      : unsentUrgent > 0 ? `${unsentUrgent} unsent · last synced ${ago(selfAge)}`
      : `synced ${ago(selfAge)}`,
    others: others.map((r) => ({ ...r, text: `${r.nickname} · ${ago(r.ageMs)}` })),
    warn: selfStale || staleOthers.length > 0,
    warnText:
      stuck > 0 ? `Not saved to OneDrive yet, so the others cannot see it: ${syncStatus.pushError}`
      : selfStale && staleOthers.length
        ? `You and ${staleOthers.length} other device(s) may be out of date`
      : selfStale ? 'Your list may be out of date'
      : staleOthers.length ? `${staleOthers.map((r) => r.nickname).join(', ')} may be out of date`
      : null,
  };
}

function ago(ms) {
  if (ms < 1000) return 'just now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
}

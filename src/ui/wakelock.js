// Keep the screen on while a recipe is open — for cooking from the phone.
//
// A per-device choice (it is about this phone's battery, not the household's
// data). The browser drops the lock whenever the page is hidden, so it is taken
// again when the page comes back.

import { local } from '../data/persist.js';

export function createWakeLock() {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  let lock = null;
  let pending = null;
  let active = false;

  function take() {
    if (!supported || lock || pending) return;       // one request at a time
    pending = navigator.wakeLock.request('screen')
      .then((l) => {
        lock = l;
        lock.addEventListener('release', () => { if (lock === l) lock = null; });
        if (!(active && self.wanted)) drop();         // not wanted any more by the time it came
      })
      .catch(() => { lock = null; })                 // refused (low battery, not visible): stay dimmable
      .finally(() => { pending = null; });
  }
  function drop() { const l = lock; lock = null; l?.release().catch(() => {}); }

  if (supported) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && active && self.wanted) take();
    });
  }

  const self = {
    supported,
    get wanted() { return local.get('keepAwake', false); },
    set wanted(on) { local.set('keepAwake', !!on); self.apply(active); },
    /** Called on every render: is a recipe on screen right now? */
    apply(recipeOpen) {
      active = recipeOpen;
      if (active && self.wanted) take(); else drop();
    },
  };
  return self;
}

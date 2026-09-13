// The smallest possible view helper. No framework, no build step — §13.
//
// `h` builds elements; `bind` connects a store to a render function so that a
// merge always reaches the screen. There is no pull-to-refresh in this app and
// no view that reads state once at mount: that shape is exactly the failure the
// autopsy found (F2 cause c), and FR-SYNC-7 exists to forbid it.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

/**
 * Render into `mount` now, and again on every change to the store.
 * Returns an unsubscribe function.
 */
export function bind(store, mount, render) {
  return store.subscribe(() => {
    const scroll = mount.scrollTop;
    clear(mount).append(render());
    mount.scrollTop = scroll;          // re-rendering must not lose your place
  });
}

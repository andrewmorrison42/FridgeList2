// The header: how current this device is, who else is shopping, and the one
// action the current phase allows. §8.2, §8.3, FR-SYNC-2, FR-SHOP-4.

import { h } from './dom.js';

export function statusBar(app, { onAction }) {
  const s = app.staleness;
  const can = app.can;
  const { id, phase } = app.shop;

  return h('header', { class: `status ${s.warn ? 'warn' : ''}` },
    h('div', { class: 'status-row' },
      h('span', { class: 'phase', title: id },
        phase === 'draft' ? 'Planning' : phase === 'open' ? 'Shopping' : 'Finished'),
      // Never present stale data indistinguishably from current data. A brief
      // lag is fine and is stated; a confident-looking lie is the defect.
      h('span', { class: `sync ${s.selfStale ? 'stale' : ''}` }, s.selfText),
    ),

    s.others.length > 0 && h('div', { class: 'roster' },
      s.others.map((r) => h('span', { class: `who ${r.stale ? 'stale' : ''}` }, r.text)),
    ),

    s.warnText && h('div', { class: 'warn-text' }, s.warnText),

    h('div', { class: 'actions' },
      can.canLock && h('button', { class: 'primary', onClick: () => onAction('lock') },
        'Menu is settled'),
      can.canTick && !app.presence.joined && h('button', { onClick: () => onAction('join') },
        "I'm shopping"),
      can.canClose && h('button', { class: 'primary', onClick: () => onAction('close') },
        'Shopping is completed'),
    ),
  );
}

/**
 * A refusal that names its cause and offers the way out.
 *
 * FR-SHOP-4: the menu lock means an unfinished shop blocks next week's
 * planning. That failure is acceptable only while its remedy is immediately to
 * hand — a bare refusal would turn a loud failure into a stuck one.
 */
export function refusal(app, action, onAction) {
  const why = app.why(action);
  if (!why) return null;
  return h('div', { class: 'refusal' },
    h('p', {}, why.reason),
    h('button', { class: 'primary', onClick: () => onAction(why.remedyAction === 'closeShop' ? 'close' : 'lock') },
      why.remedy),
  );
}

/** Shown before finishing: what nobody ticked, and who might not have synced. */
export function closeReport(app) {
  const outstanding = app.outstanding();
  const stale = app.roster.filter((r) => r.stale && !r.isSelf);
  const s = app.staleness;

  return h('div', { class: 'close-report' },
    h('h2', {}, 'Before finishing'),

    outstanding.length === 0
      ? h('p', { class: 'ok' }, 'Everything on the list is ticked.')
      : h('div', {},
          h('p', {}, `${outstanding.length} item(s) nobody has ticked:`),
          h('ul', {}, outstanding.map((l) => h('li', {}, l.name))),
        ),

    // Informed override, never a silent one, and never a hard block a flat
    // battery can strand you behind.
    stale.length > 0 && h('p', { class: 'warn-text' },
      `${stale.map((r) => `${r.nickname}'s device hasn't checked in for ${Math.round(r.ageMs / 60000)} minutes`).join('; ')}.`),

    s.selfStale && h('p', { class: 'warn-text' },
      'Your own device is not up to date, so this report may be wrong.'),
  );
}

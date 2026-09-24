// The glitches found by using the app, each pinned by the way a person would
// hit it. Glitches #4-#9.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { serve, launch, phone, shopping } from './phone.js';

let server;
let browser;
beforeAll(async () => { server = await serve(); browser = await launch(); });
afterAll(async () => { await browser?.close(); await server?.close(); });

describe('as a person uses it', () => {
  it('#4 — before sharing is set up, the header says so rather than "synced"', async () => {
    const p = await phone(browser, server.url);
    await p.page.waitForTimeout(300);
    expect(await p.page.locator('.sync').textContent()).toMatch(/this device only/i);
    await p.close();
  });

  for (const [tab, label] of [['Plan', 'plan'], ['Wait', 'wait list'], ['Recipes', 'recipes']]) {
    it(`#5 — typing in the ${label} search keeps every key, and keeps the box focused`, async () => {
      const p = await phone(browser, server.url);
      await p.tab(tab);
      const box = p.page.locator('input[type=search]');
      await p.type(box, 'laksa');
      expect(await box.inputValue()).toBe('laksa');
      expect(await p.page.evaluate(() => document.activeElement?.type)).toBe('search');
      await p.close();
    });
  }

  it('#6 — ticking a line leaves the list where it was', async () => {
    const p = await phone(browser, server.url);
    await shopping(p);
    await p.tab('List');
    await p.page.evaluate(() => window.scrollTo(0, 1200));
    await p.page.waitForTimeout(100);
    const before = await p.scrollY();
    // Tap a box that is actually on screen, as a thumb would. (A box hidden
    // under the sticky header makes Playwright scroll it into view first — a
    // movement the test would then blame on the app.)
    const onScreen = await p.page.evaluate(() => [...document.querySelectorAll('.list input[type=checkbox]')]
      .findIndex((c) => { const r = c.getBoundingClientRect(); return r.top > 150 && r.bottom < window.innerHeight - 80; }));
    await p.tap(p.page.locator('.list input[type=checkbox]').nth(onScreen));
    expect(Math.abs((await p.scrollY()) - before)).toBeLessThan(5);
    await p.close();
  });

  it('switching screens while scrolled down lands at the top of the new screen', async () => {
    const p = await phone(browser, server.url);
    await shopping(p);
    await p.tab('List');
    await p.page.evaluate(() => window.scrollTo(0, 1200));
    await p.page.waitForTimeout(100);
    await p.tab('Recipes');
    expect(await p.scrollY()).toBe(0);
    await p.close();
  });

  it('#7 — a tick made as the shop starts is uploaded within a second or so', async () => {
    const p = await phone(browser, server.url);
    await p.page.waitForTimeout(500);                       // settle into the slow planning cadence
    await shopping(p);
    await p.tab('List');
    await p.tap(p.page.locator('.list input[type=checkbox]').first());
    await p.page.waitForTimeout(1500);
    expect(await p.app(() => window.app.sync.status().unsentShop)).toBe(0);
    await p.close();
  });

  it('#8 — every visible button, in every phase, either works or explains itself: never an error', async () => {
    const p = await phone(browser, server.url);
    const skip = /Connect|Disconnect|Print|Reload|Shopping is completed|Finish anyway|Menu is settled/;
    const sweep = async () => {
      for (const tab of ['List', 'Plan', 'Wait', 'Recipes', 'Setup']) {
        await p.tab(tab);
        for (let i = 0; i < 12; i++) {
          const buttons = p.page.locator('main button:visible');
          if (i >= await buttons.count()) break;
          const b = buttons.nth(i);
          if (skip.test(await b.textContent())) continue;
          await b.tap().catch(() => {});
          await p.page.waitForTimeout(60);
        }
      }
    };
    // Something on every screen to act on: a planned meal and a Wait List item.
    await p.app(() => {
      window.app.planRecipe('fish-laksa', 6);
      const mayo = [...window.app.library.ingredients.values()].find((i) => i.name === 'Mayonnaise');
      window.app.addWaitList(mayo.id);
    });
    await sweep();                                          // planning
    await p.app(() => { window.app.planRecipe('cheeseburgers', 6); window.app.addWaitList([...window.app.library.ingredients.values()].find((i) => i.name === 'Mayonnaise').id); window.app.lockShop(); });
    await sweep();                                          // shopping
    expect(p.errors).toEqual([]);
    // ...and nothing offered was then refused: a view offers only what works.
    expect(await p.app(() => window.app.ui.refusals ?? 0)).toBe(0);
    await p.close();
  });

  it('servings: tapping + on a planned meal changes how many it is for (FR-MENU-1)', async () => {
    const p = await phone(browser, server.url);
    await p.app(() => window.app.planRecipe('fish-laksa', 4));
    await p.tab('Plan');
    const count = p.page.locator('.chosen .stepper .servings').first();
    expect(await count.textContent()).toBe('4');
    await p.tap(p.page.locator('.chosen button[aria-label=more]').first());
    expect(await count.textContent()).toBe('5');
    await p.close();
  });

  it('on every screen, nothing on a row sits on top of anything else on it', async () => {
    // Found by looking, not by asserting: the servings stepper crushed each
    // meal's name to a word per line and overlapped it. This checks every
    // row's visible leaves — text, buttons, boxes — pairwise, on every screen.
    const p = await phone(browser, server.url);
    await p.app(() => {
      for (const r of ['fish-laksa', 'rosemary-garlic-roast-lamb', 'baked-vegie-samosas']) window.app.planRecipe(r, 6);
      const ing = [...window.app.library.ingredients.values()];
      window.app.addWaitList(ing.find((i) => i.name === 'Mayonnaise').id);
    });
    const overlaps = async () => p.page.evaluate(() => {
      const found = [];
      for (const row of document.querySelectorAll('main li')) {
        const leaves = [...row.querySelectorAll('*')].filter((e) => e.children.length === 0)
          .map((e) => [e, e.getBoundingClientRect()]).filter(([, r]) => r.width > 0 && r.height > 0);
        for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
          const [a, ra] = leaves[i]; const [b, rb] = leaves[j];
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w > 2 && h > 2) found.push(`${a.textContent.trim() || a.tagName} / ${b.textContent.trim() || b.tagName}`);
        }
      }
      return found;
    });
    const seen = [];
    for (const phase of ['planning', 'shopping']) {
      if (phase === 'shopping') await p.app(() => window.app.lockShop());
      for (const tab of ['List', 'Plan', 'Wait', 'Recipes']) { await p.tab(tab); seen.push(...(await overlaps()).map((o) => `${phase}/${tab}: ${o}`)); }
    }
    expect(seen.slice(0, 5)).toEqual([]);
    await p.close();
  });

  it('#14 — the close report puts the decision first, and groups what is missing', async () => {
    const p = await phone(browser, server.url);
    await shopping(p);
    await p.tap(p.page.locator('header button', { hasText: 'Shopping is completed' }));
    // The decision is reachable without scrolling past 57 names.
    const finish = p.page.locator('main button', { hasText: 'Finish anyway' }).first();
    const box = await finish.boundingBox();
    expect(box.y + box.height).toBeLessThan(700);
    // And what is missing is grouped the way the list is, with quantities.
    expect(await p.page.locator('.close-report h3').count()).toBeGreaterThan(3);
    expect(await p.page.locator('.close-report .qty').count()).toBeGreaterThan(10);
    await p.close();
  });

  it('#15 — after the shop, this week\'s meals read as meals to cook, not as "carried over"', async () => {
    const p = await phone(browser, server.url);
    await p.app(() => { window.app.planRecipe('fish-laksa', 4); window.app.lockShop(); });
    await p.app(() => window.app.closeShop());
    await p.tab('Plan');
    const text = await p.page.locator('main').textContent();
    expect(text).not.toMatch(/carried over/i);
    expect(text).toMatch(/to cook/i);
    await p.close();
  });

  it('#19 — the printed list says which week it is for', async () => {
    const p = await phone(browser, server.url);
    await shopping(p);
    await p.tab('List');
    await p.page.emulateMedia({ media: 'print' });
    const dated = p.page.locator('.print-only');
    expect(await dated.isVisible()).toBe(true);
    expect(await dated.textContent()).toMatch(/\d{1,2} [A-Z][a-z]{2}/);
    await p.close();
  });

  it('#20 — during a shop, a meal can still be marked cooked from the Plan screen', async () => {
    const p = await phone(browser, server.url);
    await shopping(p);
    await p.tab('Plan');
    const cooked = p.page.locator('main button', { hasText: 'Cooked' }).first();
    expect(await cooked.count()).toBe(1);
    await p.tap(cooked);
    expect(await p.app(() => [...window.app.selections.values()].filter((s) => s.status === 'cooked').length)).toBe(1);
    expect(await p.app(() => window.app.ui.refusals ?? 0)).toBe(0);
    await p.close();
  });

  it('Wait List: something that is not an ingredient, and a note, typed as a person types (FR-WAIT-1)', async () => {
    const p = await phone(browser, server.url);
    await p.tab('Wait');
    await p.type(p.page.locator('input[type=search]'), 'birthday candles');
    await p.tap(p.page.locator('.picker li', { hasText: 'not in the ingredient list' }).locator('button'));
    expect(await p.page.locator('.waitlist li').allTextContents()).toEqual(['birthday candlesRemove']);

    await p.type(p.page.locator('input[type=search]'), 'Mayonnaise');
    await p.type(p.page.locator('input.note-input'), 'the big jar');
    await p.tap(p.page.locator('.picker li', { hasText: /^Mayonnaise/ }).locator('button'));
    const mayo = p.page.locator('.waitlist li', { hasText: 'Mayonnaise' });
    expect(await mayo.textContent()).toContain('the big jar');
    await p.close();
  });

  it('editing a recipe, typed as a person types: the change is saved and shown as written (FR-REC-2)', async () => {
    const p = await phone(browser, server.url);
    await p.tab('Recipes');
    await p.type(p.page.locator('input[type=search]'), 'mushroom risotto');
    await p.tap(p.page.locator('.picker button', { hasText: 'Mushroom Risotto' }));
    await p.tap(p.page.locator('main button', { hasText: 'Edit' }));

    const stock = p.page.locator('.edit-lines li', { hasText: 'Stock: vegetable' });
    const qty = stock.locator('input');
    expect(await qty.inputValue()).toBe('6');                 // as the recipe reads: cups
    await qty.tap();
    await p.page.keyboard.press('Control+A');
    await p.page.keyboard.type('10', { delay: 30 });
    expect(await qty.inputValue()).toBe('10');                // every key kept
    expect(await p.page.evaluate(() => document.activeElement?.dataset.key)).toBe('edit-qty-2');
    expect(await stock.locator('select option').allTextContents()).toEqual(['mL', 'cup']);

    await p.tap(p.page.locator('main button', { hasText: 'Save' }));
    expect(await p.page.locator('main li', { hasText: 'Stock: vegetable' }).textContent()).toBe('10 cup Stock: vegetable');
    expect(await p.app(() => window.app.library.recipes.get('mushroom-risotto').lines[2]))
      .toMatchObject({ quantity: 10, cookingUnit: 'cup' });
    expect(await p.app(() => window.app.ui.refusals ?? 0)).toBe(0);
    expect(p.errors).toEqual([]);
    await p.close();
  });

  it('a new recipe, typed as a person types — and what cannot be saved is said on the form, not refused', async () => {
    const p = await phone(browser, server.url);
    await p.tab('Recipes');
    await p.tap(p.page.locator('main button', { hasText: 'New recipe' }));
    await p.tap(p.page.locator('main button', { hasText: 'Save' }));
    expect(await p.page.locator('.errors li').allTextContents())
      .toEqual(['The recipe needs a name.', 'Servings must be a whole number of at least 1.']);

    await p.type(p.page.locator('[data-key=edit-name]'), 'Leek tart');
    await p.type(p.page.locator('[data-key=edit-servings]'), '4');
    await p.type(p.page.locator('[data-key=edit-search]'), 'Leek');
    await p.tap(p.page.locator('.picker li', { hasText: /^Leek/ }).first().locator('button'));
    await p.type(p.page.locator('[data-key=edit-qty-0]'), '2');
    await p.type(p.page.locator('[data-key=edit-method]'), 'Slice the leeks.');
    await p.tap(p.page.locator('main button', { hasText: 'Save' }));

    expect(await p.page.locator('main h1').textContent()).toBe('Leek tart');
    expect(await p.page.locator('main li').allTextContents()).toEqual(['2 Leek', 'Slice the leeks.']);
    expect(await p.app(() => window.app.ui.refusals ?? 0)).toBe(0);
    await p.close();
  });

  it('the recipe editor: nothing on an ingredient row sits on top of anything else', async () => {
    const p = await phone(browser, server.url);
    await p.app(() => { window.app.ui.openRecipe = 'mushroom-risotto'; });
    await p.tab('Recipes');
    await p.tap(p.page.locator('main button', { hasText: 'Edit' }));
    const found = await p.page.evaluate(() => {
      const out = [];
      for (const row of document.querySelectorAll('.edit-lines li')) {
        const leaves = [...row.children].map((e) => [e, e.getBoundingClientRect()]);
        for (let i = 0; i < leaves.length; i++) for (let j = i + 1; j < leaves.length; j++) {
          const [a, ra] = leaves[i]; const [b, rb] = leaves[j];
          const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
          const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
          if (w > 2 && h > 2) out.push(`${a.tagName} / ${b.tagName}`);
        }
        if (row.scrollWidth > row.clientWidth + 1) out.push(`${row.textContent} overflows`);
      }
      return out;
    });
    expect(found).toEqual([]);
    await p.close();
  });

  it('#9 — paste the client id, tap Connect once, and you are sent to sign in', async () => {
    const p = await phone(browser, server.url, { hash: '#settings' });
    let signIn = false;
    await p.page.route('https://login.microsoftonline.com/**', (r) => { signIn = true; r.abort(); });
    await p.type(p.page.locator('.field input[type=text]').nth(1), '11111111-2222-3333-4444-555555555555');
    await p.tap(p.page.locator('button', { hasText: 'Connect to OneDrive' }));
    await p.page.waitForTimeout(500);
    expect(signIn).toBe(true);
    await p.close();
  });
});

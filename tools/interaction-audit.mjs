// Interaction audit: how the app behaves under a phone's fingers and keyboard.
//
// Not part of npm test — it needs a browser. Run against a local server:
//
//   python3 -m http.server 8099 &
//   node tools/interaction-audit.mjs            # needs playwright installed
//
// Phone keyboards build each word in stages (IME composition); a box rebuilt
// mid-word loses or doubles letters. Typing whole strings at once, as most
// browser tests do, never shows this — which is how it reached the live app.
// Every line should read "kept", "tap landed", "true", or a scroll of 0 on
// opening a recipe.

import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://localhost:8099/';
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const out = [];
const report = (k, v) => { out.push(k + ': ' + v); };

// Gboard-style: each word is composed, then committed.
async function composeWords(text) {
  for (const word of text.split(/(?<= )/)) {
    let partial = '';
    for (const ch of word.trimEnd()) {
      partial += ch;
      await cdp.send('Input.imeSetComposition', { text: partial, selectionStart: partial.length, selectionEnd: partial.length });
      await page.waitForTimeout(40);
    }
    await cdp.send('Input.insertText', { text: word });
    await page.waitForTimeout(40);
  }
}
const focusedIs = (sel) => page.evaluate((s) => document.activeElement?.matches(s) ?? false, sel);
const replaced = async (fn) => {
  await page.evaluate(() => { window.__el = document.activeElement; });
  await fn();
  return page.evaluate(() => window.__el !== document.activeElement || !document.contains(window.__el));
};

await page.goto(`${BASE}#recipes`);
await page.waitForTimeout(1500);

// 1. Recipe search, typed as a phone keyboard does.
await page.locator('input[type=search]').tap();
const r1 = await replaced(() => composeWords('mushroom risotto'));
report('Recipes search (composed)', JSON.stringify(await page.locator('input[type=search]').inputValue().catch(() => '?')) + (r1 ? '  — input element was REPLACED while typing' : '  — same element kept'));

// 2. Plan search.
await page.goto(`${BASE}#plan`); await page.waitForTimeout(600);
await page.locator('input[type=search]').tap();
const r2 = await replaced(() => composeWords('chicken'));
report('Plan search (composed)', JSON.stringify(await page.locator('input[type=search]').inputValue()) + (r2 ? '  — REPLACED' : '  — kept'));

// 3. Wait search.
await page.goto(`${BASE}#wait`); await page.waitForTimeout(600);
await page.locator('input[type=search]').tap();
const r3 = await replaced(() => composeWords('milk'));
report('Wait search (composed)', JSON.stringify(await page.locator('input[type=search]').inputValue()) + (r3 ? '  — REPLACED' : '  — kept'));

// 4. Open a recipe from far down the list: where does the page land?
await page.goto(`${BASE}#recipes`); await page.waitForTimeout(600);
await page.locator('input[type=search]').fill(''); await page.locator('input[type=search]').dispatchEvent('input');
await page.evaluate(() => document.activeElement.blur()); await page.waitForTimeout(200);
await page.evaluate(() => window.scrollTo(0, 2500)); await page.waitForTimeout(200);
await page.locator('button.link').nth(45).tap(); await page.waitForTimeout(300);
report('Open recipe from list scrolled to 2500', 'lands at scrollY=' + await page.evaluate(() => Math.round(window.scrollY)) + ' (title visible: ' + await page.locator('main h1').isVisible() + ', in viewport: ' + await page.evaluate(() => { const r = document.querySelector('main h1').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }) + ')');
await page.locator('button:has-text("All recipes")').tap(); await page.waitForTimeout(300);
report('Back to list', 'scrollY=' + await page.evaluate(() => Math.round(window.scrollY)));

// 5. A tap that straddles a background redraw: a change from another phone
// arriving between finger down and finger up (every 3 s while shopping).
await page.goto(`${BASE}#plan`); await page.waitForTimeout(600);
await page.locator('input[type=search]').fill('');
await page.evaluate(() => document.activeElement.blur());
const before = await page.locator('ul.chosen li').count();
const box = await page.locator('.picker li button').first().boundingBox();
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + 5, y: box.y + 5 }] });
await page.evaluate(() => window.app.addWaitList(window.app.library.ingredients.keys().next().value));
await page.waitForTimeout(80);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await page.waitForTimeout(500);
report('Plan: tap "Add" while a change arrives', (await page.locator('ul.chosen li').count()) > before ? 'tap landed' : 'TAP LOST');

// 6. Editor: compose an ingredient name then amount.
await page.goto(`${BASE}#recipes`); await page.waitForTimeout(600);
await page.evaluate(() => window.scrollTo(0, 0));
await page.locator('button.link').first().tap(); await page.waitForTimeout(200);
await page.locator('button:has-text("Edit")').tap(); await page.waitForTimeout(200);
await page.locator('button:has-text("+ Add ingredient")').tap(); await page.waitForTimeout(200);
report('Editor: after "+ Add ingredient", focus in new row', await focusedIs('.ing-rows > :last-child input.ing-name'));
await page.locator('.ing-row').last().locator('input.ing-name').tap();
const r6 = await replaced(() => composeWords('Butter'));
report('Editor ingredient name (composed)', JSON.stringify(await page.locator('.ing-row').last().locator('input.ing-name').inputValue()) + (r6 ? '  — REPLACED' : '  — kept'));
await page.locator('textarea').first().tap();
const r7 = await replaced(() => composeWords('Serve hot '));
report('Editor method (composed)', r7 ? 'REPLACED' : 'kept');

console.log(out.join('\n'));
await browser.close();

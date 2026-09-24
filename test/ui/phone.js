// A phone, for the browser suite.
//
// The rule this file exists to enforce: drive the app the way a thumb does.
// Type one key at a time, tap, scroll — never set a whole value in one go.
// Every earlier browser check used Playwright's fill(), which writes the value
// in one step and so hid the fact that every search box lost focus after the
// first key press (glitch #5). The helpers here do not offer fill().

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

/** Serve the repository, as GitHub Pages would. */
export async function serve() {
  const root = process.cwd();
  const server = createServer(async (req, res) => {
    const path = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      const file = path.endsWith('/') ? join(path, 'index.html') : path;
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise((r) => server.close(r)) };
}

export async function launch() { return chromium.launch(); }

/**
 * A fresh phone — its own storage, as a new device would have — with the app
 * open and the household's library loaded.
 */
export async function phone(browser, baseUrl, { width = 375, height = 700, hash = '' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(baseUrl + 'index.html' + hash, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.app?.library.recipes.size > 0, null, { timeout: 20000 });

  const self = {
    page, errors,
    tab: async (name) => { await page.locator('nav button', { hasText: name }).tap(); await page.waitForTimeout(100); },
    /** Type as a person does: tap the box, then one key at a time. */
    type: async (locator, text) => { await locator.tap(); await page.keyboard.type(text, { delay: 30 }); },
    tap: async (locator) => { await locator.tap(); await page.waitForTimeout(80); },
    app: (fn, ...args) => page.evaluate(fn, ...args),
    scrollY: () => page.evaluate(() => Math.round(window.scrollY)),
    close: () => context.close(),
  };
  return self;
}

/** Plan a realistic week from the household's library and lock it. */
export async function shopping(p) {
  await p.app(() => {
    for (const r of ['fish-laksa', 'sicilian-spaghetti', 'cheeseburgers', 'rosemary-garlic-roast-lamb', 'baked-vegie-samosas']) {
      window.app.planRecipe(r, 6);
    }
    window.app.lockShop();
  });
  await p.page.waitForTimeout(200);
}

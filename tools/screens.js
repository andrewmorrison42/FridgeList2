// The screenshot sheet. `npm run screens`
//
// Every screen, in each phase, at two phone widths and in both themes, written
// to screens/ for a person to read. Some glitches no assertion anyone thought
// to write will catch: a CSS class shared by the header and a meal label, text
// running together as "Afghan Biscuitsnever", a printout reading "Marmalade
// 62,500 g". Each of those was found by looking. This makes looking cheap.

import { mkdirSync } from 'node:fs';
import { serve, launch, phone, shopping } from '../test/ui/phone.js';

mkdirSync('screens', { recursive: true });
const server = await serve();
const browser = await launch();
let n = 0;
for (const width of [375, 320]) {
  for (const theme of ['light', 'dark']) {
    const p = await phone(browser, server.url, { width, height: 740 });
    await p.page.emulateMedia({ colorScheme: theme });
    await p.app(() => {
      const ing = [...window.app.library.ingredients.values()];
      window.app.addWaitList(ing.find((i) => i.name === 'Mayonnaise').id);
    });
    const shoot = async (name) => {
      await p.page.screenshot({ path: `screens/${String(++n).padStart(2, '0')}-${name}-${width}-${theme}.png`, fullPage: true });
    };
    for (const tab of ['List', 'Plan', 'Wait', 'Recipes', 'Setup']) { await p.tab(tab); await shoot(`planning-${tab.toLowerCase()}`); }
    await shopping(p);
    for (const tab of ['List', 'Plan', 'Wait']) { await p.tab(tab); await shoot(`shopping-${tab.toLowerCase()}`); }
    await p.page.locator('header button', { hasText: 'Shopping is completed' }).tap();
    await shoot('close-report');
    await p.page.locator('button', { hasText: 'Keep shopping' }).tap();
    await p.tab('List');
    await p.page.emulateMedia({ media: 'print', colorScheme: theme });
    await shoot('print');
    await p.page.emulateMedia({ media: 'screen', colorScheme: theme });

    // The next week: the shop completed, two meals cooked, the rest still to
    // cook. Glitch #15 lived here — every earlier sheet stopped at week one.
    await p.app(async () => {
      const sels = [...window.app.selections.values()].slice(0, 2);
      for (const s of sels) window.app.markCooked(s.recipeId, s.plannedFor);
      await window.app.closeShop();
    });
    for (const tab of ['Plan', 'List']) { await p.tab(tab); await shoot(`next-week-${tab.toLowerCase()}`); }
    await p.close();
  }
}
await browser.close();
await server.close();
console.log(`${n} screenshots in screens/ — read them.`);

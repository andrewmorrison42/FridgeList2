// Standing mutation testing. Review #8.
//
//   npm run mutate            every mutation
//   npm run mutate -- NAME    just one
//
// Each mutation reintroduces a specific defect this codebase has a rule
// against, runs the suite, and requires at least one test to fail. A mutation
// that survives means a rule the documents state is not actually checked.
//
// This exists because the suite twice shipped a test that could not fail — a
// single-shop property whose assertion was true by construction, and an
// addition property that checked a stored register while the list a person
// reads was broken. Both passed for weeks. Checking "the tests can fail" by
// hand found them; this makes it a checked property, the way test/harness.js
// made invariance one.
//
// A mutation whose target text is no longer in the file is reported as STALE
// and fails the run. The code moved; the mutation must move with it, or a rule
// silently stops being checked.

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const MUTATIONS = [
  // -- the guarantee (FR-SYNC-1, §5.3, §5.4) --------------------------------
  { name: 'timestamp-lww',
    rule: 'Ticks resolve causally, never by timestamp (§5.4, §18.3)',
    file: 'src/core/merge.js',
    find: 'export function resolve(events, { trueWins = true } = {}) {',
    replace: 'export function resolve(events, { trueWins = true } = {}) {\n  trueWins = false;' },
  { name: 'causality-by-clock',
    rule: 'Ordering comes from version vectors, never wall clocks (§5.3)',
    file: 'src/core/events.js',
    find: 'return a.seq <= vvGet(b.deps, a.dev);',
    replace: 'return a.ts < b.ts;' },
  { name: 'unknown-type-fatal',
    rule: 'An event type this version does not know is skipped, not fatal (#3)',
    file: 'src/core/merge.js',
    find: 'const k = tryKeyOf(e);',
    replace: 'const k = keyOf(e);' },
  { name: 'key-drift',
    rule: 'A key reads back to exactly what built it (keys.js, #3)',
    file: 'src/core/keys.js',
    find: "['lineDone',           /^line:([^:]+):([^:]+):done$/,       ['shopId', 'ingredientId']],",
    replace: "['lineDone',           /^line:([^:]+):([^:]+):done$/,       ['ingredientId', 'shopId']]," },

  // -- the shop (§5.9, §8.1, FR-SHOP-3) ------------------------------------
  { name: 'open-permits-removal',
    rule: 'The open phase permits no destructive operation (§5.9, FR-SHOP-3)',
    file: 'src/core/events.js',
    find: "'menu.selection':  ['draft'],",
    replace: "'menu.selection':  ['draft', 'open']," },
  { name: 'chain-never-advances',
    rule: 'Closing a shop brings the next into being (§8.1, P7)',
    file: 'src/core/shop.js',
    find: "if (phases.get(id) !== 'closed') return { id, phase: phases.get(id) ?? 'draft' };",
    replace: "return { id, phase: phases.get(id) ?? 'draft' };" },
  { name: 'phase-order-dependent',
    rule: 'Phase does not depend on the order events arrive in (P7, #4)',
    file: 'src/core/shop.js',
    find: "if (what === 'closed' || current !== 'closed') {",
    replace: "if (what === 'locked' || current !== 'closed') {" },
  // -- the menu across weeks (FR-MENU-2..7, §9.1) --------------------------
  { name: 'cooked-sticks-to-recipe',
    rule: 'A selection is (recipe, shop): last week\'s "cooked" does not follow the recipe (glitch #2)',
    file: 'src/core/keys.js',
    find: "case 'menu.cooked':         return K.menuCooked(p.recipeId, p.plannedFor);",
    replace: "case 'menu.cooked':         return K.menuCooked(p.recipeId, 'any');" },
  { name: 'carried-too-late',
    rule: 'Last week\'s uncooked meal is carried during planning, not after (glitch #3)',
    file: 'src/core/carryover.js',
    find: 'if (sel.weeksCarried === 0) return PLANNED;',
    replace: 'if (sel.weeksCarried <= 1) return PLANNED;' },
  { name: 'cooked-lingers',
    rule: 'A meal cooked in an earlier week leaves the menu (glitch #10)',
    file: 'src/core/carryover.js',
    find: 'const onMenu = sel.plannedFor === shopId || !sel.cooked || sel.cookedIn === shopId;',
    replace: 'const onMenu = true;' },
  { name: 'replan-duplicates',
    rule: 'Re-planning a carried meal settles it: one entry, not two (FR-MENU-5)',
    file: 'src/ui/app.js',
    find: 'if (sel.recipeId === recipeId && sel.plannedFor !== id && !sel.cooked) {',
    replace: 'if (false) {' },

  // -- the list (§5.7, §6, FR-SHOP-1, FR-LIST-3) ---------------------------
  { name: 'suppression-ignored',
    rule: 'The pantry check removes a line from the list (FR-LIST-3, #2)',
    file: 'src/core/generate.js',
    find: 'for (const id of flags.suppressed) main.delete(id);',
    replace: 'for (const id of []) main.delete(id);' },
  { name: 'additions-ignored',
    rule: 'A direct addition appears on the list (FR-SHOP-1, #2)',
    file: 'src/core/generate.js',
    find: 'for (const id of flags.added) {',
    replace: 'for (const id of []) {' },
  { name: 'open-shop-rederives',
    rule: 'An open shop serves its locked list; library edits cannot shrink it (§6, #2)',
    file: 'src/core/generate.js',
    find: "if (phase === 'draft') {",
    replace: 'if (true) {' },
  { name: 'lock-replaces',
    rule: 'Concurrent locks are unioned, never one replacing another (#2)',
    file: 'src/core/generate.js',
    find: 'for (const e of reg.by) {',
    replace: 'for (const e of reg.by.slice(-1)) {' },
  { name: 'conversion-throws',
    rule: 'A data problem is reported and the rest of the list renders (#5)',
    file: 'src/core/generate.js',
    find: "      } catch (err) {\n        problems.push({\n          kind: 'missing-conversion',",
    replace: "      } catch (err) {\n        throw err;\n        problems.push({\n          kind: 'missing-conversion'," },

  // -- the migration (§12) --------------------------------------------------
  { name: 'import-double-conversion',
    rule: 'Imported quantities equal the source, converted once (glitch #1)',
    file: 'tools/import.js',
    find: '        cookingUnit: null,',
    replace: '        cookingUnit: line.displayUnit ?? null,' },

  // -- the store and the screen (FR-SYNC-7, §11.1) --------------------------
  { name: 'store-partial-resolve',
    rule: 'The incremental store equals a full merge (#6)',
    file: 'src/core/store.js',
    find: '        dirty.add(key);',
    replace: '        if (groups.get(key).length === 1) dirty.add(key);' },
  { name: 'store-values-only',
    rule: "A register's observable change includes its deciding events (#6)",
    file: 'src/core/store.js',
    find: 'const signatureOf = (r) => JSON.stringify([r.value, r.by.map((e) => e.id).sort()]);',
    replace: 'const signatureOf = (r) => JSON.stringify(r.value);' },

  { name: 'history-ignored',
    rule: 'Imported trip history reaches the picker (FR-REC-4)',
    file: 'src/core/library.js',
    find: 'for (const trip of state.get(K.historyImported())?.value ?? []) {',
    replace: 'for (const trip of []) {' },

  // -- sync (FR-SYNC-2, FR-SYNC-6, §7.4) ------------------------------------
  { name: 'unreadable-swallowed',
    rule: "A peer's unreadable file is reported, never read as healthy (#1)",
    file: 'src/data/sync.js',
    find: 'if (bad > 0) {',
    replace: 'if (false) {' },
  { name: 'local-claims-synced',
    rule: 'A device connected to nothing never says it is synced (glitch #4)',
    file: 'src/data/presence.js',
    find: '  if (syncStatus.shared === false) {',
    replace: '  if (false) {' },
  { name: 'upload-queue-in-memory',
    rule: "A reloaded device uploads its own unconfirmed events (#6)",
    file: 'src/data/sync.js',
    find: 'let unsent = store.events.filter((e) => e.dev === deviceId);',
    replace: 'let unsent = [];' },
  { name: 'writes-another-device',
    rule: 'A device writes only its own files (§4)',
    file: 'src/data/sync.js',
    find: "    ? `shops/${shopId}/log/${deviceId}.jsonl`",
    replace: "    ? `shops/${shopId}/log/shared.jsonl`" },

  // -- the shell (#7) -------------------------------------------------------
  { name: 'shell-missing-module',
    rule: 'Every module is cached for offline use (#7)',
    file: 'sw.js',
    find: " './src/core/keys.js',",
    replace: '' },
];

function runSuite() {
  const r = spawnSync('npx', ['vitest', 'run', '--bail=1', '--reporter=dot'], { encoding: 'utf8' });
  return r.status === 0;
}

const only = process.argv[2];
const chosen = only ? MUTATIONS.filter((m) => m.name === only) : MUTATIONS;
if (only && chosen.length === 0) {
  console.error(`no mutation named "${only}". Known: ${MUTATIONS.map((m) => m.name).join(', ')}`);
  process.exit(2);
}

if (!runSuite()) {
  console.error('The suite fails before any mutation. Fix that first.');
  process.exit(2);
}

const results = [];
for (const m of chosen) {
  const original = readFileSync(m.file, 'utf8');
  const hits = original.split(m.find).length - 1;
  if (hits !== 1) {
    results.push({ ...m, outcome: 'STALE', detail: `target found ${hits} times in ${m.file}` });
    continue;
  }
  let killed;
  try {
    writeFileSync(m.file, original.replace(m.find, m.replace));
    killed = !runSuite();
  } finally {
    writeFileSync(m.file, original);        // always restore, whatever happened
  }
  results.push({ ...m, outcome: killed ? 'killed' : 'SURVIVED' });
  process.stdout.write(killed ? '.' : 'S');
}
process.stdout.write('\n\n');

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.outcome.padEnd(9)} ${r.name.padEnd(width)}  ${r.rule}${r.detail ? `  (${r.detail})` : ''}`);
}
const bad = results.filter((r) => r.outcome !== 'killed');
console.log(`\n${results.length - bad.length}/${results.length} mutations killed.`);
if (bad.length) {
  console.log('A surviving mutation is a rule the documents state and the tests do not check.');
  process.exit(1);
}

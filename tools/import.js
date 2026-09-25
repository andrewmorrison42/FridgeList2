// Checks a recipe file the way the app reads it, and reports everything that
// needed a human. ARCHITECTURE.md §12.
//
// The app reads the household's recipe file directly (src/data/recipes.js), so
// nothing here is shipped to a device. This writes data/import-report.md: what
// the conversion resolved automatically, and what it could not.
//
//   node tools/import.js [recipes-data.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { importLibrary } from '../src/core/recipes-format.js';

export { importLibrary };

export function renderReport(report) {
  const group = (list) => {
    const by = new Map();
    for (const r of list) { if (!by.has(r.kind)) by.set(r.kind, []); by.get(r.kind).push(r); }
    return by;
  };
  let out = `# Import report\n\nGenerated ${new Date().toISOString()}\n\n## Counts\n\n`;
  for (const [k, v] of Object.entries(report.counts)) out += `- ${k}: ${v}\n`;
  out += `\n## Resolved automatically\n\n`;
  for (const [kind, items] of group(report.fixed)) {
    out += `### ${kind} (${items.length})\n\n`;
    for (const i of items.slice(0, 20)) out += `- ${JSON.stringify(i)}\n`;
    if (items.length > 20) out += `- ...and ${items.length - 20} more\n`;
    out += '\n';
  }
  out += `## Needs a human\n\n`;
  const referred = group(report.referred);
  if (referred.size === 0) out += 'Nothing.\n';
  for (const [kind, items] of referred) {
    out += `### ${kind} (${items.length})\n\n`;
    for (const i of items.slice(0, 20)) out += `- ${JSON.stringify(i)}\n`;
    if (items.length > 20) out += `- ...and ${items.length - 20} more\n`;
    out += '\n';
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const src = process.argv[2] ?? 'data/recipes-data.reviewed.json';
  const source = JSON.parse(readFileSync(src, 'utf8'));
  const { report } = importLibrary(source);
  delete report.counts.trips;
  writeFileSync('data/import-report.md', renderReport(report));
  console.log('wrote data/import-report.md');
  console.log(report.counts);
}

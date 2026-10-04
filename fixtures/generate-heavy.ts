// Regenerates fixtures/sites/heavy/index.html. The page is committed; rerun this
// with `pnpm tsx fixtures/generate-heavy.ts` only when the fixture must change.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROWS = 2200;
const LINKS = 800;
const GROUPS = 60;
const ITEMS = 8;

function build(): string {
  const parts: string[] = [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Heavy page</title></head>',
    '<body>',
    '<header><h1>Benchmarks</h1>',
    '<form role="search"><label for="q">Search the catalogue</label><input id="q" name="q" type="search" role="searchbox"></form>',
    '</header><main>',
    '<table id="catalogue"><thead><tr><th>Id</th><th>Name</th><th>Owner</th><th>Status</th><th>Updated</th></tr></thead><tbody>',
  ];
  for (let row = 0; row < ROWS; row += 1) {
    parts.push(
      `<tr><td>${row}</td><td>Record ${row}</td><td>Owner ${row % 50}</td><td>Active</td><td>2026-01-${String((row % 28) + 1).padStart(2, '0')}</td></tr>`,
    );
  }
  parts.push('</tbody></table>', '<section id="lists">');
  for (let group = 0; group < GROUPS; group += 1) {
    parts.push(`<h2>Group ${group}</h2><ul>`);
    for (let item = 0; item < ITEMS; item += 1) {
      parts.push(`<li>Item ${group}.${item}<ul><li>Child A</li><li>Child B</li></ul></li>`);
    }
    parts.push('</ul>');
  }
  parts.push('</section>', '<nav id="links"><ul>');
  for (let link = 0; link < LINKS; link += 1) {
    parts.push(`<li><a href="/heavy/page-${link}">Page ${link}</a></li>`);
  }
  parts.push('</ul></nav>', '</main></body></html>');
  return `${parts.join('\n')}\n`;
}

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sites', 'heavy', 'index.html');
await mkdir(path.dirname(target), { recursive: true });
const html = build();
await writeFile(target, html, 'utf8');
const tags = (html.match(/<[a-zA-Z][^>]*>/g) ?? []).length;
console.log(`wrote ${target} (${tags} tags)`);
if (tags < 15000) throw new Error(`heavy fixture has ${tags} tags, expected >= 15000`);

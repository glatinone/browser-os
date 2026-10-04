import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SITES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sites');

/** The 13 pages P0-04 requires. Keep this list in sync with the task card. */
const PAGES = [
  'basic',
  'spa',
  'iframe',
  'shadow',
  'dynamic',
  'modal',
  'overlay',
  'login',
  'risk',
  'injection',
  'upload',
  'contenteditable',
  'heavy',
];

interface TruthIntent {
  action: string;
  intent: string;
  expect: { css: string; role: string; name: string } | null;
}

describe('fixture pages', () => {
  it('ships exactly the 13 pages the card lists, each with index.html and truth.json', async () => {
    const present = (await readdir(SITES, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(present.sort()).toEqual([...PAGES].sort());
    for (const name of PAGES) {
      const html = await readFile(path.join(SITES, name, 'index.html'), 'utf8');
      expect(html, `${name}/index.html`).toContain('<!doctype html>');
      await expect(readFile(path.join(SITES, name, 'truth.json'), 'utf8')).resolves.toBeTypeOf('string');
    }
  });

  it('has at least 8 intents per page, mixing resolvable and deliberately ambiguous ones', async () => {
    for (const name of PAGES) {
      const truth = JSON.parse(await readFile(path.join(SITES, name, 'truth.json'), 'utf8')) as {
        intents: TruthIntent[];
      };
      expect(truth.intents.length, `${name} intents`).toBeGreaterThanOrEqual(8);
      const ambiguous = truth.intents.filter((i) => i.expect === null).length;
      expect(ambiguous, `${name} needs ambiguity cases`).toBeGreaterThanOrEqual(1);
      expect(ambiguous, `${name} needs resolvable cases`).toBeLessThan(truth.intents.length);
    }
  });

  it('gives every non-null expectation a css, role and name (integration §12)', async () => {
    for (const name of PAGES) {
      const truth = JSON.parse(await readFile(path.join(SITES, name, 'truth.json'), 'utf8')) as {
        intents: TruthIntent[];
      };
      for (const entry of truth.intents) {
        expect(entry.action, `${name}: ${entry.intent}`).toMatch(/^(click|fill|select|upload)$/);
        expect(entry.intent.length, `${name} intent text`).toBeGreaterThan(0);
        if (entry.expect !== null) {
          expect(entry.expect.css, `${name}: ${entry.intent}`).toBeTruthy();
          expect(entry.expect.role, `${name}: ${entry.intent}`).toBeTruthy();
          expect(entry.expect.name, `${name}: ${entry.intent}`).toBeTruthy();
        }
      }
    }
  });
});

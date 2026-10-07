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

/**
 * Fixture groups beside the 13 pages. Each holds its own structure rather than
 * a single `index.html`, so it is declared here and validated separately below.
 */
const GROUPS = ['mutations'];

/** P4-12: one base page plus a directory per mutation case. */
const MUTATION_CASES = [
  'class-changed',
  'sibling-reversed',
  'wrappers',
  'badge-count',
  'unstable-ids',
  'text-case',
  'moved-container',
  'target-removed',
];

interface TruthIntent {
  action: string;
  intent: string;
  expect: { css: string; role: string; name: string } | null;
}

describe('fixture pages', () => {
  it('ships exactly the 13 pages the card lists, each with index.html and truth.json', async () => {
    const present = (await readdir(SITES, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    expect(present.sort()).toEqual([...PAGES, ...GROUPS].sort());
    for (const name of PAGES) {
      const html = await readFile(path.join(SITES, name, 'index.html'), 'utf8');
      expect(html, `${name}/index.html`).toContain('<!doctype html>');
      await expect(readFile(path.join(SITES, name, 'truth.json'), 'utf8')).resolves.toBeTypeOf('string');
    }
  });

  it('ships the P4-12 mutation group: a base page, one directory per case, and its truth file', async () => {
    await expect(readFile(path.join(SITES, 'mutations', 'base.html'), 'utf8')).resolves.toContain('<!doctype html>');

    const present = (await readdir(path.join(SITES, 'mutations'), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    expect(present.sort()).toEqual([...MUTATION_CASES].sort());

    for (const name of MUTATION_CASES) {
      const html = await readFile(path.join(SITES, 'mutations', name, 'index.html'), 'utf8');
      expect(html, `mutations/${name}/index.html`).toContain('<!doctype html>');
    }

    const truth = JSON.parse(await readFile(path.join(SITES, 'mutations', 'truth.json'), 'utf8')) as {
      matchAccept: number;
      matchMargin: number;
      cases: Array<{ name: string; positive: boolean; base: unknown; mutated: unknown }>;
    };
    expect(truth.matchAccept).toBeGreaterThan(0);
    expect(truth.matchMargin).toBeGreaterThan(0);
    expect(truth.cases.map((c) => c.name).sort()).toEqual([...MUTATION_CASES].sort());
    expect(truth.cases.filter((c) => c.positive)).toHaveLength(7);
    expect(truth.cases.filter((c) => !c.positive)).toHaveLength(1);
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

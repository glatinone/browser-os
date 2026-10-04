import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HEAVY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'sites', 'heavy', 'index.html');

describe('heavy fixture', () => {
  it('has at least 15k DOM nodes so L7/L16 benchmarks mean something', async () => {
    const html = await readFile(HEAVY, 'utf8');
    const tags = html.match(/<[a-zA-Z][^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThanOrEqual(15000);
  });
});

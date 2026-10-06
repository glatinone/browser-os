import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import { buildObservation } from '../src/semantic.js';
import { estimateTokens, serializeLines } from '../src/serialize.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const GOLDENS: Array<{ name: string; url: string; title: string }> = [
  { name: 'basic', url: 'http://127.0.0.1/basic/', title: 'Basic form page' },
  { name: 'contenteditable', url: 'http://127.0.0.1/contenteditable/', title: 'Editor' },
  { name: 'dynamic', url: 'http://127.0.0.1/dynamic/', title: 'Dynamic page' },
  { name: 'iframe', url: 'http://127.0.0.1/iframe/', title: 'Frame page' },
  { name: 'injection', url: 'http://127.0.0.1/injection/', title: 'Search' },
  { name: 'login', url: 'http://127.0.0.1/login/', title: 'Sign in' },
  { name: 'modal', url: 'http://127.0.0.1/modal/', title: 'Modal page' },
  { name: 'overlay', url: 'http://127.0.0.1/overlay/', title: 'Overlay page' },
  { name: 'risk', url: 'http://127.0.0.1/risk/', title: 'Account actions' },
  { name: 'shadow', url: 'http://127.0.0.1/shadow/', title: 'Shadow DOM' },
  { name: 'spa', url: 'http://127.0.0.1/spa/', title: 'People directory' },
  { name: 'upload', url: 'http://127.0.0.1/upload/', title: 'Upload' },
];

async function load(name: string): Promise<RawCapture> {
  return JSON.parse(await readFile(path.join(fixtures, `${name}.raw.json`), 'utf8')) as RawCapture;
}

describe('observation goldens', () => {
  for (const golden of GOLDENS) {
    it(`${golden.name} serializes to its golden file`, async () => {
      const { observation } = buildObservation(await load(golden.name), {
        url: golden.url,
        title: golden.title,
        sessionId: 'session-golden',
        pageId: 'page-golden',
        capturedAt: 123,
        includeText: true,
      });
      const normalized = {
        ...observation,
        id: 'obs_golden',
        sessionId: 'session-golden',
        pageId: 'page-golden',
        capturedAt: 123,
        stats: { ...observation.stats, buildMs: 0, captureMs: 0 },
      };
      await expect(serializeLines(normalized)).toMatchFileSnapshot(`./fixtures/${golden.name}.observation.txt`);
      expect(observation.stats.estTokens).toBe(estimateTokens(serializeLines(observation)));
    });
  }

  it('basic golden contains the icon button and the disabled button', async () => {
    const { observation } = buildObservation(await load('basic'), {
      url: 'http://127.0.0.1/basic/',
      title: 'Basic form page',
      capturedAt: 123,
      includeText: true,
    });
    const lines = serializeLines({ ...observation });
    expect(lines).toContain('button "Settings"');
    expect(lines).toContain('(disabled)');
  });
});

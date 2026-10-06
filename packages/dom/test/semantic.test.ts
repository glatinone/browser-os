import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import { buildObservation } from '../src/semantic.js';
import { serializeLines } from '../src/serialize.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function load(name: string): Promise<RawCapture> {
  return JSON.parse(await readFile(path.join(fixtures, `${name}.raw.json`), 'utf8')) as RawCapture;
}

describe('semantic observation goldens', () => {
  it('emits the stable interactive contract for the recorded basic page', async () => {
    const result = buildObservation(await load('basic'), {
      url: 'http://127.0.0.1/basic/',
      title: 'Basic form',
      sessionId: 'session-test',
      pageId: 'page-test',
      capturedAt: 123,
      includeText: true,
    });
    const { observation, index } = result;
    expect(observation.id).toMatch(/^obs_/);
    expect(observation.sessionId).toBe('session-test');
    expect(observation.pageId).toBe('page-test');
    expect(observation.capturedAt).toBe(123);
    expect(observation.challenge).toBeNull();
    expect(observation.elements.length).toBeGreaterThanOrEqual(8);
    expect(observation.elements.map((element) => element.ref)).toEqual(
      observation.elements.map((_, index) => `e${index + 1}`),
    );
    expect(observation.elements.some((element) => element.role === 'combobox' && element.name === 'Country')).toBe(
      true,
    );
    expect(
      observation.elements.some((element) => element.role === 'checkbox' && element.name.includes('newsletter')),
    ).toBe(true);
    expect(observation.elements.some((element) => element.role === 'radio' && element.name === 'Yearly')).toBe(true);
    expect(observation.text.length).toBeGreaterThan(0);
    expect(observation.stats.elements).toBe(observation.elements.length);
    expect(index.entries.size).toBe(observation.elements.length);
    for (const ref of observation.elements.map((element) => element.ref)) {
      expect(index.entries.has(ref)).toBe(true);
    }
  });

  it('masks sensitive values and keeps serializer output deterministic', async () => {
    const raw = await load('basic');
    const first = buildObservation(raw, { url: 'http://127.0.0.1/basic/' }).observation;
    const second = buildObservation(raw, { url: 'http://127.0.0.1/basic/' }).observation;
    const firstLines = serializeLines(first);
    const secondLines = serializeLines(second);
    expect(firstLines).toBe(secondLines);
    expect(firstLines).not.toContain('password123');
    expect(firstLines).not.toContain('secret');
    expect(firstLines).toContain('url: http://127.0.0.1/basic/');
    expect(firstLines).toContain('dialogs: none');
    expect(firstLines).toContain('combobox');
  });
});

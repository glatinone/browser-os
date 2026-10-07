import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import { joinRawCapture } from '../src/join.js';
import { applyParamsToLocator, buildLocator, matchLocator, verifyIdentity } from '../src/locator.js';
import { buildObservation } from '../src/semantic.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(dir, 'fixtures');

const FIXTURES = [
  'basic',
  'contenteditable',
  'dynamic',
  'iframe',
  'injection',
  'login',
  'modal',
  'overlay',
  'risk',
  'shadow',
  'spa',
  'upload',
];

describe('locator utilities', () => {
  it('buildLocator constructs an ElementLocator with stable attrs and cssPath', () => {
    const raw = JSON.parse(readFileSync(path.join(fixturesDir, 'basic.raw.json'), 'utf8')) as RawCapture;
    const { observation } = buildObservation(raw, {
      url: 'http://127.0.0.1/basic/',
      title: 'Basic form page',
      sessionId: 'test',
      pageId: 'test',
      capturedAt: 12345,
    });

    const el = observation.elements[0];
    expect(el).toBeDefined();
    if (el) {
      const table = joinRawCapture(raw);
      const loc = buildLocator(table, 0, el, observation);
      expect(loc.v).toBe(1);
      expect(loc.role).toBe(el.role);
      expect(loc.name).toBe(el.name);
    }
  });

  it('applyParamsToLocator handles dynamic task parameter replacement', () => {
    const loc = {
      v: 1 as const,
      role: 'button',
      name: 'Welcome, Alice!',
      nameIsDynamic: false,
      tag: 'button',
      attrs: {},
      context: [],
      cssPath: '#btn',
      framePath: [],
      ordinal: 0,
    };

    const applied = applyParamsToLocator(loc, { username: 'alice' });
    expect(applied.nameIsDynamic).toBe(true);
    expect(applied.name).toBe('');

    const unchanged = applyParamsToLocator(loc, { username: 'bob' });
    expect(unchanged.nameIsDynamic).toBe(false);
    expect(unchanged.name).toBe('Welcome, Alice!');
  });

  it('verifyIdentity scores probe candidates accurately', () => {
    const loc = {
      v: 1 as const,
      role: 'textbox',
      name: 'Email address',
      nameIsDynamic: false,
      tag: 'input',
      attrs: { id: 'email', 'data-testid': 'email-input' },
      context: [],
      cssPath: '#email',
      framePath: [],
      ordinal: 0,
    };

    const candGood = {
      backendNodeId: 10,
      role: 'textbox',
      name: 'Email address',
      rect: { x: 0, y: 0, w: 100, h: 20 },
      attrs: { id: 'email', 'data-testid': 'email-input' },
    };

    const candBad = {
      backendNodeId: 11,
      role: 'button',
      name: 'Submit',
      rect: { x: 0, y: 0, w: 100, h: 20 },
      attrs: { id: 'btn' },
    };

    const goodScore = verifyIdentity(candGood, loc);
    const badScore = verifyIdentity(candBad, loc);

    expect(goodScore).toBe(1.0);
    expect(badScore).toBeLessThan(0.5);
  });
});

describe('locator round-trip across all golden fixtures', () => {
  for (const name of FIXTURES) {
    it(`correctly round-trips every element on ${name} fixture`, () => {
      const raw = JSON.parse(readFileSync(path.join(fixturesDir, `${name}.raw.json`), 'utf8')) as RawCapture;
      const { observation, index } = buildObservation(raw, {
        url: `http://127.0.0.1/${name}/`,
        title: name,
        sessionId: 'roundtrip',
        pageId: 'roundtrip',
        capturedAt: 12345,
      });

      expect(observation.elements.length).toBeGreaterThan(0);

      for (const element of observation.elements) {
        const entry = index.entries.get(element.ref);
        expect(entry).toBeDefined();
        if (!entry) continue;

        const matches = matchLocator(observation, index, entry.locator);
        expect(matches.length).toBeGreaterThan(0);

        const best = matches[0];
        expect(best?.ref).toBe(element.ref);

        if (matches.length > 1) {
          const runnerUp = matches[1];
          const margin = (best?.score ?? 0) - (runnerUp?.score ?? 0);
          expect(margin).toBeGreaterThanOrEqual(0.1);
        }
      }
    });
  }
});

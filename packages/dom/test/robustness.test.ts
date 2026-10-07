import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import { matchLocator } from '../src/locator.js';
import { buildObservation } from '../src/semantic.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '..', '..', '..');
const capturesDir = path.join(dir, 'fixtures', 'mutations');

interface Target {
  role: string;
  name: string;
}

interface Truth {
  matchAccept: number;
  matchMargin: number;
  cases: Array<{
    name: string;
    positive: boolean;
    base: Target;
    mutated: Target | null;
  }>;
}

const truth = JSON.parse(
  readFileSync(path.join(repoRoot, 'fixtures', 'sites', 'mutations', 'truth.json'), 'utf8'),
) as Truth;

function load(capture: string) {
  const raw = JSON.parse(readFileSync(path.join(capturesDir, capture), 'utf8')) as RawCapture;
  return buildObservation(raw, {
    url: 'http://127.0.0.1/mutations/',
    title: 'Mutation base',
    sessionId: 'p4-12',
    pageId: 'p4-12',
    capturedAt: 12345,
  });
}

function findByRoleName(observation: Observation, target: Target) {
  return observation.elements.find((el) => el.role === target.role && el.name === target.name);
}

const base = load('base.html.raw.json');

function locatorForBaseTarget(caseName: string, target: Target) {
  const baseTarget = findByRoleName(base.observation, target);
  if (!baseTarget) throw new Error(`base target not found for ${caseName}`);
  const entry = base.index.entries.get(baseTarget.ref);
  if (!entry) throw new Error(`no index entry for base target in ${caseName}`);
  return entry.locator;
}

describe('locator robustness under real DOM mutations (P4-12)', () => {
  const positives = truth.cases.filter((testCase) => testCase.positive);
  const negative = truth.cases.find((testCase) => !testCase.positive);

  it('the fixture set matches the card: 7 positive pairs plus 1 negative', () => {
    expect(truth.cases.length).toBe(8);
    expect(positives.length).toBe(7);
    expect(negative).toBeDefined();
    expect(findByRoleName(base.observation, truth.cases[0].base)).toBeDefined();
  });

  for (const testCase of positives) {
    it(`keeps the target first with margin >= ${truth.matchMargin} when ${testCase.name}`, () => {
      const locator = locatorForBaseTarget(testCase.name, testCase.base);
      const mutated = load(`${testCase.name}.raw.json`);

      if (!testCase.mutated) {
        throw new Error(`${testCase.name} is positive but declares no mutated target`);
      }
      const mutatedTarget = findByRoleName(mutated.observation, testCase.mutated);
      if (!mutatedTarget) throw new Error(`mutated target not found in ${testCase.name}`);

      const matches = matchLocator(mutated.observation, mutated.index, locator);
      const best = matches[0];
      expect(best?.ref).toBe(mutatedTarget.ref);
      expect(best?.score ?? 0).toBeGreaterThanOrEqual(truth.matchAccept);

      if (matches.length > 1) {
        const runnerUp = matches[1];
        expect((best?.score ?? 0) - (runnerUp?.score ?? 0)).toBeGreaterThanOrEqual(truth.matchMargin);
      }
    });
  }

  it(`rejects every candidate above ${truth.matchAccept} when the target is removed`, () => {
    if (!negative) throw new Error('truth.json declares no negative case');
    const locator = locatorForBaseTarget(negative.name, negative.base);
    const mutated = load(`${negative.name}.raw.json`);

    // The element really is gone, so the rejection below is meaningful.
    expect(findByRoleName(mutated.observation, negative.base)).toBeUndefined();

    const matches = matchLocator(mutated.observation, mutated.index, locator);
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.score).toBeLessThan(truth.matchAccept);
    }
  });
});

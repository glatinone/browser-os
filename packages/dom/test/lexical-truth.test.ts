import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import { lexicalDecision, lexicalRank } from '../src/lexical.js';
import { buildObservation } from '../src/semantic.js';

interface TruthExpect {
  css?: string;
  role: string;
  name: string;
}

interface TruthIntent {
  action: string;
  intent: string;
  expect: TruthExpect | null;
}

interface TruthData {
  intents: TruthIntent[];
}

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '../../..');
const fixturesDir = path.join(dir, 'fixtures');
const sitesDir = path.join(repoRoot, 'fixtures', 'sites');

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

describe('lexical truth evaluation', () => {
  it('achieves >= 99% precision across all truth fixtures with default constants', () => {
    let totalAccepted = 0;
    let totalCorrect = 0;
    let totalExpectNonNull = 0;
    const fixtureStats: Array<{ name: string; accepted: number; total: number; coverage: string; precision: string }> =
      [];

    for (const name of FIXTURES) {
      const truthPath = path.join(sitesDir, name, 'truth.json');
      const rawPath = path.join(fixturesDir, `${name}.raw.json`);
      const truthMapPath = path.join(fixturesDir, `${name}.truth-map.json`);

      if (!existsSync(truthPath) || !existsSync(rawPath)) continue;

      const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as TruthData;
      const raw = JSON.parse(readFileSync(rawPath, 'utf8')) as RawCapture;
      const truthMap: Record<string, number | null> = existsSync(truthMapPath)
        ? (JSON.parse(readFileSync(truthMapPath, 'utf8')) as Record<string, number | null>)
        : {};

      const { observation, index } = buildObservation(raw, {
        url: `http://127.0.0.1/${name}/`,
        title: name,
        sessionId: 'truth-session',
        pageId: 'truth-page',
        capturedAt: 12345,
      });

      let fAccepted = 0;
      let fCorrect = 0;
      let fExpectNonNull = 0;

      for (const item of truth.intents) {
        if (item.expect !== null) fExpectNonNull += 1;

        const ranked = lexicalRank(observation.elements, item.intent, item.action);
        const decision = lexicalDecision(ranked);

        if ('element' in decision) {
          fAccepted += 1;
          // expect: null intents must not be accepted
          expect(item.expect).not.toBeNull();

          if (item.expect !== null) {
            const entry = index.entries.get(decision.element.ref);
            const expectedBackendId = item.expect.css ? (truthMap[item.expect.css] ?? null) : null;
            let matched = false;

            if (expectedBackendId !== null && entry && entry.backendNodeId === expectedBackendId) {
              matched = true;
            } else if (decision.element.role === item.expect.role && decision.element.name === item.expect.name) {
              matched = true;
            }

            if (matched) {
              fCorrect += 1;
            }
          }
        }
      }

      totalAccepted += fAccepted;
      totalCorrect += fCorrect;
      totalExpectNonNull += fExpectNonNull;

      const prec = fAccepted > 0 ? ((fCorrect / fAccepted) * 100).toFixed(1) : '100.0';
      const cov = fExpectNonNull > 0 ? ((fAccepted / fExpectNonNull) * 100).toFixed(1) : '0.0';
      fixtureStats.push({
        name,
        accepted: fAccepted,
        total: fExpectNonNull,
        coverage: `${cov}%`,
        precision: `${prec}%`,
      });
    }

    console.table(fixtureStats);

    const overallPrecision = totalAccepted > 0 ? totalCorrect / totalAccepted : 1;
    const overallCoverage = totalExpectNonNull > 0 ? totalAccepted / totalExpectNonNull : 0;

    console.log(
      `Overall Truth: accepted=${totalAccepted}/${totalExpectNonNull} (${(overallCoverage * 100).toFixed(1)}% coverage), precision=${(overallPrecision * 100).toFixed(1)}% (${totalCorrect}/${totalAccepted})`,
    );

    expect(overallPrecision).toBeGreaterThanOrEqual(0.99);
  });
});

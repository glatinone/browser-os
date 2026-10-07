import { buildObservation, captureRaw, normalizeName } from '@browser-os/dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchTestBrowser, type TestBrowser, withFixtureServer } from '../helpers/index.js';

let browser: TestBrowser;

beforeAll(async () => {
  browser = await launchTestBrowser();
}, 30000);

afterAll(async () => {
  await browser.dispose();
}, 30000);

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

interface AriaNode {
  role: string;
  name: string;
}

function parseAriaSnapshot(snapshot: string): AriaNode[] {
  const nodes: AriaNode[] = [];
  const lines = snapshot.split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*-\s+([a-zA-Z0-9_-]+)(?:\s+"([^"]*)")?/);
    if (match) {
      const role = match[1]?.toLowerCase() ?? '';
      const name = match[2] ?? '';
      nodes.push({ role, name });
    }
  }
  return nodes;
}

describe('Playwright ariaSnapshot oracle test', () => {
  for (const fixture of FIXTURES) {
    it(`evaluates role+name agreement against Playwright ariaSnapshot on ${fixture}`, async () => {
      await withFixtureServer(async (server) => {
        const handle = await browser.handle().newPage();
        try {
          const driver = handle.driver();
          await driver.navigate(`${server.baseUrl}/${fixture}/`, 15000);
          await driver.settle(100, 5000);

          const raw = (handle as { raw?: () => { ariaSnapshot?: (opts?: unknown) => Promise<string> } }).raw?.();
          if (typeof raw?.ariaSnapshot !== 'function') {
            console.log('Skipping: page.ariaSnapshot is not available');
            return;
          }

          let snapshot = '';
          try {
            snapshot = await raw.ariaSnapshot({ mode: 'ai' });
          } catch (err: unknown) {
            console.log(`Skipping: ariaSnapshot failed on ${fixture}:`, err);
            return;
          }

          const ariaNodes = parseAriaSnapshot(snapshot);
          const cdp = await handle.cdp();
          const capture = await captureRaw(cdp);
          const { observation } = buildObservation(capture, {
            url: `${server.baseUrl}/${fixture}/`,
            title: fixture,
          });

          let matchedCount = 0;
          const totalInteractive = observation.elements.length;

          for (const el of observation.elements) {
            const elNameN = normalizeName(el.name);
            const found = ariaNodes.some((node) => {
              const nodeNameN = normalizeName(node.name);
              const roleMatch =
                node.role === el.role ||
                (node.role === 'textbox' && el.role === 'searchbox') ||
                (node.role === 'combobox' && el.role === 'searchbox');
              return roleMatch && (node.name === el.name || (elNameN !== '' && nodeNameN === elNameN));
            });

            if (found) {
              matchedCount += 1;
            }
          }

          const agreement = totalInteractive > 0 ? (matchedCount / totalInteractive) * 100 : 100;
          console.log(
            `Oracle ${fixture.padEnd(16)}: agreement=${agreement.toFixed(1)}% (${matchedCount}/${totalInteractive} interactive elements matched)`,
          );

          expect(agreement).toBeGreaterThanOrEqual(95);
        } finally {
          await handle.close();
        }
      });
    }, 30000);
  }
});

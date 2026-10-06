import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRaw } from '../packages/dom/src/capture.ts';
import { withFixtureServer } from '../tests/helpers/index.js';
import { launchTestBrowser } from '../tests/helpers/launch-test-browser.js';

const [, , fixtureName, ...args] = process.argv;
if (!fixtureName) throw new Error('usage: pnpm tsx scripts/record-capture.ts <fixtureName> [--variant v]');
const variantIndex = args.indexOf('--variant');
const variant = variantIndex >= 0 ? args[variantIndex + 1] : undefined;

await withFixtureServer(async (server) => {
  const browser = await launchTestBrowser({ name: `capture-${fixtureName}`, channel: 'chrome' });
  try {
    const page = browser.handle().pages()[0];
    const driver = page.driver();
    const navigation = await driver.navigate(`${server.baseUrl}/${fixtureName}/`, 20_000);
    if (!navigation.ok) throw new Error(`fixture navigation failed: ${navigation.error?.message ?? 'unknown error'}`);
    await driver.settle(100, 5_000);
    const raw = await captureRaw(await page.cdp());
    const outputDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'packages',
      'dom',
      'test',
      'fixtures',
    );
    await mkdir(outputDir, { recursive: true });
    const suffix = variant ? `.${variant}` : '';
    await writeFile(
      path.join(outputDir, `${fixtureName}${suffix}.raw.json`),
      `${JSON.stringify({ _chromeVersion: null, ...raw }, null, 2)}\n`,
    );
    console.log(`recorded ${fixtureName}${suffix}.raw.json`);
  } finally {
    await browser.dispose();
  }
});

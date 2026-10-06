import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureRaw } from '../packages/dom/src/capture.ts';
import { withFixtureServer } from '../tests/helpers/index.js';
import { launchTestBrowser } from '../tests/helpers/launch-test-browser.js';

const [, , fixtureName, ...args] = process.argv;
if (!fixtureName) throw new Error('usage: pnpm tsx scripts/record-capture.ts <fixtureName> [--variant v]');
const variantIndex = args.indexOf('--variant');
const variant = variantIndex >= 0 ? args[variantIndex + 1] : undefined;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function writeTruthMap(
  _server: { baseUrl: string },
  page: { cdp(): unknown },
  name: string,
  suffix: string,
): Promise<void> {
  const truthPath = path.join(repoRoot, 'fixtures', 'sites', name, 'truth.json');
  let intents: Array<{ expect?: { css?: string } }>;
  try {
    intents = JSON.parse(await readFile(truthPath, 'utf8')).intents ?? [];
  } catch {
    return;
  }
  if (intents.length === 0) return;
  const cdp = page.cdp() as { send(method: string, params?: unknown): Promise<Record<string, unknown>> };
  const doc = await cdp.send('DOM.getDocument', { depth: 0 });
  const rootNodeId = (doc.root as { nodeId?: number } | undefined)?.nodeId;
  const map: Record<string, number | null> = {};
  for (const entry of intents) {
    const css = entry.expect?.css;
    if (!css || rootNodeId === undefined) {
      if (css) map[css] = null;
      continue;
    }
    try {
      const query = await cdp.send('DOM.querySelector', { nodeId: rootNodeId, selector: css });
      const nodeId = (query.nodeId as number | undefined) ?? 0;
      if (nodeId === 0) {
        map[css] = null;
      } else {
        const desc = await cdp.send('DOM.describeNode', { nodeId });
        map[css] = (desc.node as { backendNodeId?: number } | undefined)?.backendNodeId ?? null;
      }
    } catch {
      map[css] = null;
    }
  }
  const outputDir = path.join(repoRoot, 'packages', 'dom', 'test', 'fixtures');
  await writeFile(path.join(outputDir, `${name}${suffix}.truth-map.json`), `${JSON.stringify(map, null, 2)}\n`);
  console.log(
    `truth-map ${name}${suffix}: ${Object.values(map).filter((v) => v !== null).length}/${Object.keys(map).length} selectors mapped`,
  );
}

await withFixtureServer(async (server) => {
  const browser = await launchTestBrowser({ name: `capture-${fixtureName}`, channel: 'chrome' });
  try {
    const page = browser.handle().pages()[0];
    const driver = page.driver();
    const navigation = await driver.navigate(`${server.baseUrl}/${fixtureName}/`, 20_000);
    if (!navigation.ok) throw new Error(`fixture navigation failed: ${navigation.error?.message ?? 'unknown error'}`);
    await driver.settle(100, 5_000);
    const cdp = await page.cdp();
    const raw = await captureRaw(cdp);
    const outputDir = path.join(repoRoot, 'packages', 'dom', 'test', 'fixtures');
    await mkdir(outputDir, { recursive: true });
    const suffix = variant ? `.${variant}` : '';
    const pageWithCdp = { cdp: () => cdp };
    await writeTruthMap(server, pageWithCdp, fixtureName, suffix);
    await writeFile(
      path.join(outputDir, `${fixtureName}${suffix}.raw.json`),
      `${JSON.stringify({ _chromeVersion: null, ...raw }, null, 2)}\n`,
    );
    console.log(`recorded ${fixtureName}${suffix}.raw.json`);
  } finally {
    await browser.dispose();
  }
});

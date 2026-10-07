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
  const doc = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  function collectDocNodeIds(node: unknown, list: number[] = []): number[] {
    if (!node || typeof node !== 'object') return list;
    const n = node as {
      nodeId?: number;
      nodeType?: number;
      children?: unknown[];
      contentDocument?: unknown;
      shadowRoots?: unknown[];
    };
    if (typeof n.nodeId === 'number' && (n.nodeType === 9 || n.nodeType === 11)) {
      list.push(n.nodeId);
    }
    if (n.contentDocument) collectDocNodeIds(n.contentDocument, list);
    if (Array.isArray(n.children)) {
      for (const child of n.children) collectDocNodeIds(child, list);
    }
    if (Array.isArray(n.shadowRoots)) {
      for (const sr of n.shadowRoots) collectDocNodeIds(sr, list);
    }
    return list;
  }
  const rootNode = doc.root as { nodeId?: number } | undefined;
  const docNodeIds = collectDocNodeIds(doc.root);
  if (rootNode?.nodeId !== undefined && !docNodeIds.includes(rootNode.nodeId)) {
    docNodeIds.unshift(rootNode.nodeId);
  }
  const map: Record<string, number | null> = {};
  for (const entry of intents) {
    const css = entry.expect?.css;
    if (!css || docNodeIds.length === 0) {
      if (css) map[css] = null;
      continue;
    }
    let foundNodeId = 0;
    for (const docId of docNodeIds) {
      try {
        const query = await cdp.send('DOM.querySelector', { nodeId: docId, selector: css });
        const nid = (query.nodeId as number | undefined) ?? 0;
        if (nid !== 0) {
          foundNodeId = nid;
          break;
        }
      } catch {
        // continue trying other documents
      }
    }
    if (foundNodeId === 0) {
      map[css] = null;
    } else {
      try {
        const desc = await cdp.send('DOM.describeNode', { nodeId: foundNodeId });
        map[css] = (desc.node as { backendNodeId?: number } | undefined)?.backendNodeId ?? null;
      } catch {
        map[css] = null;
      }
    }
  }
  const outputDir = path.join(repoRoot, 'packages', 'dom', 'test', 'fixtures');
  await mkdir(path.dirname(path.join(outputDir, `${name}${suffix}.truth-map.json`)), {
    recursive: true,
  });
  await writeFile(path.join(outputDir, `${name}${suffix}.truth-map.json`), `${JSON.stringify(map, null, 2)}\n`);
  console.log(
    `truth-map ${name}${suffix}: ${Object.values(map).filter((v) => v !== null).length}/${Object.keys(map).length} selectors mapped`,
  );
}

await withFixtureServer(async (server) => {
  // Fixture names may be nested paths ("mutations/base.html"), which are not
  // legal profile names: flatten them to a valid, length-bounded slug.
  const profileName = `capture-${fixtureName}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, 31)
    .replace(/-$/, '');
  const browser = await launchTestBrowser({ name: profileName, channel: 'chrome' });
  try {
    const page = browser.handle().pages()[0];
    const driver = page.driver();
    const navigation = await driver.navigate(
      `${server.baseUrl}/${fixtureName.endsWith('.html') ? fixtureName : `${fixtureName}/`}`,
      20_000,
    );
    if (!navigation.ok) throw new Error(`fixture navigation failed: ${navigation.error?.message ?? 'unknown error'}`);
    await driver.settle(100, 5_000);
    const cdp = await page.cdp();
    const raw = await captureRaw(cdp);
    const outputDir = path.join(repoRoot, 'packages', 'dom', 'test', 'fixtures');
    const suffix = variant ? `.${variant}` : '';
    const rawPath = path.join(outputDir, `${fixtureName}${suffix}.raw.json`);
    await mkdir(path.dirname(rawPath), { recursive: true });
    const pageWithCdp = { cdp: () => cdp };
    await writeTruthMap(server, pageWithCdp, fixtureName, suffix);
    await writeFile(rawPath, `${JSON.stringify({ _chromeVersion: null, ...raw }, null, 2)}\n`);
    console.log(`recorded ${fixtureName}${suffix}.raw.json`);
  } finally {
    await browser.dispose();
  }
});

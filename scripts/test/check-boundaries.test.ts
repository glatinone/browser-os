import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBoundaries } from '../check-boundaries.mjs';

const roots = [];

/** Builds a throwaway `packages/*` tree. `deps` are dependency names, `src` are files under src/. */
async function makeTree(spec) {
  const root = await mkdtemp(path.join(tmpdir(), 'bos-boundaries-'));
  roots.push(root);
  for (const [name, def] of Object.entries(spec)) {
    const pkgDir = path.join(root, 'packages', name);
    await mkdir(path.join(pkgDir, 'src'), { recursive: true });
    const dependencies = {};
    for (const dep of def.deps ?? []) {
      dependencies[dep] = dep.startsWith('@browser-os/') ? 'workspace:*' : '^1.0.0';
    }
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: `@browser-os/${name}`, version: '0.0.0', type: 'module', dependencies }, null, 2),
    );
    for (const [file, content] of Object.entries(def.src ?? {})) {
      await writeFile(path.join(pkgDir, 'src', file), content);
    }
  }
  return root;
}

function messages(violations) {
  return violations.map((v) => v.message);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('checkBoundaries', () => {
  it('accepts a clean tree', async () => {
    const root = await makeTree({
      protocol: { src: { 'index.ts': 'export const a = 1;\n' } },
      dom: {
        deps: ['@browser-os/protocol'],
        src: { 'index.ts': "import { a } from '@browser-os/protocol';\nexport{a};\n" },
      },
    });
    expect(checkBoundaries(root)).toEqual([]);
  });

  it('rejects an external dependency that is not approved for the package', async () => {
    const root = await makeTree({
      dom: {
        deps: ['playwright-core'],
        src: { 'a.ts': "import { chromium } from 'playwright-core';\nexport{chromium};\n" },
      },
    });
    const violations = checkBoundaries(root);
    expect(messages(violations)).toContain("packages/dom/src/a.ts: imports 'playwright-core' (not allowed in dom)");
    expect(messages(violations)).toContain(
      "packages/dom/package.json: declares dependency 'playwright-core' (not allowed in dom)",
    );
  });

  it('rejects an internal import outside the dependency graph', async () => {
    const root = await makeTree({
      runtime: {
        deps: ['@browser-os/daemon'],
        src: { 'a.ts': "import { x } from '@browser-os/daemon';\nexport{x};\n" },
      },
      daemon: { src: { 'index.ts': 'export const x = 1;\n' } },
    });
    expect(messages(checkBoundaries(root))).toContain(
      "packages/runtime/src/a.ts: imports '@browser-os/daemon' (not allowed in runtime)",
    );
  });

  it('rejects a deep import into another package', async () => {
    const root = await makeTree({
      dom: {
        deps: ['@browser-os/protocol'],
        src: { 'a.ts': "import { a } from '@browser-os/protocol/src/a.js';\nexport{a};\n" },
      },
    });
    expect(messages(checkBoundaries(root))).toContain(
      "packages/dom/src/a.ts: deep import '@browser-os/protocol/src/a.js' (not allowed in dom)",
    );
  });

  it('rejects a relative import that escapes the package root', async () => {
    const root = await makeTree({
      browser: {
        deps: ['@browser-os/protocol'],
        src: { 'a.ts': "import { q } from '../../dom/src/query.js';\nexport{q};\n" },
      },
      dom: { src: { 'query.ts': 'export const q = 1;\n' } },
    });
    expect(messages(checkBoundaries(root))).toContain(
      "packages/browser/src/a.ts: relative import '../../dom/src/query.js' escapes packages/browser",
    );
  });

  it('allows node: built-ins anywhere', async () => {
    const root = await makeTree({
      protocol: { src: { 'a.ts': "import { randomUUID } from 'node:crypto';\nexport{randomUUID};\n" } },
    });
    expect(checkBoundaries(root)).toEqual([]);
  });

  it('allows the cli to declare the daemon package without importing it', async () => {
    const declaring = await makeTree({
      cli: { deps: ['@browser-os/daemon'], src: { 'index.ts': 'export {};\n' } },
      daemon: { src: { 'index.ts': 'export {};\n' } },
    });
    expect(checkBoundaries(declaring)).toEqual([]);

    const importing = await makeTree({
      cli: { deps: ['@browser-os/daemon'], src: { 'a.ts': "import '@browser-os/daemon';\n" } },
      daemon: { src: { 'index.ts': 'export {};\n' } },
    });
    expect(messages(checkBoundaries(importing))).toContain(
      "packages/cli/src/a.ts: imports '@browser-os/daemon' (not allowed in cli)",
    );
  });

  it('passes on this repository', () => {
    const repoRoot = path.resolve(import.meta.dirname, '..', '..');
    expect(checkBoundaries(repoRoot)).toEqual([]);
  });
});

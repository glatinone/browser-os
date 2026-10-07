import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import { cssPath, isStableId } from '../src/css-path.js';
import { joinRawCapture } from '../src/join.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(dir, 'fixtures');

function loadFixture(name: string) {
  const raw = JSON.parse(readFileSync(path.join(fixturesDir, `${name}.raw.json`), 'utf8')) as RawCapture;
  return joinRawCapture(raw);
}

describe('isStableId', () => {
  it('filters out unstable generated IDs', () => {
    // 4+ digits
    expect(isStableId('item1234')).toBe(false);
    expect(isStableId('123456')).toBe(false);

    // 8+ hex chars
    expect(isStableId('a1b2c3d4')).toBe(false);
    expect(isStableId('deadbeef01')).toBe(false);

    // React 18 useId :r...:
    expect(isStableId(':r12:')).toBe(false);
    expect(isStableId(':r0:')).toBe(false);

    // Framework prefixes
    expect(isStableId('react-1')).toBe(false);
    expect(isStableId('ember123')).toBe(false);
    expect(isStableId('vue-btn')).toBe(false);
    expect(isStableId('mui-component')).toBe(false);
    expect(isStableId('radix-id')).toBe(false);
    expect(isStableId('headlessui-listbox')).toBe(false);

    // 1-3 chars + digits
    expect(isStableId('a1')).toBe(false);
    expect(isStableId('btn2')).toBe(false);
    expect(isStableId('el999')).toBe(false);
  });

  it('preserves stable semantic IDs', () => {
    expect(isStableId('name')).toBe(true);
    expect(isStableId('email')).toBe(true);
    expect(isStableId('country')).toBe(true);
    expect(isStableId('submit-button')).toBe(true);
    expect(isStableId('search_input')).toBe(true);
    expect(isStableId('terms-and-conditions')).toBe(true);
  });
});

describe('cssPath', () => {
  it('handles stable IDs, data-testid, and hierarchy on basic fixture', () => {
    const table = loadFixture('basic');
    const nameRow = table.rows.find((r) => r.attrs.id === 'name');
    expect(nameRow).toBeDefined();
    if (nameRow) {
      expect(cssPath(table, nameRow.idx)).toBe('#name');
    }

    const emailRow = table.rows.find((r) => r.attrs.id === 'email');
    expect(emailRow).toBeDefined();
    if (emailRow) {
      expect(cssPath(table, emailRow.idx)).toBe('#email');
    }
  });

  it('crosses shadow DOM boundaries with >>> on shadow fixture', () => {
    const table = loadFixture('shadow');
    const shadowSaveRow = table.rows.find((r) => r.attrs.id === 'shadow-save');
    expect(shadowSaveRow).toBeDefined();
    if (shadowSaveRow) {
      const pathResult = cssPath(table, shadowSaveRow.idx);
      expect(pathResult).toContain('>>>');
      expect(pathResult).toContain('#shadow-save');
    }

    const shadowHelpRow = table.rows.find((r) => r.attrs.id === 'shadow-help');
    expect(shadowHelpRow).toBeDefined();
    if (shadowHelpRow) {
      const pathResult = cssPath(table, shadowHelpRow.idx);
      expect(pathResult).toContain('>>>');
      expect(pathResult).toContain('#shadow-help');
    }
  });

  it('computes cssPath within iframe fixture documents', () => {
    const table = loadFixture('iframe');
    const frameUserRow = table.rows.find((r) => r.attrs.id === 'frame-username');
    expect(frameUserRow).toBeDefined();
    if (frameUserRow) {
      expect(cssPath(table, frameUserRow.idx)).toBe('#frame-username');
    }
  });
});

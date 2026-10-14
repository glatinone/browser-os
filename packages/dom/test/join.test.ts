import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import { joinRawCapture } from '../src/join.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function load(name: string): Promise<RawCapture> {
  return JSON.parse(await readFile(path.join(fixtures, `${name}.raw.json`), 'utf8')) as RawCapture;
}

async function recordedFixtures(): Promise<string[]> {
  const files = await readdir(fixtures);
  return files
    .filter((file) => file.endsWith('.raw.json'))
    .map((file) => file.slice(0, -'.raw.json'.length))
    .sort();
}

const close = (actual: number, expected: number, tolerance = 0.5): boolean => Math.abs(actual - expected) <= tolerance;

describe('raw capture fixtures', () => {
  it('joins the basic fixture deterministically and preserves backend identities', async () => {
    const raw = await load('basic');
    const first = joinRawCapture(raw);
    const second = joinRawCapture(raw);
    expect(first).toEqual(second);
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.every((row) => row.backendNodeId > 0)).toBe(true);
    expect(
      first.rows.some(
        (row) => row.tag === 'input' && row.attrs.id === 'email' && row.attrs.placeholder === 'you@example.com',
      ),
    ).toBe(true);
  });

  it('retains the child frame capture and its accessibility tree', async () => {
    const raw = await load('iframe');
    expect(raw.frames.length).toBeGreaterThan(1);
    expect(raw.axTrees.length).toBeGreaterThan(1);
    expect(raw.snapshot.documents.length).toBeGreaterThan(1);
    expect(raw.documents.every((document) => document.frameId)).toBe(true);
    const table = joinRawCapture(raw);
    const childFrameId = raw.documents[1]?.frameId;
    expect(childFrameId).toBeTruthy();
    const hostIndex = table.rows.findIndex((row) => row.tag === 'iframe');
    const childIndex = table.rows.findIndex((row) => row.frameId === childFrameId && row.tag === 'html');
    expect(hostIndex).toBeGreaterThanOrEqual(0);
    expect(childIndex).toBeGreaterThan(hostIndex);
    expect(table.rows[childIndex]?.parentIdx).toBe(hostIndex);
  });

  it('marks rows inside an open shadow root with their host', async () => {
    const table = joinRawCapture(await load('shadow'));
    const hostIndex = table.rows.findIndex((row) => row.tag === 'bos-panel');
    const shadowInput = table.rows.find((row) => row.attrs.id === 'shadow-name');
    expect(hostIndex).toBeGreaterThanOrEqual(0);
    expect(shadowInput?.shadowHostIdx).toBe(hostIndex);
  });
});

describe('join invariants across all recorded captures', () => {
  it('covers every recorded *.raw.json fixture', async () => {
    const names = await recordedFixtures();
    expect(names).toEqual([
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
    ]);
    expect(names.length).toBe(12);
  });

  it('gives every row a positive backendNodeId and keeps parents before children', async () => {
    const missingIds: string[] = [];
    const badOrder: string[] = [];
    const emptyTables: string[] = [];

    for (const name of await recordedFixtures()) {
      const table = joinRawCapture(await load(name));
      if (table.rows.length === 0) emptyTables.push(name);
      for (const row of table.rows) {
        if (!(row.backendNodeId > 0)) missingIds.push(`${name}#${row.idx}(${row.tag})`);
        if (row.parentIdx !== null && row.parentIdx >= row.idx)
          badOrder.push(`${name}#${row.idx}(${row.tag}) parent=${row.parentIdx}`);
      }
      for (const text of table.texts) {
        if (text.parentIdx >= table.rows.length) badOrder.push(`${name} text parent=${text.parentIdx}`);
      }
    }

    expect(emptyTables).toEqual([]);
    expect(missingIds).toEqual([]);
    expect(badOrder).toEqual([]);
  });

  it('keeps child-document rows out of the main frame', async () => {
    const offenders: string[] = [];

    for (const name of await recordedFixtures()) {
      const raw = await load(name);
      const mainFrameId = raw.frames[0]?.id;
      expect(mainFrameId, `${name} must record a main frame`).toBeTruthy();
      const table = joinRawCapture(raw);
      for (const row of table.rows) {
        if (row.docIndex > 0 && row.frameId === mainFrameId)
          offenders.push(`${name}#${row.idx}(${row.tag}) doc=${row.docIndex}`);
      }
      if (name === 'iframe') {
        const childRows = table.rows.filter((row) => row.docIndex > 0);
        expect(childRows.length).toBeGreaterThan(0);
        expect(childRows.every((row) => row.frameId !== mainFrameId)).toBe(true);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('links shadow-tree rows to their host in the shadow fixture', async () => {
    const table = joinRawCapture(await load('shadow'));
    const withHost = table.rows.filter((row) => row.shadowHostIdx !== null);
    expect(withHost.length).toBeGreaterThan(0);
    expect(withHost.every((row) => row.shadowHostIdx !== null && row.shadowHostIdx < row.idx)).toBe(true);
    expect(table.rows.every((row) => row.backendNodeId > 0)).toBe(true);
    expect(table.rows.every((row) => row.parentIdx === null || row.parentIdx < row.idx)).toBe(true);
  });

  it('reports the basic email input with viewport bounds, textbox role and placeholder', async () => {
    const table = joinRawCapture(await load('basic'));
    const email = table.rows.find((row) => row.tag === 'input' && row.attrs.id === 'email');
    expect(email).toBeDefined();
    expect(email?.bounds).toEqual({ x: 8, y: 165.875, w: 177, h: 21 });
    expect(email?.ax?.role).toBe('textbox');
    expect(email?.attrs.placeholder).toBe('you@example.com');
  });
});

describe('coordinate conversion (spec dom-intelligence §3)', () => {
  it('emits child-frame bounds in top-level viewport coordinates', async () => {
    const raw = await load('iframe');
    const mainFrameId = raw.frames[0]?.id;
    const table = joinRawCapture(raw);
    const child = table.rows.find((row) => row.attrs.id === 'frame-username' && row.frameId !== mainFrameId);
    const host = table.rows.find((row) => row.tag === 'iframe');

    expect(child).toBeDefined();
    const childBounds = child?.bounds ?? null;
    expect(childBounds).not.toBeNull();
    if (!childBounds) return;

    // iframe-local input#frame-username sits at (72.859, 16); the host iframe
    // starts at (8, 79.875) in the top-level document, so top-level coords are
    // (80.859, 95.875).
    expect(close(childBounds.x, 80.859)).toBe(true);
    expect(close(childBounds.y, 95.875)).toBe(true);
    expect(close(childBounds.w, 177)).toBe(true);
    expect(close(childBounds.h, 21)).toBe(true);

    // ...and must NOT still be the iframe-local rect.
    expect(Math.abs(childBounds.x - 72.859)).toBeGreaterThan(0.5);
    expect(Math.abs(childBounds.y - 16)).toBeGreaterThan(0.5);

    // Cross-check against the fixture itself: child-local + host bounds.
    expect(host?.bounds).toEqual({ x: 8, y: 79.875, w: 364, h: 204 });
    const localLayout = raw.documents[1]?.layout.find((layout) => layout.nodeIndex === 15);
    expect(localLayout?.bounds).toEqual([72.859375, 16, 177, 21]);
    expect(close(childBounds.x, (localLayout?.bounds[0] ?? 0) + (host?.bounds?.x ?? 0))).toBe(true);
    expect(close(childBounds.y, (localLayout?.bounds[1] ?? 0) + (host?.bounds?.y ?? 0))).toBe(true);
  });

  it('subtracts the scroll offset from top-level and child-frame bounds', async () => {
    const scrolled = structuredClone(await load('iframe'));
    scrolled.viewport = { ...scrolled.viewport, pageX: 50, pageY: 25 };
    const table = joinRawCapture(scrolled);
    const mainFrameId = scrolled.frames[0]?.id;

    const email = table.rows.find((row) => row.tag === 'iframe' && row.frameId === mainFrameId);
    // Host iframe document bounds (8, 79.875) minus scroll (50, 25).
    expect(email?.bounds?.x).toBeCloseTo(8 - 50, 5);
    expect(email?.bounds?.y).toBeCloseTo(79.875 - 25, 5);

    const child = table.rows.find((row) => row.attrs.id === 'frame-username' && row.frameId !== mainFrameId);
    // Child-local (72.859, 16) + already scroll-adjusted host (-42, 54.875).
    expect(child?.bounds?.x).toBeCloseTo(72.859375 + (8 - 50), 5);
    expect(child?.bounds?.y).toBeCloseTo(16 + (79.875 - 25), 5);
  });

  it('converts unscrolled captures without shifting top-level bounds', async () => {
    const table = joinRawCapture(await load('basic'));
    expect(table.viewport.pageX).toBe(0);
    expect(table.viewport.pageY).toBe(0);
    const email = table.rows.find((row) => row.tag === 'input' && row.attrs.id === 'email');
    expect(email?.bounds).toEqual({ x: 8, y: 165.875, w: 177, h: 21 });
  });
});

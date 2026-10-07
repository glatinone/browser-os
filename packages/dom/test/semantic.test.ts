import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import type { NodeRow, NodeTable } from '../src/join.js';
import { joinRawCapture } from '../src/join.js';
import {
  buildObservation,
  buildObservationFromTable,
  buildTextBlocks,
  describeSelectOptions,
} from '../src/semantic.js';
import { estimateTokens, serializeLines } from '../src/serialize.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function load(name: string): Promise<RawCapture> {
  return JSON.parse(await readFile(path.join(fixtures, `${name}.raw.json`), 'utf8')) as RawCapture;
}

describe('semantic observation goldens', () => {
  it('emits the stable interactive contract for the recorded basic page', async () => {
    const result = buildObservation(await load('basic'), {
      url: 'http://127.0.0.1/basic/',
      title: 'Basic form',
      sessionId: 'session-test',
      pageId: 'page-test',
      capturedAt: 123,
      includeText: true,
    });
    const { observation, index } = result;
    expect(observation.id).toMatch(/^obs_/);
    expect(observation.sessionId).toBe('session-test');
    expect(observation.pageId).toBe('page-test');
    expect(observation.capturedAt).toBe(123);
    expect(observation.challenge).toBeNull();
    expect(observation.elements.length).toBeGreaterThanOrEqual(8);
    expect(observation.elements.map((element) => element.ref)).toEqual(
      observation.elements.map((_, index) => `e${index + 1}`),
    );
    expect(observation.elements.some((element) => element.role === 'combobox' && element.name === 'Country')).toBe(
      true,
    );
    expect(
      observation.elements.some((element) => element.role === 'checkbox' && element.name.includes('newsletter')),
    ).toBe(true);
    expect(observation.elements.some((element) => element.role === 'radio' && element.name === 'Yearly')).toBe(true);
    expect(observation.text.length).toBeGreaterThan(0);
    expect(observation.stats.elements).toBe(observation.elements.length);
    expect(index.entries.size).toBe(observation.elements.length);
    for (const ref of observation.elements.map((element) => element.ref)) {
      expect(index.entries.has(ref)).toBe(true);
    }
  });

  it('masks sensitive values and keeps serializer output deterministic', async () => {
    const raw = await load('basic');
    const first = buildObservation(raw, { url: 'http://127.0.0.1/basic/' }).observation;
    const second = buildObservation(raw, { url: 'http://127.0.0.1/basic/' }).observation;
    const firstLines = serializeLines(first);
    const secondLines = serializeLines(second);
    expect(firstLines).toBe(secondLines);
    expect(firstLines).not.toContain('password123');
    expect(firstLines).not.toContain('secret');
    expect(firstLines).toContain('url: http://127.0.0.1/basic/');
    expect(firstLines).toContain('dialogs: none');
    expect(firstLines).toContain('combobox');
  });

  it('applies the role fallback table for native tags', () => {
    const table = unitTable([
      unitRow({ idx: 0, tag: 'a', attrs: { href: '/docs' } }),
      unitRow({ idx: 1, tag: 'button' }),
      unitRow({ idx: 2, tag: 'select' }),
      unitRow({ idx: 3, tag: 'textarea' }),
      unitRow({ idx: 4, tag: 'input', attrs: { type: 'checkbox' } }),
      unitRow({ idx: 5, tag: 'input', attrs: { type: 'search' } }),
      unitRow({ idx: 6, tag: 'div', attrs: { contenteditable: 'true' } }),
    ]);
    const { observation } = buildObservationFromUnit(table);
    expect(observation.elements.map((element) => element.role)).toEqual([
      'link',
      'button',
      'combobox',
      'textbox',
      'checkbox',
      'searchbox',
      'textbox',
    ]);
  });

  it('falls back through aria-label, placeholder, title, alt, and descendant text', () => {
    const table = unitTable([
      unitRow({ idx: 0, tag: 'button', attrs: { 'aria-label': 'Close dialog' } }),
      unitRow({ idx: 1, tag: 'input', attrs: { placeholder: 'Search here' } }),
      unitRow({ idx: 2, tag: 'input', attrs: { title: 'Employee code' } }),
      unitRow({ idx: 3, tag: 'input', attrs: { type: 'image', alt: 'Submit form' } }),
      unitRow({ idx: 4, tag: 'button' }),
    ]);
    table.texts.push({ parentIdx: 4, text: 'Save changes' });
    const { observation } = buildObservationFromUnit(table);
    const names = observation.elements.map((element) => element.name);
    expect(names).toEqual(['Close dialog', 'Search here', 'Employee code', 'Submit form', 'Save changes']);
  });

  it('formats up to two context ancestors nearest first', () => {
    const nav = unitRow({
      idx: 0,
      tag: 'nav',
      ax: {
        role: 'navigation',
        name: 'Primary Navigation With A Very Long Name Beyond Forty Characters',
        ignored: false,
        props: {},
      },
    });
    const form = unitRow({
      idx: 1,
      parentIdx: 0,
      tag: 'form',
      ax: { role: 'form', name: 'Signup', ignored: false, props: {} },
    });
    const button = unitRow({ idx: 2, parentIdx: 1, tag: 'button' });
    const table = unitTable([nav, form, button]);
    table.texts.push({ parentIdx: 2, text: 'Join' });
    const { observation } = buildObservationFromUnit(table);
    expect(observation.elements[0]?.context).toEqual([
      'form:Signup',
      'navigation:Primary Navigation With A Very Long Nam…',
    ]);
  });

  it('groups adjacent text, caps blocks, and reports heading levels', () => {
    const heading = unitRow({ idx: 0, tag: 'h2' });
    const para = unitRow({ idx: 1, tag: 'p' });
    const table = unitTable([heading, para]);
    table.texts.push(
      { parentIdx: 0, text: 'Hello' },
      { parentIdx: 0, text: 'world' },
      { parentIdx: 1, text: `x`.repeat(500) },
    );
    const blocks = buildTextBlocks(table, 4000);
    expect(blocks[0]).toMatchObject({ ref: 't1', role: 'heading', level: 2, text: 'Hello world' });
    expect(blocks[1]?.text.length).toBeLessThanOrEqual(300);
    const limited = buildTextBlocks(table, 5);
    expect(limited.join('').length).toBeLessThanOrEqual(20);
  });

  it('lists select options and masks password values', () => {
    const select = unitRow({ idx: 0, tag: 'select' });
    const first = unitRow({ idx: 1, parentIdx: 0, tag: 'option' });
    const second = unitRow({ idx: 2, parentIdx: 0, tag: 'option' });
    const password = unitRow({ idx: 3, tag: 'input', attrs: { type: 'password', name: 'pw' }, inputValue: 'hunter2' });
    const table = unitTable([select, first, second, password]);
    table.texts.push(
      { parentIdx: 0, text: 'Country' },
      { parentIdx: 1, text: 'Indonesia' },
      { parentIdx: 2, text: 'Japan' },
    );
    expect(describeSelectOptions(select, table)).toBe('options: Indonesia | Japan');
    const { observation } = buildObservationFromUnit(table);
    const secret = observation.elements.find((element) => element.tag === 'input');
    expect(secret?.value).toBe('••••');
    expect(serializeLines(observation)).not.toContain('hunter2');
  });

  it('fills the minimal index locator and serializes viewport filtering', () => {
    const table = unitTable([
      unitRow({ idx: 0, tag: 'button', bounds: { x: 0, y: 0, w: 10, h: 10 } }),
      unitRow({ idx: 1, tag: 'button', bounds: { x: 0, y: 2000, w: 10, h: 10 } }),
    ]);
    table.texts.push({ parentIdx: 0, text: 'Top' }, { parentIdx: 1, text: 'Bottom' });
    const { observation, index } = buildObservationFromUnit(table);
    expect(observation.elements).toHaveLength(2);
    expect(observation.elements[1]?.inViewport).toBe(false);
    const entry = index.entries.get('e1');
    expect(entry).toMatchObject({
      backendNodeId: expect.any(Number),
      frameId: 'f0',
      locator: {
        v: 1,
        role: 'button',
        name: 'Top',
        nameIsDynamic: false,
        tag: 'button',
        cssPath: 'button:nth-of-type(1)',
        ordinal: 0,
      },
    });
    const all = serializeLines(observation);
    const visibleOnly = serializeLines(observation, { viewportOnly: true });
    expect(all).toContain('e2 button "Bottom"');
    expect(visibleOnly).not.toContain('e2 button "Bottom"');
    expect(visibleOnly).toContain('e1 button "Top"');
    expect(estimateTokens('abcd')).toBe(1);
    expect(observation.stats.estTokens).toBe(estimateTokens(all));
  });

  it('keeps join output deterministic for golden input', async () => {
    const raw = await load('basic');
    const first = JSON.stringify(joinRawCapture(raw));
    const second = JSON.stringify(joinRawCapture(raw));
    expect(first).toBe(second);
  });
});

function unitRow(overrides: Partial<NodeRow> = {}): NodeRow {
  return {
    idx: 0,
    backendNodeId: 1000 + (overrides.idx ?? 0),
    docIndex: 0,
    frameId: 'frame-1',
    parentIdx: null,
    tag: 'div',
    attrs: {},
    shadowHostIdx: null,
    bounds: { x: 0, y: 0, w: 50, h: 20 },
    styles: {},
    paintOrder: null,
    isClickable: false,
    ...overrides,
  };
}

function unitTable(rows: NodeRow[]): NodeTable {
  return {
    rows,
    texts: [],
    frames: [{ id: 'frame-1', url: 'http://127.0.0.1/basic/' }],
    viewport: { width: 1280, height: 800, pageX: 0, pageY: 0 },
  };
}

function buildObservationFromUnit(table: NodeTable) {
  return buildObservationFromTable(table, {
    url: 'http://127.0.0.1/basic/',
    title: 'Basic form',
    includeText: true,
  });
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Observation } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import { detectChallenge } from '../src/challenge.js';
import type { NodeRow, NodeTable } from '../src/join.js';
import { joinRawCapture } from '../src/join.js';
import { buildObservation, buildObservationFromTable } from '../src/semantic.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function load(name: string): Promise<RawCapture> {
  return JSON.parse(await readFile(path.join(fixtures, `${name}.raw.json`), 'utf8')) as RawCapture;
}

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

function unitTable(
  rows: NodeRow[],
  frames: NodeTable['frames'] = [{ id: 'frame-1', url: 'http://127.0.0.1/' }],
): NodeTable {
  return {
    rows,
    texts: [],
    frames,
    viewport: { width: 1280, height: 800, pageX: 0, pageY: 0 },
  };
}

function observationFor(table: NodeTable, url = 'http://127.0.0.1/', title = 'Page'): Observation {
  return buildObservationFromTable(table, { url, title, includeText: true }).observation;
}

describe('detectChallenge', () => {
  it('detects login on the login fixture step 1', async () => {
    const raw = await load('login');
    const table = joinRawCapture(raw);
    const { observation } = buildObservation(raw, {
      url: 'http://127.0.0.1/login/',
      title: 'Sign in',
      includeText: true,
    });
    expect(detectChallenge(observation, table)).toBe('login');
    expect(observation.challenge).toBe('login');
  });

  it('detects mfa when the OTP step is visible', async () => {
    const raw = await load('login');
    const table = joinRawCapture(raw);
    // Simulate step 2: hide the password form, reveal the OTP input.
    // Hidden nodes have no layout in the fixture, so give the OTP input
    // bounds as a real layout would after unhiding.
    for (const row of table.rows) {
      if (row.attrs.id === 'step1') row.styles.display = 'none';
      if (row.attrs.id === 'password') {
        row.styles.display = 'none';
        row.bounds = null;
      }
      if (row.attrs.id === 'step2') delete row.styles.display;
      if (row.attrs.id === 'otp') {
        delete row.styles.display;
        row.bounds = { x: 69, y: 116, w: 177, h: 21 };
      }
    }
    const observation = observationFor(table, 'http://127.0.0.1/login/', 'Sign in');
    expect(detectChallenge(observation, table)).toBe('mfa');
  });

  it('detects captcha from an iframe src', () => {
    const table = unitTable(
      [unitRow({ idx: 0, tag: 'button' })],
      [
        { id: 'frame-1', url: 'http://127.0.0.1/' },
        { id: 'frame-2', url: 'https://www.google.com/recaptcha/api2/anchor', parentId: 'frame-1' },
      ],
    );
    table.texts.push({ parentIdx: 0, text: 'Continue' });
    expect(detectChallenge(observationFor(table), table)).toBe('captcha');
  });

  it('detects captcha from a visible attribute', () => {
    const table = unitTable([unitRow({ idx: 0, tag: 'div', attrs: { id: 'captcha-box' } })]);
    table.texts.push({ parentIdx: 0, text: 'Prove you are human' });
    expect(detectChallenge(observationFor(table), table)).toBe('captcha');
  });

  it('detects consent on an IdP host', () => {
    const table = unitTable([unitRow({ idx: 0, tag: 'button' })]);
    table.texts.push({ parentIdx: 0, text: 'ExampleApp wants to access your account' });
    const observation = observationFor(table, 'https://login.microsoftonline.com/consent', 'Permissions');
    expect(detectChallenge(observation, table)).toBe('consent');
  });

  it('prioritizes captcha over login', () => {
    const table = unitTable(
      [
        unitRow({ idx: 0, tag: 'input', attrs: { type: 'password', name: 'pw' } }),
        unitRow({ idx: 1, tag: 'div', attrs: { class: 'g-recaptcha' } }),
      ],
      [{ id: 'frame-1', url: 'http://127.0.0.1/' }],
    );
    table.texts.push({ parentIdx: 1, text: 'Captcha' });
    expect(detectChallenge(observationFor(table), table)).toBe('captcha');
  });

  it('returns null for basic and for a page mentioning code in prose', async () => {
    const basic = await load('basic');
    const basicTable = joinRawCapture(basic);
    const basicObs = buildObservation(basic, { url: 'http://127.0.0.1/basic/', includeText: true }).observation;
    expect(detectChallenge(basicObs, basicTable)).toBeNull();

    const table = unitTable([unitRow({ idx: 0, tag: 'p' })]);
    table.texts.push({ parentIdx: 0, text: 'Enter the promo code at checkout for 10% off' });
    expect(detectChallenge(observationFor(table), table)).toBeNull();
  });

  it('has no false positives on non-login fixtures', async () => {
    const names = [
      'basic',
      'contenteditable',
      'dynamic',
      'iframe',
      'injection',
      'modal',
      'overlay',
      'risk',
      'shadow',
      'spa',
      'upload',
    ];
    for (const name of names) {
      const raw = await load(name);
      const table = joinRawCapture(raw);
      const { observation } = buildObservation(raw, { url: `http://127.0.0.1/${name}/`, includeText: true });
      expect(detectChallenge(observation, table)).toBeNull();
    }
  });
});

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RawCapture } from '../src/capture.js';
import { joinRawCapture } from '../src/join.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function load(name: string): Promise<RawCapture> {
  return JSON.parse(await readFile(path.join(fixtures, `${name}.raw.json`), 'utf8')) as RawCapture;
}

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
    expect(table.rows.some((row) => row.frameId === childFrameId)).toBe(true);
  });
});

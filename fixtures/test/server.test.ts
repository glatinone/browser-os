import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from '../server.js';

const PAGES = [
  'basic',
  'spa',
  'iframe',
  'shadow',
  'dynamic',
  'modal',
  'overlay',
  'login',
  'risk',
  'injection',
  'upload',
  'contenteditable',
  'heavy',
];

let server: FixtureServer;

beforeAll(async () => {
  server = await startFixtureServer();
});

afterAll(async () => {
  await server.close();
});

describe('fixture server', () => {
  it('binds to loopback and serves every page', async () => {
    expect(server.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    for (const name of PAGES) {
      const res = await fetch(`${server.baseUrl}/${name}/`);
      expect(res.status, `${name} should be 200`).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.text()).toContain('<html');
    }
  });

  it('echoes a posted form body as JSON', async () => {
    const res = await fetch(`${server.baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'name=Ada&email=ada%40example.com',
    });
    expect(await res.json()).toEqual({ received: { name: 'Ada', email: 'ada@example.com' } });
  });

  it('serves a download with an attachment disposition', async () => {
    const res = await fetch(`${server.baseUrl}/download/sample.txt`);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="sample.txt"');
    expect(await res.text()).toContain('fixture download');
  });

  it('delays /slow by the requested number of milliseconds', async () => {
    const started = Date.now();
    const res = await fetch(`${server.baseUrl}/slow?ms=250`);
    expect(await res.json()).toEqual({ waitedMs: 250 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it('falls back to the SPA shell for extensionless routes', async () => {
    const res = await fetch(`${server.baseUrl}/spa/people/42`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="app"');
  });

  it('passes ?variant= through untouched', async () => {
    const res = await fetch(`${server.baseUrl}/spa/?variant=mutated`);
    expect(await res.text()).toContain('variant');
  });

  it('refuses path traversal outside the sites directory', async () => {
    const res = await fetch(`${server.baseUrl}/..%2F..%2Fpackage.json`);
    expect([403, 404]).toContain(res.status);
  });
});

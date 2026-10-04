import { describe, expect, it } from 'vitest';
import { CdpEndpointProvider, isLoopbackEndpoint } from '../src/providers/cdp-endpoint-provider.js';
import { dummyProfile } from './support/dummy-profile.js';

const LOOPBACK: Array<[string, string]> = [
  ['a Chromium websocket', 'ws://127.0.0.1:9222/devtools/browser/8f2b1c'],
  ['an HTTP endpoint', 'http://127.0.0.1:9222'],
  ['the localhost name', 'ws://localhost:9222/devtools/browser/8f2b1c'],
  ['localhost over HTTP', 'http://localhost:9222/json/version'],
  ['IPv6 loopback', 'ws://[::1]:9222/devtools/browser/8f2b1c'],
];

const NOT_LOOPBACK: Array<[string, string]> = [
  ['a LAN address', 'ws://192.168.1.5:9222/devtools/browser/8f2b1c'],
  ['a public host', 'wss://chrome.example.com:9222/devtools/browser/8f2b1c'],
  ['a host merely starting with the loopback address', 'ws://127.0.0.1.evil.test:9222/x'],
  ['a host merely ending with localhost', 'http://localhost.evil.test:9222'],
  ['the wildcard address', 'ws://0.0.0.0:9222/devtools/browser/8f2b1c'],
  ['a loopback address the spec does not allow', 'ws://127.0.0.2:9222/x'],
  ['an endpoint with no scheme', '127.0.0.1:9222'],
  ['a non-browser scheme', 'file:///devtools/browser/8f2b1c'],
  ['an unparseable endpoint', 'ws://[::1'],
  ['an empty string', ''],
];

describe('isLoopbackEndpoint', () => {
  it.each(LOOPBACK)('accepts %s', (_what, endpoint) => {
    expect(isLoopbackEndpoint(endpoint)).toBe(true);
  });

  it.each(NOT_LOOPBACK)('rejects %s', (_what, endpoint) => {
    expect(isLoopbackEndpoint(endpoint)).toBe(false);
  });
});

describe('CdpEndpointProvider.open (S3)', () => {
  const provider = new CdpEndpointProvider();

  it('announces itself as an attached, endpoint-driven provider', () => {
    expect(provider.kind).toBe('cdp-endpoint');
    // The profile belongs to whoever started the browser, so we cannot claim it persists.
    expect(provider.capabilities.persistentProfile).toBe(false);
  });

  it('refuses a non-loopback endpoint without dialling it', async () => {
    // 10.255.255.1 is a black hole: if the guard let the call through, this would hang until
    // the test timed out instead of failing on the code. That is the S3 contract.
    await expect(
      provider.open({ profile: dummyProfile(), cdpEndpoint: 'ws://10.255.255.1:9222/devtools/browser/x' }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('names the missing endpoint rather than connecting somewhere', async () => {
    await expect(provider.open({ profile: dummyProfile() })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });
});

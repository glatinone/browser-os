import { tmpdir } from 'node:os';
import path from 'node:path';
import { type BrowserProfile, newId } from '@browser-os/protocol';

/**
 * A profile for a provider that does not use one. `OpenOptions.profile` is required because
 * the launch provider needs it, and every session has a profile row anyway (data-models §2).
 */
export function dummyProfile(name = 'cdp-endpoint-test'): BrowserProfile {
  return {
    id: newId('prf'),
    name,
    channel: 'chromium',
    userDataDir: path.join(tmpdir(), `bos-unused-${name}`),
    headless: true,
    createdAt: Date.now(),
    lastUsedAt: null,
  };
}

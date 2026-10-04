// Browser provider interfaces (browser-runtime §2).
//
// These are the only browser types another package may see: everything is
// expressed with protocol types plus our own interfaces, never with Playwright's.

import type { BrowserProfile } from '@browser-os/protocol';
import type { PageHandle } from './page-handle.js';

export interface ProviderCapabilities {
  persistentProfile: boolean;
  screenshots: boolean;
  oopif: boolean;
  headful: boolean;
  uploads: boolean;
  downloads: boolean;
}

export interface OpenOptions {
  profile: BrowserProfile;
  headless?: boolean;
  /** For `cdp-endpoint` (loopback only). */
  cdpEndpoint?: string;
  /** `null` = use the window size (the default). */
  viewport?: { width: number; height: number } | null;
}

export interface BrowserHandle {
  /** `null` is expected: `launchPersistentContext` does not expose the browser process (integration §13). */
  readonly pid: number | null;
  pages(): PageHandle[];
  newPage(): Promise<PageHandle>;
  onPage(cb: (page: PageHandle) => void): () => void;
  onDisconnected(cb: (reason: string) => void): () => void;
  close(): Promise<void>;
}

export interface BrowserProvider {
  readonly kind: 'launch' | 'cdp-endpoint' | 'chrome-consent' | 'extension' | 'lightpanda';
  readonly capabilities: ProviderCapabilities;
  open(opts: OpenOptions): Promise<BrowserHandle>;
}

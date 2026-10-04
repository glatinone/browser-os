// Public surface of `@browser-os/browser`.
//
// Playwright types never appear here (CODING_AGENT rule 6). `PageHandleImpl` wraps a
// Playwright page and is deliberately **not** re-exported: only the `PageHandle`
// interface is, so this entry point stays free of Playwright types.

export * from './cdp/transport.js';
export * from './driver/types.js';
export * from './executables.js';
export type { PageHandle } from './page-handle.js';
export * from './profiles.js';
export * from './provider.js';
export * from './providers/launch-provider.js';

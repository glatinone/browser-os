// PageDriver types (browser-runtime §5, integration §6).
//
// Types only: P3-01 adds the implementation, and P2-04 needs the shape so
// `PageHandle.driver()` has something to return. Nothing here touches Playwright.

import type { BrowserAction, ElementLocator, ErrorCode } from '@browser-os/protocol';

export interface ResolvedTarget {
  backendNodeId: number;
  cdpFrameId: string;
  locator: ElementLocator;
  role: string;
  name: string;
}

export interface DriverResult {
  ok: boolean;
  /** action-router §4.1: whether the action provably committed. */
  effect: 'none' | 'committed' | 'unknown';
  error?: { code: ErrorCode; message: string };
  urlBefore: string;
  urlAfter: string;
  navigated: boolean;
  newPageId?: string;
}

export interface PageDriver {
  cdpPerform(action: BrowserAction, target: ResolvedTarget | null, value?: string): Promise<DriverResult>;
  playwrightPerform(action: BrowserAction, target: ResolvedTarget | null, value?: string): Promise<DriverResult>;
  navigate(url: string, timeoutMs: number): Promise<DriverResult>;
  waitForLoadState(state: 'load' | 'domcontentloaded', timeoutMs?: number): Promise<void>;
  readValue(target: ResolvedTarget): Promise<string | null>;
  settle(quietMs: number, maxMs: number): Promise<{ waitedMs: number; capped: boolean }>;
  mutationCounter(): Promise<number>;
  extract(target: ResolvedTarget | null, format: 'text' | 'links' | 'table'): Promise<unknown>;
  uploadFiles(target: ResolvedTarget, paths: string[]): Promise<DriverResult>;
  screenshot(): Promise<{ base64: string; mediaType: 'image/png' }>;
}

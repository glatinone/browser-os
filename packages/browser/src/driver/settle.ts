// Is the page still moving? (action-router §7, browser-runtime §5)
//
// Two cheap signals: the requests still in flight that a person would wait for, and how recently
// anything changed. The tracker is created with the page's CDP session and lives as long as it
// does, so `settle` never has to ask the page anything it does not already know.

import type { CdpTransport } from '../cdp/transport.js';

/** The request types that mean the page is doing something worth waiting for. */
const TRACKED_TYPES = new Set(['Document', 'XHR', 'Fetch']);

export interface PageActivity {
  /** Tracked requests still in flight. */
  inFlight(): number;
  /** When any tracked signal last changed, as an epoch millisecond. */
  lastChange(): number;
  /** Whether a frame is loading right now. */
  loading(): boolean;
}

export function trackActivity(transport: CdpTransport, now: () => number = Date.now): PageActivity {
  const requests = new Set<string>();
  const loadingFrames = new Set<string>();
  let lastChange = now();
  const touched = (): void => {
    lastChange = now();
  };

  transport.on('Network.requestWillBeSent', (payload) => {
    const { requestId, type } = payload as { requestId?: string; type?: string };
    if (requestId === undefined || type === undefined) return;
    if (!TRACKED_TYPES.has(type)) return;
    requests.add(requestId);
    touched();
  });

  for (const event of ['Network.loadingFinished', 'Network.loadingFailed']) {
    transport.on(event, (payload) => {
      const { requestId } = payload as { requestId?: string };
      if (requestId !== undefined && requests.delete(requestId)) touched();
    });
  }

  // Any frame, not just the main one: a subframe still loading means the page is not quiet.
  transport.on('Page.frameStartedLoading', (payload) => {
    const { frameId } = payload as { frameId?: string };
    if (frameId === undefined) return;
    loadingFrames.add(frameId);
    touched();
  });
  transport.on('Page.frameStoppedLoading', (payload) => {
    const { frameId } = payload as { frameId?: string };
    if (frameId !== undefined && loadingFrames.delete(frameId)) touched();
  });

  return {
    inFlight: () => requests.size,
    lastChange: () => lastChange,
    loading: () => loadingFrames.size > 0,
  };
}

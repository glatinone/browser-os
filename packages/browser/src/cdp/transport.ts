// CDP transport (browser-runtime §4).
//
// P2-03 adds the Playwright-backed implementation and the counting wrapper; P2-04
// only needs the interface so `PageHandle.cdp()` has a type to return.

export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Subscribes to a CDP event. Returns the unsubscribe function. */
  on(event: string, listener: (payload: unknown) => void): () => void;
}

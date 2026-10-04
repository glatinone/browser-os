import type { CdpTransport } from './transport.js';

/**
 * Counts CDP round trips per method (browser-runtime §4). Tests and benchmarks use it to
 * assert what a code path costs in calls; event subscriptions are not round trips and are
 * passed straight through, uncounted.
 */
export class CountingCdpTransport implements CdpTransport {
  private readonly inner: CdpTransport;
  private readonly tally = new Map<string, number>();

  constructor(inner: CdpTransport) {
    this.inner = inner;
  }

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.tally.set(method, (this.tally.get(method) ?? 0) + 1);
    return await this.inner.send(method, params);
  }

  on(event: string, listener: (payload: unknown) => void): () => void {
    return this.inner.on(event, listener);
  }

  /** Calls per method since the last `reset()`. */
  counts(): Record<string, number> {
    return Object.fromEntries(this.tally);
  }

  total(): number {
    let sum = 0;
    for (const count of this.tally.values()) sum += count;
    return sum;
  }

  reset(): void {
    this.tally.clear();
  }
}

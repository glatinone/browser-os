// The `bos` isolated world (browser-runtime §4, SECURITY S19).
//
// All page-side JavaScript we run belongs in this world and nowhere else: page scripts
// cannot see into it, so they can neither read our helpers nor tamper with them.

import { BosError } from '@browser-os/protocol';
import { HELPERS_BUNDLE } from './helpers.js.js';
import type { CdpTransport } from './transport.js';

export const BOS_WORLD = 'bos';

interface FrameNavigatedPayload {
  frame?: { id?: string };
}

interface ExceptionDetails {
  text?: string;
  exception?: { description?: string };
}

export class IsolatedWorlds {
  private readonly transport: CdpTransport;
  private readonly contexts = new Map<string, number>();
  private readonly pending = new Map<string, Promise<number>>();

  constructor(transport: CdpTransport) {
    this.transport = transport;
    // A cached id belongs to the document that was current when it was created, so it is
    // dropped the moment that frame navigates: the next `get()` builds a fresh world.
    transport.on('Page.frameNavigated', (payload) => {
      const frameId = (payload as FrameNavigatedPayload).frame?.id;
      if (frameId !== undefined) {
        this.contexts.delete(frameId);
        this.pending.delete(frameId);
      }
    });
  }

  /** The `executionContextId` of world `bos` in `frameId`, creating it if needed. */
  async get(frameId: string): Promise<number> {
    const cached = this.contexts.get(frameId);
    if (cached !== undefined) return cached;

    // Two concurrent callers must not create two worlds in one frame.
    let inFlight = this.pending.get(frameId);
    if (inFlight === undefined) {
      inFlight = this.create(frameId);
      this.pending.set(frameId, inFlight);
    }
    return await inFlight;
  }

  /** Runs `fnSource` in the `bos` world and returns its value (`returnByValue`). */
  async evaluate<T>(frameId: string, fnSource: string, args: readonly unknown[] = []): Promise<T> {
    const executionContextId = await this.get(frameId);
    const response = (await this.transport.send('Runtime.callFunctionOn', {
      functionDeclaration: fnSource,
      executionContextId,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: ExceptionDetails };

    const exception = response.exceptionDetails;
    if (exception !== undefined) {
      const message = exception.exception?.description ?? exception.text ?? 'evaluation failed';
      throw new BosError('INTERNAL', `isolated world threw: ${message}`, {
        details: { frameId },
      });
    }
    return response.result?.value as T;
  }

  /** The number of DOM mutations in `frameId`'s world — the settle loop's quiet signal. */
  async mutationCount(frameId: string): Promise<number> {
    const count = await this.evaluate<number>(frameId, 'function () { return globalThis.__bos.mutationCount(); }');
    return count ?? 0;
  }

  private async create(frameId: string): Promise<number> {
    try {
      const created = (await this.transport.send('Page.createIsolatedWorld', {
        frameId,
        worldName: BOS_WORLD,
        // `grantUniveralAccess` is misspelled in CDP itself; the documented name is the
        // one the browser reads, so it stays as it is (browser-runtime §4).
        grantUniveralAccess: false,
      })) as { executionContextId?: number };

      const contextId = created.executionContextId;
      if (typeof contextId !== 'number') {
        throw new BosError('INTERNAL', 'Page.createIsolatedWorld returned no executionContextId', {
          details: { frameId },
        });
      }

      await this.transport.send('Runtime.evaluate', {
        expression: HELPERS_BUNDLE,
        contextId,
        returnByValue: false,
      });
      this.contexts.set(frameId, contextId);
      return contextId;
    } finally {
      this.pending.delete(frameId);
    }
  }
}

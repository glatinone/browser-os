// DefaultPageDriver: the CDP-first executor (browser-runtime §5).
//
// P3-01 gives it navigation, value reading and extraction. Every other method is a placeholder
// that names the task which fills it, so a caller arriving early fails loudly instead of acting
// on a silent no-op.
//
// Playwright is imported for the implementation only; nothing here reaches `src/index.ts`
// (CODING_AGENT rule 6).

import { BosError, type BrowserAction, type ErrorCode } from '@browser-os/protocol';
import type { Page } from 'playwright-core';
import { IsolatedWorlds } from '../cdp/isolated-worlds.js';
import type { CdpTransport } from '../cdp/transport.js';
import { EXTRACTION, type ExtractFormat } from './extract.js';
import type { DriverResult, PageDriver, ResolvedTarget } from './types.js';

export interface DefaultPageDriverDeps {
  page: Page;
  /** The page's own CDP session, shared rather than opened a second time (§4). */
  transport: () => Promise<CdpTransport>;
}

interface ExceptionDetails {
  text?: string;
  exception?: { description?: string };
}

interface CdpSession {
  transport: CdpTransport;
  worlds: IsolatedWorlds;
}

export class DefaultPageDriver implements PageDriver {
  readonly #page: Page;
  readonly #openTransport: () => Promise<CdpTransport>;
  #session: Promise<CdpSession> | null = null;
  #cachedFrameId: string | null = null;

  constructor(deps: DefaultPageDriverDeps) {
    this.#page = deps.page;
    this.#openTransport = deps.transport;
  }

  async navigate(url: string, timeoutMs: number): Promise<DriverResult> {
    const urlBefore = this.#page.url();
    // Nothing was sent, so nothing can have happened (§5: the effect is `none`, not `unknown`).
    if (!isAbsoluteUrl(url)) {
      return this.#failed('NAVIGATION_FAILED', `${url} is not an absolute url`, urlBefore, 'none');
    }

    try {
      await this.#page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    } catch (error) {
      // The url was valid, so a request went out and the browser may have committed something
      // before it failed.
      return this.#failed('NAVIGATION_FAILED', describe(error), urlBefore, 'unknown');
    }

    const urlAfter = this.#page.url();
    // Chrome answers an unreachable host with its own error page and a `chrome-error://` url.
    if (urlAfter.startsWith('chrome-error://')) {
      return this.#failed('NAVIGATION_FAILED', `nothing was served at ${url}`, urlBefore, 'unknown');
    }

    return { ok: true, effect: 'committed', urlBefore, urlAfter, navigated: true };
  }

  async readValue(target: ResolvedTarget): Promise<string | null> {
    const value = await this.#call<string | null>(
      'function () { return globalThis.__bos.readValue(this); }',
      [],
      target,
    );
    return value ?? null;
  }

  async extract(target: ResolvedTarget | null, format: ExtractFormat): Promise<unknown> {
    const { source, args } = EXTRACTION[format];
    return await this.#call(source, args, target);
  }

  // — the rest of the interface arrives with the tasks below; each one says which —

  async cdpPerform(_action: BrowserAction, _target: ResolvedTarget | null, _value?: string): Promise<DriverResult> {
    throw this.#notYet('cdpPerform', 'P3-02');
  }

  async playwrightPerform(
    _action: BrowserAction,
    _target: ResolvedTarget | null,
    _value?: string,
  ): Promise<DriverResult> {
    throw this.#notYet('playwrightPerform', 'P3-04');
  }

  async waitForLoadState(_state: 'load' | 'domcontentloaded', _timeoutMs?: number): Promise<void> {
    throw this.#notYet('waitForLoadState', 'P3-05');
  }

  async settle(_quietMs: number, _maxMs: number): Promise<{ waitedMs: number; capped: boolean }> {
    throw this.#notYet('settle', 'P3-05');
  }

  async mutationCounter(): Promise<number> {
    throw this.#notYet('mutationCounter', 'P3-05');
  }

  async uploadFiles(_target: ResolvedTarget, _paths: string[]): Promise<DriverResult> {
    throw this.#notYet('uploadFiles', 'P3-06');
  }

  async screenshot(): Promise<{ base64: string; mediaType: 'image/png' }> {
    throw this.#notYet('screenshot', 'the vision tier (post-MVP)');
  }

  /** One session per page (§4), and the same one `PageHandle.cdp()` hands out. */
  async #cdp(): Promise<CdpSession> {
    this.#session ??= this.#openTransport()
      .then((transport) => ({ transport, worlds: new IsolatedWorlds(transport) }))
      .catch((error: unknown) => {
        // A failed creation is not cached, so a later call can still succeed.
        this.#session = null;
        throw error;
      });
    return await this.#session;
  }

  /** The main frame, for a call that has no target to carry one. */
  async #mainFrameId(): Promise<string> {
    if (this.#cachedFrameId !== null) return this.#cachedFrameId;
    const { transport } = await this.#cdp();
    const tree = (await transport.send('Page.getFrameTree', {})) as {
      frameTree?: { frame?: { id?: string } };
    };
    const frameId = tree.frameTree?.frame?.id;
    if (frameId === undefined) {
      throw new BosError('INTERNAL', 'Page.getFrameTree returned no frame', {});
    }
    this.#cachedFrameId = frameId;
    return frameId;
  }

  /**
   * Runs `source` in the `bos` world, on `target` when there is one. The target is bound with
   * `DOM.resolveNode`, so the call also proves the node still exists: a node from an older
   * observation is `STALE_REF` rather than an empty answer.
   */
  async #call<T>(source: string, args: readonly unknown[], target: ResolvedTarget | null): Promise<T> {
    const { transport, worlds } = await this.#cdp();
    const frameId = target === null ? await this.#mainFrameId() : target.cdpFrameId;
    const executionContextId = await worlds.get(frameId);

    const params: Record<string, unknown> = {
      functionDeclaration: source,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    };

    if (target === null) {
      params.executionContextId = executionContextId;
    } else {
      const resolved = (await transport.send('DOM.resolveNode', {
        backendNodeId: target.backendNodeId,
        executionContextId,
      })) as { object?: { objectId?: string } };
      const objectId = resolved.object?.objectId;
      if (objectId === undefined) {
        throw new BosError('STALE_REF', 'the target no longer exists', {
          details: { backendNodeId: target.backendNodeId },
        });
      }
      params.objectId = objectId;
    }

    const response = (await transport.send('Runtime.callFunctionOn', params)) as {
      result?: { value?: T };
      exceptionDetails?: ExceptionDetails;
    };
    const exception = response.exceptionDetails;
    if (exception !== undefined) {
      const message = exception.exception?.description ?? exception.text ?? 'the call failed';
      throw new BosError('INTERNAL', `the bos world threw: ${message}`, { details: { frameId } });
    }
    return response.result?.value as T;
  }

  #failed(code: ErrorCode, message: string, urlBefore: string, effect: DriverResult['effect']): DriverResult {
    return {
      ok: false,
      effect,
      error: { code, message },
      urlBefore,
      urlAfter: this.#page.url(),
      navigated: false,
    };
  }

  #notYet(method: string, task: string): BosError {
    return new BosError('INTERNAL', `${method} is not implemented yet (${task})`, {
      details: { method, task },
    });
  }
}

/** A relative or malformed url is refused before anything is sent. */
function isAbsoluteUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

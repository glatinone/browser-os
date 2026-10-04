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
import { cdpFill, cdpScroll, cdpSelect } from './cdp-form.js';
import { cdpPress } from './cdp-keyboard.js';
import { cdpClick, cdpHover } from './cdp-pointer.js';
import { EXTRACTION, type ExtractFormat } from './extract.js';
import { uploadFiles } from './files.js';
import type { CdpContext, DriverOutcome } from './op.js';
import { playwrightPerform } from './playwright-executor.js';
import { type PageActivity, trackActivity } from './settle.js';
import type { DriverResult, PageDriver, ResolvedTarget } from './types.js';

export interface DefaultPageDriverDeps {
  page: Page;
  /** The page's own CDP session, shared rather than opened a second time (§4). */
  transport: () => Promise<CdpTransport>;
  /**
   * The pages the session currently has, so a click that opens one can name it (§P3-02).
   * Injected because the session, not the page, owns that list.
   */
  knownPageIds?: () => readonly string[];
}

/** How long an action gets to show a navigation or a page it opened (§P3-02). */
const ACTION_GRACE_MS = 500;
const ACTION_GRACE_POLL_MS = 50;

/** How often `settle` looks at the page while it waits. */
const SETTLE_POLL_MS = 25;

interface ExceptionDetails {
  text?: string;
  exception?: { description?: string };
}

interface CdpSession {
  transport: CdpTransport;
  worlds: IsolatedWorlds;
  activity: PageActivity;
}

export class DefaultPageDriver implements PageDriver {
  readonly #page: Page;
  readonly #openTransport: () => Promise<CdpTransport>;
  readonly #knownPageIds: (() => readonly string[]) | undefined;
  #session: Promise<CdpSession> | null = null;
  #cachedFrameId: string | null = null;

  constructor(deps: DefaultPageDriverDeps) {
    this.#page = deps.page;
    this.#openTransport = deps.transport;
    this.#knownPageIds = deps.knownPageIds;
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

  async cdpPerform(action: BrowserAction, target: ResolvedTarget | null, value?: string): Promise<DriverResult> {
    return await this.#execute(async (transport) => {
      const ctx: CdpContext = {
        transport,
        call: (source, args, at) => this.#call(source, args, at),
      };
      return await this.#perform(ctx, action, target, value);
    });
  }

  /**
   * The CDP executor for every action it owns (action-router §6). Navigation, extraction, the
   * waits and uploads are reached through the driver's own methods by the router, not here.
   */
  async #perform(
    ctx: CdpContext,
    action: BrowserAction,
    target: ResolvedTarget | null,
    value: string | undefined,
  ): Promise<DriverOutcome> {
    switch (action.type) {
      case 'click':
        return await cdpClick(ctx.transport, needTarget(action.type, target), {
          ...(action.button === undefined ? {} : { button: action.button }),
          ...(action.clickCount === undefined ? {} : { clickCount: action.clickCount }),
        });
      case 'hover':
        return await cdpHover(ctx.transport, needTarget(action.type, target));
      case 'fill':
        return await cdpFill(ctx, needTarget(action.type, target), needValue(action.type, value), {
          submit: action.submit === true,
        });
      case 'press':
        // `press` may carry no target: the key goes to whatever already has focus.
        return await cdpPress(ctx.transport, action.key, target);
      case 'select':
        return await cdpSelect(ctx, needTarget(action.type, target), needValue(action.type, value));
      case 'scroll':
        return await cdpScroll(ctx.transport, target, action.direction, action.amountPx);
      default:
        throw this.#notYet(`cdpPerform(${action.type})`, 'P3-05 and P3-06');
    }
  }

  /**
   * The Playwright fallback, for a target the CDP path refused with `effect: 'none'`
   * (action-router §6).
   */
  async playwrightPerform(action: BrowserAction, target: ResolvedTarget | null, value?: string): Promise<DriverResult> {
    return await this.#execute(async () => await playwrightPerform(this.#page, action, target, value));
  }

  /** Wraps one executor call: its outcome, plus what the page did while it ran. */
  async #execute(work: (transport: CdpTransport) => Promise<DriverOutcome>): Promise<DriverResult> {
    const { transport } = await this.#cdp();
    const urlBefore = this.#page.url();
    const pagesBefore = this.#knownPageIds?.() ?? [];
    const navigation = this.#watchNavigation(transport);

    let outcome: DriverOutcome;
    try {
      outcome = await work(transport);
      // An action that navigates, or opens a page, does it just after the input goes out.
      await this.#until(() => navigation.navigated(), ACTION_GRACE_MS);
      await this.#until(() => this.#newPageId(pagesBefore) !== undefined, ACTION_GRACE_MS);
    } finally {
      navigation.stop();
    }

    const newPageId = this.#newPageId(pagesBefore);
    return {
      ok: outcome.ok,
      effect: outcome.effect,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
      urlBefore,
      urlAfter: this.#page.url(),
      navigated: navigation.navigated(),
      ...(newPageId === undefined ? {} : { newPageId }),
    };
  }

  async waitForLoadState(state: 'load' | 'domcontentloaded', timeoutMs?: number): Promise<void> {
    await this.#page.waitForLoadState(state, timeoutMs === undefined ? {} : { timeout: timeoutMs });
  }

  /**
   * Waits until neither the network tracker nor the mutation counter has moved for `quietMs`,
   * or until `maxMs` runs out. It never throws for timing reasons: a world it cannot read — which
   * happens while a document is being replaced — counts as activity, not as quiet.
   */
  async settle(quietMs: number, maxMs: number): Promise<{ waitedMs: number; capped: boolean }> {
    const { worlds, activity } = await this.#cdp();
    const frameId = await this.#mainFrameId();
    const started = Date.now();
    let mutations = await this.#mutationCount(worlds, frameId);
    let mutatedAt = Date.now();

    for (;;) {
      const elapsed = Date.now() - started;
      if (elapsed >= maxMs) return { waitedMs: elapsed, capped: true };
      // The last wait is clipped to the budget, so the cap lands on maxMs rather than a whole poll
      // after it: the card asks for maxMs + 50 ms, and an extra poll can be more than that.
      await delay(Math.min(SETTLE_POLL_MS, maxMs - elapsed));

      // Checked again before the reads, which are CDP round trips: on a loaded machine one of them
      // can outlast the whole remaining budget, and the cap has to be honoured rather than
      // reported late.
      const spent = Date.now() - started;
      if (spent >= maxMs) return { waitedMs: spent, capped: true };

      const count = await this.#mutationCount(worlds, frameId);
      if (count === null) {
        mutatedAt = Date.now();
      } else if (count !== mutations) {
        mutations = count;
        mutatedAt = Date.now();
      }

      const now = Date.now();
      const quiet = now - activity.lastChange() >= quietMs && now - mutatedAt >= quietMs;
      if (quiet && activity.inFlight() === 0 && !activity.loading()) {
        return { waitedMs: now - started, capped: false };
      }
    }
  }

  /** How many DOM mutations the page has made in the `bos` world's view of it. */
  async mutationCounter(): Promise<number> {
    const { worlds } = await this.#cdp();
    return (await this.#mutationCount(worlds, await this.#mainFrameId())) ?? 0;
  }

  async #mutationCount(worlds: IsolatedWorlds, frameId: string): Promise<number | null> {
    try {
      return await worlds.mutationCount(frameId);
    } catch {
      return null;
    }
  }

  /** The paths are the runtime's business: it has already checked them against the policy. */
  async uploadFiles(target: ResolvedTarget, paths: string[]): Promise<DriverResult> {
    return await this.#execute(async () => await uploadFiles(this.#page, target, paths));
  }

  async screenshot(): Promise<{ base64: string; mediaType: 'image/png' }> {
    throw this.#notYet('screenshot', 'the vision tier (post-MVP)');
  }

  /** One session per page (§4), and the same one `PageHandle.cdp()` hands out. */
  async #cdp(): Promise<CdpSession> {
    this.#session ??= this.#openTransport()
      .then((transport) => ({
        transport,
        worlds: new IsolatedWorlds(transport),
        activity: trackActivity(transport),
      }))
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

  /** A main-frame navigation seen while an action is running. */
  #watchNavigation(transport: CdpTransport): { navigated: () => boolean; stop: () => void } {
    let navigated = false;
    const off = transport.on('Page.frameNavigated', (payload) => {
      const frame = (payload as { frame?: { parentId?: string } }).frame;
      // The main frame only: a subframe navigating is not the page navigating.
      if (frame !== undefined && frame.parentId === undefined) navigated = true;
    });
    return {
      navigated: () => navigated,
      stop: off,
    };
  }

  /** The page an action opened, when the session has told us which pages it has. */
  #newPageId(before: readonly string[]): string | undefined {
    return this.#knownPageIds?.().find((id) => !before.includes(id));
  }

  /** Polls until `reached`; only the short post-action grace windows use it. */
  async #until(reached: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!reached() && Date.now() < deadline) {
      await delay(ACTION_GRACE_POLL_MS);
    }
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

function needTarget(actionType: string, target: ResolvedTarget | null): ResolvedTarget {
  if (target === null) {
    throw new BosError('INVALID_REQUEST', `A ${actionType} needs a target`, {});
  }
  return target;
}

function needValue(actionType: string, value: string | undefined): string {
  if (value === undefined) {
    throw new BosError('INVALID_REQUEST', `A ${actionType} needs a value`, {});
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

import type { CdpTransport, PageHandle } from '@browser-os/browser';
import { buildObservation, captureRaw, type RawCapture } from '@browser-os/dom';
import type { EventBus, Observation, ObservationIndex } from '@browser-os/protocol';
import type { SessionManager } from '../sessions/session-manager.js';

type RawCaptureFn = (cdp: CdpTransport) => Promise<RawCapture>;

export interface ObserverDeps {
  sessions?: SessionManager;
  events?: EventBus;
  getPage?: (sessionId: string, pageId?: string) => Promise<PageHandle> | PageHandle;
  captureRaw?: RawCaptureFn;
  buildObservation?: typeof buildObservation;
}

export interface CaptureOptions {
  includeText?: boolean;
}

interface CachedEntry {
  observation: Observation;
  index: ObservationIndex;
  mutationCount: number;
  includeText: boolean;
}

export class Observer {
  private readonly sessions?: SessionManager;
  private readonly events?: EventBus;
  private readonly getPageFn?: (sessionId: string, pageId?: string) => Promise<PageHandle> | PageHandle;
  private readonly captureRawFn: RawCaptureFn;
  private readonly buildObservationFn: typeof buildObservation;

  private readonly cachedByPage = new Map<string, CachedEntry>();
  private readonly invalidatedPages = new Set<string>();
  private readonly indicesByPage = new Map<string, ObservationIndex[]>();
  private readonly indicesById = new Map<string, ObservationIndex>();
  private readonly subscribedPages = new Set<string>();

  constructor(deps: ObserverDeps = {}) {
    this.sessions = deps.sessions;
    this.events = deps.events;
    this.getPageFn = deps.getPage;
    this.captureRawFn = deps.captureRaw ?? ((cdp) => captureRaw(cdp as Parameters<typeof captureRaw>[0]));
    this.buildObservationFn = deps.buildObservation ?? buildObservation;
  }

  /**
   * Invalidates cached observation for a page when an action executes or page navigates.
   */
  invalidate(pageId: string): void {
    this.invalidatedPages.add(pageId);
  }

  /**
   * Returns observation index if still held in the last 3 per page for stale-ref healing.
   */
  index(observationId: string): ObservationIndex | undefined {
    return this.indicesById.get(observationId);
  }

  /**
   * Captures an observation and index for a page, reusing cached observation per §10 when valid.
   */
  async capture(
    sessionId: string,
    pageId: string,
    opts: CaptureOptions = {},
  ): Promise<{ observation: Observation; index: ObservationIndex }> {
    const handle = await this.resolvePage(sessionId, pageId);
    await this.ensureNavigatedSubscription(pageId, handle);

    const cached = this.cachedByPage.get(pageId);
    const isInvalidated = this.invalidatedPages.has(pageId);
    const needsTextBypass = opts.includeText && !cached?.includeText;

    // §10 Reuse conditions:
    // 1. No action executed since capture (!isInvalidated)
    // 2. No main-frame navigation since capture
    // 3. Mutation counter unchanged (1 cheap CDP call)
    // 4. includeText requests bypass reuse when cached observation lacks text
    if (cached && !isInvalidated && !needsTextBypass) {
      const currentMutations = await handle.driver().mutationCounter();
      if (currentMutations === cached.mutationCount) {
        return { observation: cached.observation, index: cached.index };
      }
    }

    // Must capture fresh observation
    this.invalidatedPages.delete(pageId);

    const cdp = await handle.cdp();
    const mutationCount = await handle.driver().mutationCounter();
    const raw = await this.captureRawFn(cdp);

    const mainDoc = raw.documents[0];
    const rawTitle = raw.snapshot?.strings?.[mainDoc?.nodes[6]?.backendNodeId ?? 0] ?? '';
    const mainFrame = raw.frames[0];
    const url = mainFrame?.url ?? '';
    const title = rawTitle || 'Page';

    const { observation, index } = this.buildObservationFn(raw, {
      url,
      title,
      sessionId,
      pageId,
      includeText: opts.includeText,
    });

    this.cachedByPage.set(pageId, {
      observation,
      index,
      mutationCount,
      includeText: Boolean(opts.includeText),
    });

    // Keep last 3 indices per page
    let pageIndices = this.indicesByPage.get(pageId);
    if (!pageIndices) {
      pageIndices = [];
      this.indicesByPage.set(pageId, pageIndices);
    }
    pageIndices.push(index);
    this.indicesById.set(observation.id, index);

    if (pageIndices.length > 3) {
      const evicted = pageIndices.shift();
      if (evicted) {
        this.indicesById.delete(evicted.observationId);
      }
    }

    this.events?.emit({
      ts: Date.now(),
      type: 'observation.captured',
      sessionId,
      data: {
        observationId: observation.id,
        url: observation.url,
        elements: observation.elements.length,
        domNodes: observation.stats.domNodes,
        captureMs: observation.stats.captureMs,
        buildMs: observation.stats.buildMs,
        estTokens: observation.stats.estTokens,
      },
    });

    return { observation, index };
  }

  private async resolvePage(sessionId: string, pageId: string): Promise<PageHandle> {
    if (this.getPageFn) {
      return await this.getPageFn(sessionId, pageId);
    }
    if (this.sessions) {
      return this.sessions.page(sessionId, pageId);
    }
    throw new Error('Observer has neither sessions nor getPage configured');
  }

  private async ensureNavigatedSubscription(pageId: string, handle: PageHandle): Promise<void> {
    if (this.subscribedPages.has(pageId)) return;
    this.subscribedPages.add(pageId);

    try {
      const cdp = await handle.cdp();
      cdp.on('Page.frameNavigated', (payload: unknown) => {
        const frame = (payload as { frame?: { parentId?: string | null } })?.frame;
        // Main frame navigation has no parentId
        if (!frame?.parentId) {
          this.invalidate(pageId);
        }
      });
    } catch {
      // In tests without live CDP, continue
    }
  }
}

// The pages of one session (browser-runtime §3).
//
// Keeps the live `PageHandle` behind each `PageInfo`, in the order the pages appeared. That
// order is what "the most recent page" means when the active page goes away.

import type { PageHandle } from '@browser-os/browser';
import type { PageInfo } from '@browser-os/protocol';

/** Told about a page that went away, with the opener it had at that moment. */
export type PageClosedHandler = (pageId: string, openerPageId: string | null) => void;

export class SessionPageRegistry {
  readonly #sessionId: string;
  readonly #handles = new Map<string, PageHandle>();
  readonly #order: string[] = [];
  /** Titles arrive asynchronously while `PageInfo` is plain data, so the last one is cached. */
  readonly #titles = new Map<string, string>();
  readonly #onClosed: PageClosedHandler | undefined;

  constructor(sessionId: string, onClosed?: PageClosedHandler) {
    this.#sessionId = sessionId;
    this.#onClosed = onClosed;
  }

  /** Registers a page once. A page already known is returned as it is. */
  add(handle: PageHandle): PageInfo {
    if (!this.#handles.has(handle.id)) {
      this.#handles.set(handle.id, handle);
      this.#order.push(handle.id);
      void handle
        .title()
        .then((title) => {
          this.#titles.set(handle.id, title);
        })
        .catch(() => {
          // A title is decoration; a page that will not give one is not an error.
        });
      handle.onClose(() => {
        // Read the opener before forgetting the page: the fallback needs it.
        const openerPageId = handle.opener()?.id ?? null;
        this.remove(handle.id);
        this.#onClosed?.(handle.id, openerPageId);
      });
    }
    const info = this.info(handle.id);
    if (info === undefined) throw new Error('page vanished while being registered');
    return info;
  }

  remove(pageId: string): void {
    if (!this.#handles.delete(pageId)) return;
    this.#titles.delete(pageId);
    const at = this.#order.indexOf(pageId);
    if (at !== -1) this.#order.splice(at, 1);
  }

  handle(pageId: string): PageHandle | undefined {
    return this.#handles.get(pageId);
  }

  has(pageId: string): boolean {
    return this.#handles.has(pageId);
  }

  /** The newest page still open, which is the fallback when the active one closes. */
  lastId(): string | null {
    return this.#order.at(-1) ?? null;
  }

  /** A page's `PageInfo`: live url, last known title. */
  info(pageId: string): PageInfo | undefined {
    const handle = this.#handles.get(pageId);
    if (handle === undefined) return undefined;
    return {
      id: pageId,
      sessionId: this.#sessionId,
      url: handle.url(),
      title: this.#titles.get(pageId) ?? '',
      openerPageId: handle.opener()?.id ?? null,
    };
  }

  list(): PageInfo[] {
    const infos: PageInfo[] = [];
    for (const pageId of this.#order) {
      const info = this.info(pageId);
      if (info !== undefined) infos.push(info);
    }
    return infos;
  }
}

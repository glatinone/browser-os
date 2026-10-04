// Page-side extraction, described here and run in the `bos` world (browser-runtime §5).
//
// The caps live on this side rather than in the bundle: the bundle is the same bundle whatever
// the caller wants, while "20k characters" is a decision the driver makes.

export type ExtractFormat = 'text' | 'links' | 'table';

export const MAX_TEXT_CHARS = 20_000;
export const MAX_LINKS = 500;

/**
 * One call into the `bos` world per format. When there is no target the call carries only an
 * `executionContextId`, so `this` is the world's global object — hence the `this === globalThis`
 * branch, which is what lets a single source per format serve both the targeted and the
 * whole-document case.
 */
export const EXTRACTION: Record<ExtractFormat, { source: string; args: readonly unknown[] }> = {
  text: {
    source: 'function (max) { return globalThis.__bos.extractText(this === globalThis ? document.body : this, max); }',
    args: [MAX_TEXT_CHARS],
  },
  links: {
    source: 'function (max) { return globalThis.__bos.extractLinks(this === globalThis ? document : this, max); }',
    args: [MAX_LINKS],
  },
  table: {
    source: 'function () { return globalThis.__bos.extractTable(this === globalThis ? document : this); }',
    args: [],
  },
};

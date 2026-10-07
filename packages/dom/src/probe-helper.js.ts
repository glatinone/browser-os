/**
 * Probe helper source installed into the isolated world (dom-intelligence §8.3).
 * Exported as a string so @browser-os/browser does not import from @browser-os/dom.
 */
export const PROBE_HELPER_SOURCE = `(() => {
  if (typeof globalThis.__bos !== 'object' || globalThis.__bos === null) {
    globalThis.__bos = {};
  }

  function queryShadow(root, selector) {
    const parts = selector.split(/\\s*>>>\\s*/);
    let current = [root];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!part) continue;
      const next = [];
      const isLast = (i === parts.length - 1);
      for (const node of current) {
        if (!node) continue;
        const matches = node.querySelectorAll(part);
        for (const el of matches) {
          if (isLast) {
            next.push(el);
          } else if (el.shadowRoot) {
            next.push(el.shadowRoot);
          }
        }
      }
      current = next;
      if (current.length === 0) break;
    }
    return current;
  }

  globalThis.__bos.probe = (locator) => {
    if (!locator) return null;
    let candidates = [];

    // Strategy 1: [data-testid|data-test|data-qa="..."]
    const attrs = locator.attrs || {};
    const strongAttr = attrs['data-testid'] ? 'data-testid' :
                       attrs['data-test'] ? 'data-test' :
                       attrs['data-qa'] ? 'data-qa' : null;
    if (strongAttr) {
      const val = attrs[strongAttr];
      try {
        const found = document.querySelectorAll('[' + strongAttr + '="' + CSS.escape(val) + '"]');
        if (found.length > 0) candidates = Array.from(found);
      } catch {}
    }

    // Strategy 2: #id (stable ids only)
    if (candidates.length === 0 && attrs.id) {
      try {
        const el = document.getElementById(attrs.id);
        if (el) candidates = [el];
      } catch {}
    }

    // Strategy 3: tag[name="..."]
    if (candidates.length === 0 && attrs.name) {
      const tag = locator.tag || '*';
      try {
        const found = document.querySelectorAll(tag + '[name="' + CSS.escape(attrs.name) + '"]');
        if (found.length > 0) candidates = Array.from(found);
      } catch {}
    }

    // Strategy 4: tag[aria-label="..."]
    if (candidates.length === 0 && attrs['aria-label']) {
      const tag = locator.tag || '*';
      try {
        const found = document.querySelectorAll(tag + '[aria-label="' + CSS.escape(attrs['aria-label']) + '"]');
        if (found.length > 0) candidates = Array.from(found);
      } catch {}
    }

    // Strategy 5: cssPath (with >>> stepping into shadowRoot)
    if (candidates.length === 0 && locator.cssPath) {
      try {
        if (locator.cssPath.includes('>>>')) {
          candidates = queryShadow(document, locator.cssPath);
        } else {
          const found = document.querySelectorAll(locator.cssPath);
          if (found.length > 0) candidates = Array.from(found);
        }
      } catch {}
    }

    // Strategy 6: tag[placeholder="..."]
    if (candidates.length === 0 && attrs.placeholder) {
      const tag = locator.tag || '*';
      try {
        const found = document.querySelectorAll(tag + '[placeholder="' + CSS.escape(attrs.placeholder) + '"]');
        if (found.length > 0) candidates = Array.from(found);
      } catch {}
    }

    const capped = candidates.slice(0, 5);
    if (capped.length === 0) return null;
    if (capped.length === 1) return capped[0];
    return capped;
  };
})();
`;

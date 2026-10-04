/**
 * The helpers the `bos` world gets, as a source string (browser-runtime §4).
 *
 * It is a string because it is installed with `Runtime.evaluate` carrying the isolated
 * world's `contextId`: that is the only thing that puts it inside the world and nowhere
 * else (SECURITY S19). Installing it twice is a no-op, so a cached world can be reused
 * without stacking up `MutationObserver`s.
 *
 * `probe` is a deliberate placeholder that throws rather than return `undefined`, so a
 * caller that arrives before P4-09 fails loudly; the `extract*` helpers arrived with P3-01.
 */
export const HELPERS_BUNDLE = `(() => {
  if (globalThis.__bos !== undefined) return;

  let mutations = 0;
  const observer = new MutationObserver((records) => {
    mutations += records.length;
  });
  observer.observe(document, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true,
  });

  globalThis.__bos = {
    mutationCount: () => mutations,
    readValue: (element) => {
      if (element === null || element === undefined) return null;
      const tag = element.tagName;
      if (tag === 'INPUT') {
        const type = String(element.type ?? '').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return element.checked ? 'true' : 'false';
        return element.value ?? null;
      }
      if (tag === 'SELECT' || tag === 'TEXTAREA') return element.value ?? null;
      if (element.isContentEditable === true) return element.textContent ?? null;
      return null;
    },
    probe: () => {
      throw new Error('__bos.probe is not implemented yet (P4-09)');
    },
    extractText: (element, max) => {
      const target = element ?? document.body;
      const text = target.innerText ?? '';
      return text.length > max ? text.slice(0, max) : text;
    },
    extractLinks: (element, max) => {
      const scope = element ?? document;
      const links = [];
      for (const anchor of scope.querySelectorAll('a[href]')) {
        if (links.length >= max) break;
        links.push({ text: (anchor.innerText ?? '').trim(), href: anchor.href });
      }
      return links;
    },
    extractTable: (element) => {
      const scope = element ?? document;
      const table = scope.tagName === 'TABLE' ? scope : scope.querySelector('table');
      if (table === null) return [];
      const rows = [];
      for (const tr of table.querySelectorAll('tr')) {
        const cells = [];
        for (const cell of tr.querySelectorAll('th, td')) cells.push((cell.innerText ?? '').trim());
        rows.push(cells);
      }
      return rows;
    },
  };
})();
`;

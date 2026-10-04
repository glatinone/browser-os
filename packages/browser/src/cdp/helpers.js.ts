/**
 * The helpers the `bos` world gets, as a source string (browser-runtime §4).
 *
 * It is a string because it is installed with `Runtime.evaluate` carrying the isolated
 * world's `contextId`: that is the only thing that puts it inside the world and nowhere
 * else (SECURITY S19). Installing it twice is a no-op, so a cached world can be reused
 * without stacking up `MutationObserver`s.
 *
 * `probe` and `extract` are deliberate placeholders that throw rather than return
 * `undefined`, so a caller that arrives before P4-09 / P3-01 fails loudly.
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
    extract: () => {
      throw new Error('__bos.extract is not implemented yet (P3-01)');
    },
  };
})();
`;

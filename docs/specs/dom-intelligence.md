# Spec: DOM Intelligence (`packages/dom`)

**Status:** Authoritative for MVP · **Owner package:** `@browser-os/dom`
**Related:** ADR-009, `specs/data-models.md` §4, `specs/action-router.md` §5

`@browser-os/dom` turns a live page (reached through a `CdpTransport`) into a compact `Observation`. It also creates and resolves durable `ElementLocator`s. Everything except the capture step is **pure functions over plain data**, so it can be unit-tested with recorded CDP fixtures and no browser.

```
packages/dom/src/
├── capture.ts          §2  CDP calls → RawCapture (only module that talks to CDP)
├── join.ts             §3  RawCapture → NodeTable (DOM + layout + AX joined by backendNodeId)
├── interactive.ts      §4  interactivity rules
├── visibility.ts       §5  visibility + viewport + modal scoping
├── semantic.ts         §6  NodeTable → SemanticElement[] + TextBlock[] + frames
├── serialize.ts        §6.4 compact line format + token estimate
├── lexical.ts          §7  intent → ranked elements (deterministic tier)
├── locator.ts          §8  ElementLocator build + match + cssPath
├── probe.ts            §8.3 fast cached-target probe (talks to CDP)
├── challenge.ts        §9  login/captcha/mfa detection
├── normalize.ts        shared text normalization
└── index.ts
```

---

## 1. Design goals

1. **Never send raw HTML to a model.** Typical output: 20–200 interactive elements, ≤ 4k tokens. LLM prompts receive at most `llmCandidates` (30) elements, ≈ 0.6–1.2k tokens.
2. **Structured over visual.** Use the browser's own computed accessibility tree and layout, not screenshots.
3. **No page-world tampering.** Read via CDP. Helper scripts run only in an isolated world named `bos`. Never add attributes to the page DOM.
4. **Deterministic and testable.** Same RawCapture in → same Observation out (golden tests).
5. **Fast enough.** Targets in PERFORMANCE.md: fixture pages p50 < 150 ms total, heavy pages measured and reported.

**Why not Playwright `ariaSnapshot({mode:'ai'})`?** It is a good public API, but it does not give us backendNodeIds (needed by the CDP executor), stable attributes, or css paths (needed for durable locators), and its refs are tied to Playwright's internal state. We use it as a **test oracle** for role/name correctness (task P4-10), not as the production path. See ADR-009.

---

## 2. Capture (`capture.ts`)

Input: a `CdpTransport` for the page's main target, and the frame list from the browser package. Output: `RawCapture` (plain JSON).

CDP calls, issued **concurrently** (single `Promise.all`):

| Call | Purpose |
|---|---|
| `DOMSnapshot.captureSnapshot({ computedStyles: ['display','visibility','opacity','pointer-events','cursor','position'], includePaintOrder: true, includeDOMRects: true })` | flattened DOM for the main document **and same-process iframes**, with layout bounds, styles, `isClickable`, `inputValue`, `inputChecked`, `optionSelected`, shadow roots |
| `Accessibility.getFullAXTree({})` (and once per same-process child frame with `frameId`) | computed role, accessible name, value, states; `backendDOMNodeId` join key |
| `Page.getLayoutMetrics()` | viewport (`cssVisualViewport`) |
| `Page.getFrameTree()` | frame ids, urls, names |

Rules:
- Enable `DOM`, `DOMSnapshot`, `Accessibility`, `Page` once per CDP session (the browser package does this when it creates the session; capture assumes they are enabled).
- Out-of-process iframes (OOPIF): **MVP records them as `FrameInfo{outOfProcess:true}` with no elements.** Full OOPIF support (child sessions via `Target.setAutoAttach` + coordinate offsets) is task P11-02.
- **Per-frame failure isolation:** if the AX call for a child frame fails or exceeds `FRAME_AX_TIMEOUT_MS = 1500`, drop that frame's subtree, keep the rest, and add a warning to `Observation.warnings`. Never fail the whole capture because one iframe misbehaves.
- **Document-identity guard (staleness):** record each frame's `documentElement` backendNodeId before capture (`DOM.getDocument({depth:0})`) and re-check after. If it changed (navigation mid-capture), re-capture once. If it changes again, return the capture with that frame omitted and a warning. (Learned from BrowserSkill `document-identity.ts`.)
- Large-page guard: if `DOMSnapshot` returns more than `LARGE_PAGE_NODES = 15000` nodes, the AX tree is still fetched, but the result is flagged `stats.large = true` (benchmarks track it). Partial AX fetching is a Phase 11 optimization (P11-04), gated by benchmark evidence.
- Recorded fixtures: `capture.ts` exports `captureRaw(cdp)`. Tests use JSON files in `packages/dom/test/fixtures/*.raw.json` produced by `scripts/record-capture.ts` (task P4-02) against `fixtures/sites`.

---

## 3. Join (`join.ts`)

Build a `NodeTable`: one row per DOM element node (nodeType 1) across all snapshot documents:

```ts
interface NodeRow {
  idx: number;                 // global index in document order (documents concatenated with iframe docs inlined at their host)
  backendNodeId: number;
  docIndex: number;            // snapshot document index
  frameId: string;             // CDP frame id of the document
  parentIdx: number | null;
  tag: string;                 // lowercase
  attrs: Record<string, string>;
  shadowHostIdx: number | null;   // set when the node lives inside a shadow root
  bounds: Rect | null;         // from layout (document coordinates → converted to viewport coordinates)
  styles: { display?: string; visibility?: string; opacity?: string; pointerEvents?: string; cursor?: string; position?: string };
  paintOrder: number | null;
  isClickable: boolean;        // DOMSnapshot rare boolean (click listeners or native navigation)
  inputValue?: string;
  inputChecked?: boolean;
  ax?: { role: string; name: string; value?: string; ignored: boolean; props: Record<string, unknown> };
}
```

- Join AX nodes to DOM rows by `backendDOMNodeId`.
- Iframe documents: compute each iframe document's offset from its host element's bounds so all rects are in **top-level viewport coordinates** (subtract `cssVisualViewport.pageX/pageY` for the scroll position).
- Text nodes (nodeType 3) are kept in a side table `texts: { parentIdx, text }[]` for §6.3.

---

## 4. Interactivity (`interactive.ts`)

A row is **interactive** if it is not excluded and any of these hold:

1. `tag` ∈ { `button`, `select`, `textarea`, `summary` } or (`tag == 'a'` and has `href`) or (`tag == 'input'` and `type != 'hidden'`)
2. `ax.role` ∈ `INTERACTIVE_ROLES` = { button, link, textbox, searchbox, combobox, listbox, checkbox, radio, switch, slider, spinbutton, tab, menuitem, menuitemcheckbox, menuitemradio, option (only when its listbox is visible and not a native `<select>`), treeitem }
3. `attrs.contenteditable` ∈ { "", "true", "plaintext-only" } (only the topmost editable ancestor)
4. `isClickable` and (`styles.cursor == 'pointer'` or `attrs.tabindex >= 0` or has an explicit `role`)
5. `attrs.tabindex` parses to ≥ 0 and `ax.props.focusable`

Excluded:
- `ax.ignored` **and** none of rules 1 or 3 apply
- descendants of an interactive element that would produce the **same action** with no new name (e.g. `<span>` inside `<button>`): if a row is inside an interactive ancestor and its accessible name is empty or contained in the ancestor's name, drop it. Exception: different roles (a checkbox inside a clickable row is kept).
- `<option>` of native `<select>`: not emitted as elements. The select's options go into `value`/`description` as `options: a | b | c` (first 10).

---

## 5. Visibility (`visibility.ts`)

A row is **visible** if all hold:
- `bounds` exists, `w ≥ 1` and `h ≥ 1` (exception: native checkbox/radio with a visible associated `<label>`; it is kept and its rect becomes the label's rect)
- `display != 'none'`, `visibility` ∉ { hidden, collapse }
- `opacity != '0'` (same checkbox/radio exception)
- no ancestor has `display:none` (DOMSnapshot omits layout for these; missing layout ⇒ invisible)

`inViewport` = rect intersects the viewport rectangle (0,0,clientWidth,clientHeight).

Elements outside the viewport are kept (agents scroll). The serializer can be told `viewportOnly`.

**Modal scoping:** if the AX tree contains a visible node with role `dialog` or `alertdialog` and `ax.props.modal == true` (or attribute `aria-modal="true"`), only elements inside the **topmost** such dialog (highest paint order) are emitted, and `Observation.dialogs` lists dialog names topmost first. General paint-order occlusion filtering (like Browser Use's) is a Phase 11 optimization (P11-05). In MVP, occlusion is caught by the executor's hit-test (`TARGET_OBSCURED`).

---

## 6. Semantic output (`semantic.ts`, `serialize.ts`)

### 6.1 Element fields

For each visible interactive row, in global document order:

| Field | Rule |
|---|---|
| `ref` | `e1`, `e2`, … in order |
| `role` | `ax.role` unless it is `generic`/`none`/empty, else from tag: a→link, button→button, select→combobox, textarea→textbox, input[type=checkbox]→checkbox, radio→radio, range→slider, number→spinbutton, search→searchbox, submit/button/reset/image→button, other input→textbox, contenteditable→textbox, else `generic` |
| `name` | `ax.name`, else first non-empty of `aria-label`, `placeholder`, `title`, `alt`, `value` (buttons only), trimmed visible text of descendants. Collapse whitespace, max 120 chars (`…` suffix) |
| `value` | `ax.value` or `inputValue`; omitted if empty; `"••••"` if `type=password` or `isSensitiveField()` (from `@browser-os/protocol`, integration §2) |
| `placeholder`, `inputType`, `href` | from attrs (`href` normalized per data-models §4) |
| `description` | `ax.props.description` or `title` if different from name |
| `state` | from AX props: disabled, checked, expanded, selected, focused, required, readonly; `editable` for textbox-like and contenteditable |
| `rect` | viewport rect rounded to integers |
| `frame` | `f0` for main document; child frames `f1..` in document order of their host iframe |
| `context` | up to 2 nearest ancestors whose AX role ∈ { dialog, alertdialog, navigation, banner, main, search, form, region, complementary, contentinfo, menu, menubar, tablist, toolbar, group (named only), row (named only) }, formatted `role` or `role:name` (name ≤ 40 chars), nearest first |

### 6.2 Frames

`Observation.frames` lists every frame in the frame tree (including OOPIFs, flagged). `id` is `f<n>`.

### 6.3 Text blocks (only when `includeText: true`)

Group visible text by nearest block ancestor with role heading/paragraph/listitem/cell/status/alert (else `text`). Merge adjacent text; max 300 chars per block; stop when total text exceeds `maxTextChars` (default 4000). Refs `t1..tN`. Used by `extract` and by agents reading content.

### 6.4 Serialization (`serialize.ts`)

Two formats from the same data:

- **JSON**: the `Observation` object (protocol/SDK consumers).
- **Compact lines** (CLI output and LLM prompts). One element per line:

```
<ref> <role> "<name>"[ placeholder="…"][ value="…"][ (disabled)][ (checked)][ (expanded)][ ↓offscreen] [<context joined with " > ">]
```

Header lines: `url`, `title`, `dialogs`, optional `challenge`. `estTokens = ceil(chars / 4)`.

### 6.5 Before / after example

Raw (simplified; the real page has ~4,000 DOM nodes and ~250 KB of HTML):

```html
<header class="global-nav">
  <div class="search-global-typeahead">
    <input class="search-global-typeahead__input" placeholder="Search" role="combobox"
           aria-autocomplete="list" aria-expanded="false" type="text" aria-label="Search">
  </div>
  <nav aria-label="Primary Navigation">
    <ul>
      <li><a href="/feed/" class="app-aware-link"><svg>…</svg><span class="t-12">Home</span></a></li>
      <li><a href="/mynetwork/"><svg>…</svg><span>My Network</span></a></li>
      <li><a href="/messaging/"><svg>…</svg><span>Messaging</span><span class="badge">3</span></a></li>
    </ul>
  </nav>
  <button class="artdeco-button" aria-label="Me" aria-expanded="false"><img alt="Jane Doe"></button>
</header>
<div class="modal-overlay" style="display:none">…</div>
```

After (compact lines, ~70 tokens instead of thousands):

```
url: https://www.linkedin.com/feed/
title: Feed | LinkedIn
dialogs: none
e1 combobox "Search" placeholder="Search" [banner]
e2 link "Home" [navigation:Primary Navigation > banner]
e3 link "My Network" [navigation:Primary Navigation > banner]
e4 link "Messaging 3" [navigation:Primary Navigation > banner]
e5 button "Me" [banner]
```

---

## 7. Lexical ranking: the deterministic tier (`lexical.ts`)

`lexicalRank(elements, intent, actionType): { element, score }[]` sorted by score descending. Pure function.

1. **Filter** elements with `isCompatible(element, actionType)` (action-router §5).
2. **Normalize intent** (`normalize.ts`): lowercase; extract quoted substrings (`"…"` or `'…'`) as `exact`; strip leading verbs {click, press, tap, select, choose, open, type, fill, enter, hover, check, uncheck}; remove stop words {the, a, an, this, that, on, in, into, to, of, for, with, at, please}; extract **role hints**:

| Hint words | Roles |
|---|---|
| button, btn | button |
| link | link |
| search box, search field, search bar | searchbox, combobox, textbox + `searchBonus` |
| field, input, box, textbox, text box | textbox, searchbox, combobox, spinbutton |
| checkbox, check box | checkbox |
| radio | radio |
| dropdown, select, combo, combobox | combobox, listbox |
| tab | tab |
| menu item, menu | menuitem, button(with expanded state) |
| toggle, switch | switch, checkbox |

   Remaining words = `tokens`.
3. **Element text**: `nameN = normalizeName(name)` (lowercase, collapse whitespace, digits-runs → `#`), plus `aux` = placeholder, aria-label, title, description; `ctx` = context strings.
4. **Score** in [0,1]:

```
nameScore    = 1.0 if exact != null and nameN == normalizeName(exact)
             = 1.0 if join(tokens) == nameN
             = dice(tokens, tokenize(nameN)) otherwise        // Sørensen–Dice on tokens; prefix match counts if len ≥ 4
auxScore     = max dice(tokens, tokenize(aux_i))
roleScore    = 1.0 if role ∈ hintedRoles; 0.5 if no hint given; 0.0 if hint given and role ∉ hintedRoles
contextScore = max dice(tokens, tokenize(ctx_i))
viewScore    = 1.0 if inViewport else 0.0

score = 0.55*nameScore + 0.15*auxScore + 0.20*roleScore + 0.05*contextScore + 0.05*viewScore
if exact != null and nameN != normalizeName(exact): score = min(score, 0.5)
if searchBonus and (nameN contains "search" or placeholder contains "search" or role == searchbox): score += 0.1 (cap 1.0)
```

5. Ties broken by document order.

Acceptance (in the router): best ≥ `lexicalAccept` (0.75) **and** margin ≥ `lexicalMargin` (0.15). The constants are tuned with `fixtures/sites/*/truth.json`; deterministic-tier **precision must stay ≥ 99%** on fixtures. Coverage may be lower; the LLM catches the rest.

---

## 8. Locators: durable element identity (`locator.ts`, `probe.ts`)

### 8.1 Building a locator

`buildLocator(row, element, nodeTable, { params })` → `ElementLocator` (data-models §4):

- `role`, `tag`, `context` from the element.
- `name`: if any **param value** of the current task (case-insensitive, length ≥ 3) occurs in the name → `nameIsDynamic = true`, `name = ""`. Otherwise `name = element.name`.
- `attrs`: copy `StableAttr` keys present on the node. **Drop unstable ids** matching any of: `/\d{4,}/`, `/[0-9a-f]{8,}/i`, `/^:r[0-9a-z]+:$/`, `/^(ember|react|vue|ng|mui|radix|headlessui)[-_]?\d*/i`, `/^[a-z]{1,3}\d+$/i`. Drop `href` query strings.
- `cssPath`: §8.2.
- `framePath`: for each ancestor frame from top to the element's frame: `iframe[name="…"]` if name, else `iframe[src^="<origin+path of src>"]`, else `iframe:nth-of-type(k)`.
- `ordinal`: index among elements of the same observation with equal `role` and `normalizeName(name)`.

Locators **never** contain typed values (`value` is not part of the locator).

### 8.2 cssPath

From the element upward within its tree scope:
- if the node has a stable `id` → `#id` and stop
- else if it has `data-testid`/`data-test`/`data-qa` → `[data-testid="…"]` and stop
- else `tag` plus `:nth-of-type(k)` when siblings share the tag
- join with ` > `; at most 8 segments (keep the nearest 8)
- crossing a shadow root: the host's path, then ` >>> `, then the path inside the shadow tree

### 8.3 Probe (fast path for cached targets)

`probe(cdp, locator): Promise<ProbeCandidate[]>` (main frame only in MVP; `framePath.length > 0` returns `[]` so the router falls through to full matching).

1. In the `bos` isolated world, call a helper (`Runtime.callFunctionOn`) that returns up to 5 candidate elements, trying strategies **in order** and stopping at the first strategy that finds ≥ 1 element:
   1. `[data-testid|data-test|data-qa="…"]`
   2. `#id` (stable ids only)
   3. `tag[name="…"]`
   4. `tag[aria-label="…"]`
   5. `cssPath` (with ` >>> ` handled by stepping into `shadowRoot`)
   6. `tag[placeholder="…"]`
2. For each candidate (concurrently): `DOM.describeNode` → backendNodeId; `Accessibility.getPartialAXTree({ backendNodeId, fetchRelatives: false })` → role, name, disabled; `DOM.getBoxModel` → rect (failure ⇒ invisible).
3. Return `{ backendNodeId, role, name, rect, disabled }[]`.

Budget: single-candidate probe ≤ 4 CDP round trips. Measured in `benchmarks/micro/probe.bench.ts`.

### 8.4 Matching

`matchLocator(observation, index, locator): { ref, score }[]` and `verifyIdentity(candidate, locator): number`. Score in [0,1]:

| Signal | Weight | Applies when |
|---|---|---|
| role equal (1.0) / compatible group (0.6) / else 0 | 0.25 | always |
| name: normalized equal (1.0) / dice | 0.30 | `!nameIsDynamic` |
| strong attr equal (`data-testid`/`data-test`/`data-qa`) | 0.25 | locator has one |
| `id` equal | 0.15 | locator has stable id |
| `name` attr equal | 0.10 | locator has it |
| `placeholder` / `aria-label` / `href` path equal | 0.05 each | locator has it |
| context overlap (any equal entry) | 0.10 | locator has context |
| cssPath equal | 0.05 | always |
| ordinal equal | 0.02 | always |

`score = Σ(weight × signal) / Σ(weights that apply)`. Compatible role groups: {textbox, searchbox, combobox}, {button, link, menuitem}, {checkbox, switch, menuitemcheckbox}, {radio, menuitemradio}, {listbox, combobox}. Hard rules: role signal 0 ⇒ score capped at 0.5; frame path mismatch ⇒ score 0; disabled candidate for click/fill ⇒ score capped at 0.5.

`verifyIdentity` uses the same formula with whatever fields the probe returned (role, name, attrs used by the strategy); context and cssPath weights are excluded from the denominator.

---

## 9. Security challenge detection (`challenge.ts`)

`detectChallenge(observation, nodeTable): ChallengeKind | null`. Deterministic heuristics, evaluated on every capture:

| Kind | Signal (any) |
|---|---|
| `captcha` | iframe src matches `/recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha/i`; or visible element whose id/class/name contains `captcha` |
| `mfa` | input with `autocomplete="one-time-code"`; or input name/id/aria-label matching `/otp|one.?time|2fa|mfa|verification.?code|security.?code/i`; or text block on a known IdP host matching `/approve sign.?in|enter (the )?code|authenticator/i` |
| `passkey` | text on page matching `/passkey|security key|use your (face|fingerprint)/i` on an IdP host |
| `login` | visible `input[type=password]`; or host ∈ IdP list (`login.microsoftonline.com`, `login.live.com`, `accounts.google.com`, `*.okta.com`, `*.auth0.com`, `*.onelogin.com`, `idp.*`, `sso.*`) |
| `consent` | IdP host and text matching `/wants to access|permissions requested|grant access/i` |

Priority when several match: captcha > mfa > passkey > consent > login.

The router pauses for a human on any challenge (SECURITY.md §6). Browser-OS never fills password, OTP or CAPTCHA fields itself in MVP.

---

## 10. Observation reuse and invalidation

The `Observer` (runtime) keeps the latest `Observation` + `ObservationIndex` per page and **reuses** it when all hold:
- no action has executed on that page since capture
- no main-frame navigation since capture (`Page.frameNavigated`)
- the isolated-world mutation counter (a `MutationObserver` counting childList/attributes/characterData changes on `document`) is unchanged (one cheap `Runtime.evaluate`)

Otherwise it re-captures. Refs from a replaced observation become stale (the router heals them, action-router §5).

---

## 11. Test requirements (summary)

- Golden tests: each fixture page `fixtures/sites/<name>/index.html` → recorded `*.raw.json` → expected `*.observation.txt` (compact lines). Update goldens only intentionally (`pnpm test -u`) and review diffs.
- Interactivity/visibility unit tests per rule (§4, §5) using minimal hand-written NodeTables.
- Lexical ranking against `fixtures/sites/*/truth.json`: precision ≥ 99% at acceptance thresholds.
- Locator: build/match round trip; robustness suite (`fixtures/sites/mutations/`): same page with changed classes, reordered siblings, changed text counts ("Messages 3" → "Messages 7"), added wrappers, renamed unstable ids → the correct element must still score best with margin.
- Probe: browser test on fixture site; ≤ 4 round trips (counted by a CdpTransport wrapper).
- Challenge: fixtures for each kind plus negatives (normal search page with "code" in text ≠ mfa).
- Oracle test (P4-10): role/name of emitted elements agree with Playwright `ariaSnapshot({mode:'ai'})` on fixture pages for ≥ 95% of elements.

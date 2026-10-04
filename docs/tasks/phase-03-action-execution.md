# Phase 3: Action execution (`packages/browser/src/driver`)

Read first: `docs/specs/browser-runtime.md` §5–6, `docs/specs/action-router.md` §4.1 (effect semantics) and §6–7.

---

## P3-01 · PageDriver skeleton, navigate, readValue, extract

| Field | Value |
|---|---|
| depends_on | P2-03, P2-04 |
| supervision | cheap-ok |
| size | M |
| spec | browser-runtime §5 |

**Files:** `packages/browser/src/driver/page-driver.ts` (class `DefaultPageDriver implements PageDriver`), `driver/extract.ts`, `driver/resolve-css.ts` (test utility exported for e2e: CSS → `ResolvedTarget` via `DOM.getDocument` + `DOM.querySelector` + `DOM.describeNode`), tests `test/driver-basic.browser.test.ts`.

**Requirements**
1. `navigate(url, timeoutMs)` uses Playwright `page.goto(url, { waitUntil: 'domcontentloaded', timeout })`. Returns `DriverResult` with `navigated: true`. A `chrome-error://` final URL or a goto error → `NAVIGATION_FAILED` (`effect: 'unknown'` if the request was sent, else `'none'`).
2. `readValue(target)`: in the `bos` world (via `DOM.resolveNode({ backendNodeId, executionContextId })` + `Runtime.callFunctionOn`), returns `value` for inputs/textarea/select and `innerText` for contenteditable.
3. `extract(target|null, format)`:
   - `text`: visible `innerText` of the target or of `document.body`, max 20,000 chars
   - `links`: `{ text, href }[]` (max 500)
   - `table`: the first `<table>` within the target as `string[][]`
4. Every other method throws `BosError('INTERNAL', 'not implemented')` until P3-02..P3-06.

**Tests (browser, fixture `basic`):** navigate ok; navigate to a closed port → `NAVIGATION_FAILED`; readValue after typing via Playwright; extract text, links and table.

**Acceptance criteria**
- [x] All page-side JS runs in the `bos` world

**Implementation notes**
- `resolve-css.ts` also calls `Page.getFrameTree`, which the card did not list. `DOM.describeNode`
  reports a `frameId` only for frame-owner elements, and that is the frame they *contain* — the
  target is the element itself, so the right frame is the one we query in. Taking `node.frameId`
  made every ordinary element look like it had no frame.
- The extraction itself lives in the helper bundle (`__bos.extractText` / `extractLinks` /
  `extractTable`), replacing the placeholder P2-03 left for this task; `driver/extract.ts` owns
  the caps and the world call. One source per format serves both cases — targeted and
  whole-document — because a call with no target carries only an `executionContextId`, which
  makes `this` the world's global object.
- `navigate` decides `effect` from what it knows: a url it cannot send at all is `'none'`
  (nothing left the process), anything else that fails is `'unknown'`. A closed port arrived
  through the `'unknown'` path (`chrome-error://` final url), measured on fixture-less localhost.
- `readValue` binds the node with `DOM.resolveNode` inside the `bos` world, so the call doubles
  as an existence check: a node from an older observation is `STALE_REF`, not a silent `null`.
- The driver shares the page's CDP session (`PageHandle.driver()` passes `() => this.cdp()`),
  so §4's "one session per page" still holds with a driver in the picture.
- The remaining methods throw `INTERNAL` naming the task that fills them (P3-02 .. P3-06, and
  the vision tier for `screenshot`), as the card asks.
- Drive-by, not part of this card: the P2-02 Windows profile-lock test spawned `powershell` by
  name and never listened for the spawn's `error` event, so a worker that cannot resolve it got
  an uncaught `ENOENT` and then sat out its 20 s poll budget until the timeout. It now spawns the
  interpreter by full path and reports a failed spawn as a failure; its timeout also covers the
  budget it asks for rather than the default 5 s.
- Note for local runs: the tests import `@browser-os/browser` from `dist`, so `pnpm build` has to
  run first. The documented order (`pnpm build && pnpm -r typecheck && pnpm lint && pnpm test`)
  already says so, and CI builds before testing.

---

## P3-02 · CDP click and hover with hit-test and effect semantics

| Field | Value |
|---|---|
| depends_on | P3-01 |
| supervision | **expert** |
| size | M |
| spec | action-router §6; browser-runtime §5 (hit-test acceptance); action-router §4.1 |

**Files:** `packages/browser/src/driver/cdp-pointer.ts`, test `test/cdp-pointer.browser.test.ts`.

**Requirements**
1. `cdpClick(cdp, target, { button, clickCount })` and `cdpHover(...)`:
   1. `DOM.scrollIntoViewIfNeeded({ backendNodeId })`
   2. `DOM.getContentQuads({ backendNodeId })`. No quads → `TARGET_NOT_INTERACTABLE`, `effect: 'none'`.
   3. Pick the centre of the largest quad that intersects the viewport (`Page.getLayoutMetrics`).
   4. Hit-test with `DOM.getNodeForLocation({ x, y, includeUserAgentShadowDOM: true })`. Accept if the returned `backendNodeId` is the target, a descendant (walk up with `DOM.describeNode` parent ids, max 30 levels; a shadow host counts as an ancestor), or (for checkbox/radio) inside an associated label. Otherwise → `TARGET_OBSCURED`, `effect: 'none'`.
   5. `Input.dispatchMouseEvent` `mouseMoved`, then (click only) `mousePressed` and `mouseReleased` with `clickCount`. If an error happens after `mousePressed` was sent → `effect: 'unknown'`.
2. Wire the results into `cdpPerform` for `click`/`hover`. Fill `urlBefore`/`urlAfter`/`navigated` (main-frame `Page.frameNavigated` observed during the call) and `newPageId` (via the session's onPage within 500 ms, through an injected callback).

**Tests (browser):**
- click the button on `basic` (form submit observed)
- double click
- right click
- hover reveals a menu (add a hover menu to `basic` if missing)
- disabled button: clicking it dispatches and nothing happens (not an error)
- `overlay`: the covered button → `TARGET_OBSCURED`, `effect: 'none'`
- a checkbox whose native input is opacity 0 behind a label → click accepted via the label
- a button inside an open shadow root clicks fine
- a target scrolled out of view is scrolled and clicked

**Acceptance criteria**
- [ ] `effect` correct in every test
- [ ] L4 measured once and printed in the test output (informational)

---

## P3-03 · CDP fill, press, select, scroll

| Field | Value |
|---|---|
| depends_on | P3-02 |
| supervision | cheap-ok |
| size | M |
| spec | action-router §6 table |

**Files:** `packages/browser/src/driver/cdp-keyboard.ts`, `driver/cdp-form.ts`, test `test/cdp-form.browser.test.ts`.

**Requirements**
1. `fill`: `DOM.focus` → select all (bos-world `el.select()` for inputs/textarea; for contenteditable, a `Range` over its contents) → `Input.insertText({ text })` → verify via `readValue`. On mismatch: bos-world native value setter (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set`), then dispatch `input` and `change` events, then verify again. Still mismatched → `VERIFICATION_FAILED` (`effect: 'committed'`). If `submit` → `press Enter` afterwards.
2. `press`: `Input.dispatchKeyEvent` `keyDown` (with `text` for printable single chars) and `keyUp`. Support Playwright-style combos `Control+A`, `Shift+Tab`, `Meta+Enter` (modifiers bitmask). Key definitions: a small table for Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space and single characters.
3. `select`: bos-world function that matches an option by `value` first, then by trimmed label (case-insensitive), sets `selected`, and dispatches `input` + `change`. No match → `TARGET_NOT_FOUND`, `effect: 'none'`.
4. `scroll`: `Input.dispatchMouseEvent` `mouseWheel` at the target centre (or viewport centre), `deltaY = ±amountPx` (default 600).

**Tests (browser):** fill input/textarea/contenteditable (fixture `contenteditable`); fill with submit; press combos; select by value and by label; scroll moves `window.scrollY`; fill on a React-style controlled input (add a tiny controlled-input simulation to `basic` that resets the value unless an `input` event fires).

**Acceptance criteria**
- [ ] All MVP action types except navigate/wait are executable via CDP

---

## P3-04 · Playwright fallback executor and `locatorFor`

| Field | Value |
|---|---|
| depends_on | P3-01 |
| supervision | cheap-ok |
| size | S |
| spec | action-router §6 (`locatorFor` order) |

**Files:** `packages/browser/src/driver/playwright-executor.ts`, `driver/locator-for.ts`, tests `test/locator-for.test.ts` (unit, with a fake Playwright-like page object), `test/playwright-executor.browser.test.ts`.

**Requirements**
1. `locatorFor(page, locator)` builds a Playwright locator in the order given by the spec: data-test attrs → `getByRole(role, { name, exact: true })` when `!nameIsDynamic` → `#id` → `cssPath` (replace ` >>> ` with ` ` since Playwright CSS pierces open shadow roots), applying `frameLocator` for each `framePath` entry, then `.nth(ordinal)` if `count() > 1`.
2. `playwrightPerform(action, target, value)`: click/hover/fill/press/select/scroll via Playwright with `timeout: 2000`. Map Playwright timeouts to `TARGET_NOT_INTERACTABLE` with `effect: 'none'` when Playwright reports it never performed the action ("waiting for element to be visible/enabled/stable/receive events"). Map other errors to `effect: 'unknown'`.

**Tests:** unit order-of-strategies tests; browser: on `overlay` the Playwright click succeeds after the overlay disappears; fill/select via fallback.

**Acceptance criteria**
- [ ] Playwright types do not leave `packages/browser`

---

## P3-05 · Settle

| Field | Value |
|---|---|
| depends_on | P3-01 |
| supervision | cheap-ok |
| size | S |
| spec | action-router §7; browser-runtime §5 |

**Files:** `packages/browser/src/driver/settle.ts`, test `test/settle.browser.test.ts`.

**Requirements**
1. A per-page network tracker started when the page CDP session is created. It counts in-flight requests whose `type` ∈ {Document, XHR, Fetch} using `Network.requestWillBeSent` / `loadingFinished` / `loadingFailed`, and tracks the time of the last change.
2. `settle(quietMs, maxMs)` polls every 25 ms the network tracker and the mutation counter (`IsolatedWorlds` helper). It returns when both have been unchanged for `quietMs` and no main-frame navigation is in progress, or at `maxMs` (`capped: true`).
3. Never throws for timing reasons.

**Tests:** page that fetches `/slow?ms=300` after a click → settle waits ≥ 300 ms; a page with constant `setInterval` DOM mutations → returns at `maxMs` with `capped: true`; a static page → returns in ≈ `quietMs`.

**Acceptance criteria**
- [ ] Returns within `maxMs + 50 ms` in all tests

---

## P3-06 · Uploads and downloads

| Field | Value |
|---|---|
| depends_on | P3-01 |
| supervision | cheap-ok |
| size | S |
| spec | browser-runtime §6; SECURITY.md §11 |

**Files:** `packages/browser/src/driver/files.ts`, test `test/files.browser.test.ts`.

**Requirements**
1. `uploadFiles(target, paths)`: Playwright `setInputFiles` on `locatorFor(target.locator)`. Path policy is **not** checked here (the runtime does it in P9-07). Paths must already be absolute.
2. Downloads: `enableDownloads(dir | null)`. With a dir, save each Playwright `download` to `<dir>/<sanitized suggested filename>` (strip path separators and control chars; on collision append ` (n)`). With `null`, cancel downloads. Emit via the callback `onDownload({ path })`.

**Tests:** fixture `upload` echoes the filename; `/download/sample.txt` is saved when enabled and cancelled when disabled; filename sanitization unit test.

**Acceptance criteria**
- [ ] No download is written anywhere unless enabled

---

## P3-07 · Milestone M1 e2e: "Hands"

| Field | Value |
|---|---|
| depends_on | P2-07, P3-02, P3-03, P3-04, P3-05 |
| supervision | cheap-ok |
| size | S |
| spec | ROADMAP M1; TESTING.md (M1 row) |

**Files:** `tests/e2e/hands.e2e.test.ts`.

**Scenario:**
1. `withTempBosHome` + fixture server
2. SessionManager + LaunchProvider (headless)
3. Open profile `hands`
4. Navigate to `basic`
5. Fill name and email via CDP (targets resolved with `resolve-css.ts`)
6. Select the country
7. Check the newsletter checkbox
8. Click submit
9. Assert the `/echo` JSON contains the values
10. Set a cookie
11. Close the session, reopen it, and assert the cookie persisted
12. Overlay page: the CDP click gets `TARGET_OBSCURED`, then the Playwright fallback succeeds

**Acceptance criteria**
- [ ] Passes in CI (linux) three times in a row

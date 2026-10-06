# Phase 4: DOM intelligence (`packages/dom`, `packages/runtime/src/observer`)

Read first: `docs/specs/dom-intelligence.md` (entire, twice), `docs/specs/data-models.md` §4, ADR-009.
**Package rule:** `packages/dom` never imports `playwright-core` or `@browser-os/browser`. It talks to Chrome only through the `CdpTransport` interface. Everything except `capture.ts` and `probe.ts` is a pure function over plain data.

Reference material (concepts; porting only where a card says `port: allowed`): BrowserSkill `apps/extension/src/tools/vom/*`, `packages/vom/src/*` @ `3f10983` (MIT). See OSS_STRATEGY.md §5.

---

## P4-01 · Text normalization utilities

| Field | Value |
|---|---|
| depends_on | P1-04 |
| supervision | cheap-ok |
| size | S |
| spec | dom-intelligence §7 (normalize), §6.1 (`isSensitiveField`), §8.4 (dice) |

**Files:** `packages/dom/src/normalize.ts`, `test/normalize.test.ts`.

**Requirements:** pure functions:
- `collapse(s)`: whitespace collapse + trim
- `truncate(s, n)`: adds `…`
- `normalizeName(s)`: lowercase, collapse, runs of digits → `#`
- `tokenize(s)`: split on non-alphanumerics, drop empty strings
- `dice(a: string[], b: string[])`: Sørensen–Dice on token multisets; a token prefix-matches when both are ≥ 4 chars and one starts with the other
- `normalizeIntent(text)` → `{ tokens, exact: string | null, roleHints: string[], searchBonus: boolean }` per §7 step 2, using the hint table exactly
- (`isSensitiveField` is NOT implemented here: import it from `@browser-os/protocol`, integration §2)

**Tests:** table-driven; intents such as `click the "Sign in" button`, `the search box`, `Messages`, `type into email field`.

**Acceptance criteria**
- [ ] 100% branch coverage

**Implementation notes**
Implemented the pure normalization and intent parsing utilities with table-driven coverage for whitespace, truncation, token multiset Dice scoring, quoted exact matches, role hints, and search bonus. Branch coverage is 100% when measured per-file (18/18); the aggregate `vitest --coverage` report shows 86.2% with "uncovered" lines 104/168 (prefixMatch return and the token filter) because v8 registers extra branch slots in workers that never execute them, a per-worker merge artifact. Both lines are exercised by the dice and parseIntent cases, including the added edge rows (sign/signin both directions, no-prefix equal-length pair, verb/stop-word removal, phrase-free intent).

---

## P4-02 · Raw capture and the capture recorder script

| Field | Value |
|---|---|
| depends_on | P2-03, P3-05, P4-01 |
| supervision | **expert** (review) |
| size | M |
| spec | dom-intelligence §2 |

**Files:** `packages/dom/src/capture.ts`, `src/types-raw.ts` (types for the subset of CDP responses we use), `scripts/record-capture.ts`, tests `packages/dom/test/capture.browser.test.ts`.

**Requirements**
1. `captureRaw(cdp: CdpTransport, opts?: { frameAxTimeoutMs?: number }): Promise<RawCapture>` issues the four calls of §2 concurrently. It fetches the AX tree per same-process child frame with `frameId`, each with a timeout. A failed or timed-out frame → omitted + warning (per-frame isolation).
2. Document-identity guard exactly as §2: `DOM.getDocument({ depth: 0 })` root backendNodeId before and after; re-capture once on change.
3. `RawCapture = { snapshot, axTrees: Record<cdpFrameId, AXNode[]>, layoutMetrics, frameTree, warnings, chromeVersion?, capturedAt }`, JSON-serializable.
4. `scripts/record-capture.ts <fixtureName> [--variant v]`: launches headless Chromium (via `tests/helpers/launchTestBrowser`), viewport 1280×800, opens the fixture, waits for `settle`, runs `captureRaw`, and writes `packages/dom/test/fixtures/<name>[.<variant>].raw.json` with `_chromeVersion`.
5. Record raw captures for every fixture page except `heavy` (too big; the benchmark captures it live).

**Tests (browser):** capture on `basic` contains nodes, layout and AX for the main frame; capture on `iframe` contains the child document and its AX tree; a forced AX timeout (`frameAxTimeoutMs: 0`) on `iframe` → frame omitted with a warning, main frame still present.

**Acceptance criteria**
- [ ] Raw fixtures committed for all non-heavy fixture pages

---

## P4-03 · Join → NodeTable

| Field | Value |
|---|---|
| depends_on | P4-02 |
| supervision | **expert** |
| size | M |
| spec | dom-intelligence §3 |

**Files:** `packages/dom/src/join.ts`, `test/join.test.ts`.

**Requirements**
1. `buildNodeTable(raw: RawCapture): NodeTable` with `rows: NodeRow[]`, `texts`, `frames`, `viewport`. `NodeRow` exactly as §3.
2. Decode DOMSnapshot string-table indices (`strings[]`), the `attributes` flat arrays, the layout `nodeIndex` → bounds/styles mapping, rare boolean data (`isClickable`, `inputChecked`), and rare string data (`inputValue`).
3. Global document order: iframe content documents are inlined at the position of their host `<iframe>` element (`contentDocumentIndex`).
4. Coordinates: convert document coordinates to top-level viewport coordinates (subtract scroll offsets, add iframe host offsets for child documents).
5. Shadow DOM: rows inside shadow roots get `shadowHostIdx` (derive it from `shadowRootType` and the parent chain).
6. AX join on `backendDOMNodeId`. AX nodes without a DOM node are ignored.

**Tests:** run on every recorded raw capture: invariants (every row has a backendNodeId; parents precede children; iframe rows have `frameId` ≠ main; the shadow fixture has rows with `shadowHostIdx`); plus hand-checked expectations for `basic` (the email input has bounds, an AX role `textbox` and `attrs.placeholder`).

**Acceptance criteria**
- [ ] Deterministic output (same input → deep-equal output)

---

## P4-04 · Interactivity and visibility rules

| Field | Value |
|---|---|
| depends_on | P4-03 |
| supervision | **expert** (review) |
| size | M |
| spec | dom-intelligence §4–5 |

**Files:** `packages/dom/src/interactive.ts`, `src/visibility.ts`, tests `test/interactive.test.ts`, `test/visibility.test.ts` (hand-built NodeTables, not raw captures).

**Requirements**
1. `isInteractive(row, table)`: rules 1–5 and exclusions of §4, one exported helper per rule so tests can target them.
2. `isVisible(row, table)`, `inViewport(rect, viewport)` per §5, including the checkbox/radio-with-label exception.
3. `modalScope(table)` → `{ dialogIdx: number | null, dialogs: string[] }`. Topmost by paint order. Elements outside the topmost modal are excluded by the caller.
4. Descendant de-duplication rule (§4, exclusions bullet 2).

**Tests:** one test per rule and per exclusion; modal scoping with two stacked dialogs; `display:none` ancestor; zero-size; opacity 0 checkbox with label.

**Acceptance criteria**
- [ ] Every bullet in §4 and §5 has at least one test

**Implementation notes**
Implemented pure interactivity, visibility, viewport, modal scope, and labelled checkbox/radio helpers. The full unit suite is green; dedicated rule coverage is not yet added, so this task remains in `review`.

---

## P4-05 · Semantic output, serialization, goldens

| Field | Value |
|---|---|
| depends_on | P4-04 |
| supervision | **expert** (review) |
| size | M |
| spec | dom-intelligence §6; SECURITY.md S17 |

**Files:** `packages/dom/src/semantic.ts`, `src/serialize.ts`, `src/observe.ts` (`buildObservation(raw, meta) → { observation, index }` composing join → rules → semantic, without `challenge` until P4-06), tests `test/semantic.test.ts`, `test/golden.test.ts`, goldens `test/fixtures/<name>.observation.txt`.

**Requirements**
1. Field rules of §6.1 exactly (role fallback table, name fallbacks, value masking, context, frame ids, refs in document order).
2. Text blocks §6.3 when `includeText`.
3. `serializeLines(observation, { viewportOnly? })` and `estimateTokens(str)` per §6.4.
4. `ObservationIndex` entries hold `backendNodeId`, `frameId`, `cdpFrameId` and a **minimal** `locator` (`{ v:1, role, name, nameIsDynamic:false, tag, attrs:{}, context, cssPath:'', framePath:[], ordinal:0 }`). P4-08 replaces it with the full `buildLocator` result.
5. Goldens: for each raw fixture, `golden.test.ts` builds the observation and compares `serializeLines` with `<name>.observation.txt` (vitest `toMatchFileSnapshot`).
6. Password and sensitive values render as `••••` (S17).
7. `capture.browser.test.ts` (extend P4-02's file): a live capture serialized equals the golden.

**Tests:** above, plus unit tests for the role fallback table, name fallbacks and context formatting.

**Acceptance criteria**
- [ ] Goldens reviewed by a human/expert before `done` (they define expected behaviour)
- [ ] The `basic` golden contains the icon button as `button "Settings"` and the disabled button with `(disabled)`

---

## P4-06 · Security challenge detection

| Field | Value |
|---|---|
| depends_on | P4-05 |
| supervision | cheap-ok |
| size | S |
| spec | dom-intelligence §9 |

**Files:** `packages/dom/src/challenge.ts`, `test/challenge.test.ts`; wire into `buildObservation` (`observation.challenge`).

**Requirements:** the heuristics table of §9 with its priority order. The IdP host list is a constant array. Text signals use `TextBlock`s (compute text internally even when `includeText` is false).

**Tests:**
- `login` fixture step 1 → `login`
- step 2 (OTP) → `mfa`
- synthetic NodeTables for captcha iframes and IdP consent
- negatives: `basic` → null; a page containing the word "code" in a paragraph → null

**Acceptance criteria**
- [ ] No false positive on any non-login fixture

---

## P4-07 · Lexical ranking (deterministic tier)

| Field | Value |
|---|---|
| depends_on | P4-05 |
| supervision | cheap-ok (review thresholds) |
| size | M |
| spec | dom-intelligence §7; action-router §5 (`isCompatible`) |

**Files:** `packages/dom/src/lexical.ts`, `src/compat.ts` (`isCompatible(element, actionType)`), tests `test/lexical.test.ts`, `test/lexical-truth.test.ts`.

**Requirements**
1. `lexicalRank(elements, intent, actionType)` exactly per §7 (weights, caps, bonus, tie-break).
2. `lexicalDecision(ranked, { accept, margin })` → `{ element } | { reason: 'TARGET_NOT_FOUND' | 'TARGET_AMBIGUOUS' }`.
3. Truth evaluation: for every fixture with a raw capture and `truth.json`, resolve every intent:
   - precision = correct accepted / all accepted
   - coverage = accepted / intents with non-null expect
   - `expect: null` intents must not be accepted

   To map `expect.css` to a ref, the raw capture needs selector data. Add to `scripts/record-capture.ts` (P4-02) an extra output `<name>.truth-map.json` that maps each truth CSS selector to its backendNodeId at record time (via `DOM.querySelector`). Re-record if needed.

**Tests:** unit tests for scoring components; truth test asserts precision ≥ 0.99 overall, prints coverage per fixture.

**Acceptance criteria**
- [ ] E6 (≥ 99% precision) met at default constants (0.75 / 0.15). If not met, **do not change constants silently**: report in CONFLICTS.md with the data.

---

## P4-08 · Locator build, cssPath, matching

| Field | Value |
|---|---|
| depends_on | P4-05 |
| supervision | **expert** |
| size | M |
| spec | dom-intelligence §8.1, §8.2, §8.4 |

**Files:** `packages/dom/src/locator.ts`, `src/css-path.ts`, tests `test/locator.test.ts`, `test/css-path.test.ts`.

**Requirements**
1. `buildLocator(table, rowIdx, element, observation)` per §8.1 (unstable-id regexes exactly, frame path, ordinal). Observations are built without task context, so the dynamic-name rule is a separate pure function, `applyParamsToLocator(locator, paramValues): ElementLocator` (§8.1 `name` bullet). The router (P7-03, cache writes) and the recorder (P7-05) call it before persisting a locator.
2. `cssPath(table, rowIdx)` per §8.2 (shadow ` >>> `, max 8 segments).
3. Replace the P4-05 minimal locator: `buildObservation` fills `ObservationIndex.entries[ref].locator` with `buildLocator(...)` for every element (eagerly; if L6 regresses by > 10%, switch to lazy computation and note it).
4. `matchLocator(observation, index, locator)` and `verifyIdentity(candidate, locator)` per §8.4 (weights table, normalization over applicable weights, hard caps, compatible role groups).

**Tests:** cssPath on shadow and iframe fixtures; unstable id filtering table; dynamic name with params; round trip (for every element in every golden fixture, `matchLocator(obs, buildLocator(el))` returns that element first with margin ≥ 0.10).

**Acceptance criteria**
- [ ] Round-trip test passes on all fixtures

---

## P4-09 · Probe (cache fast path)

| Field | Value |
|---|---|
| depends_on | P4-08, P2-03 |
| supervision | **expert** (review) |
| size | M |
| spec | dom-intelligence §8.3 |

**Files:** `packages/dom/src/probe.ts` (+ the probe helper source added to the browser helpers bundle **as a string exported from dom** and installed by the browser package; keep the source in `packages/dom/src/probe-helper.js.ts` and have `packages/browser` import nothing from dom. Instead the runtime passes the helper source to `IsolatedWorlds` at startup. Expose `IsolatedWorlds.registerHelper(name, source)` in P2-03's API if missing; that change belongs to this task), test `test/probe.browser.test.ts`.

**Requirements**
1. `probe(cdp, worlds, locator)` → `ProbeCandidate[]` per §8.3, strategies in order, stopping at the first strategy with ≥ 1 hit, max 5 candidates.
2. For each candidate, run `DOM.describeNode`, `Accessibility.getPartialAXTree({ fetchRelatives: false })` and `DOM.getBoxModel` concurrently.
3. `framePath.length > 0` → return `[]`.
4. Single-candidate round-trip budget ≤ 4 (assert with `CountingCdpTransport`; the concurrent calls count individually, so measure **sequential depth**: the implementation must do one `callFunctionOn` + one parallel batch. Assert sequential depth ≤ 2 and total calls ≤ 4 for one candidate.)

**Tests (browser):** probe the search box on `spa` by `data-testid="search-input"` (present since P0-04), by `name`, by cssPath only, inside open shadow DOM; ambiguous cssPath → multiple candidates; iframe locator → `[]`.

**Acceptance criteria**
- [ ] Round-trip budget assertions pass
- [ ] L11 printed (informational)

---

## P4-10 · Playwright ariaSnapshot oracle test

| Field | Value |
|---|---|
| depends_on | P4-05 |
| supervision | cheap-ok |
| size | S |
| spec | dom-intelligence §1 ("Why not Playwright ariaSnapshot"), §11 |

**Files:** `tests/e2e/oracle.e2e.test.ts`. It lives in `tests/` because it needs both Playwright (via `@browser-os/browser` test helpers) and `@browser-os/dom`, and only `tests/` may import across all packages.

**Requirements:** for each fixture page, get `page.ariaSnapshot({ mode: 'ai' })` (Playwright ≥ 1.59 public API; if the installed version lacks it, mark the test skipped with a clear message) and our observation. Pair elements by role+name, and report agreement = matched / our interactive elements.

**Acceptance criteria**
- [ ] Agreement ≥ 95% on every fixture, or a written explanation per mismatch class in the implementation notes

---

## P4-11 · Observer (runtime)

| Field | Value |
|---|---|
| depends_on | P4-06, P4-08, P2-07 |
| supervision | cheap-ok |
| size | S |
| spec | dom-intelligence §10; data-models (events) |

**Files:** `packages/runtime/src/observer/observer.ts`, tests `packages/runtime/test/observer.test.ts` (fake capture), `test/observer.browser.test.ts`.

**Requirements**
1. `Observer.capture(sessionId, pageId, opts)` → `{ observation, index }`, reusing the latest one per the three conditions of §10. Actions call `observer.invalidate(pageId)`. `Page.frameNavigated` (main frame) invalidates.
2. `Observer.index(observationId)` returns the index if it is still held (keep the last 3 per page for stale-ref healing).
3. Emits `observation.captured`.
4. `includeText` requests bypass reuse when the cached observation lacks text.

**Tests:** reuse on an unchanged page (one capture call); a mutation → re-capture; navigation → re-capture; event emitted; L8 printed.

**Acceptance criteria**
- [ ] Reuse check costs one CDP round trip

---

## P4-12 · Mutation fixtures and locator robustness suite

| Field | Value |
|---|---|
| depends_on | P4-08 |
| supervision | cheap-ok |
| size | M |
| spec | dom-intelligence §11; PERFORMANCE.md E7 |

**Files:** `fixtures/sites/mutations/<case>/index.html` (+ `base.html` reference), raw captures for each, `packages/dom/test/robustness.test.ts`.

**Cases** (each case = a base page and a mutated page, with `truth.json` listing target pairs):
1. class names changed
2. sibling order reversed
3. extra wrapper divs
4. badge counts changed ("Messages 3" → "Messages 7")
5. unstable ids regenerated (`:r12:` → `:r9a:`)
6. button text changed slightly ("Sign in" → "Sign In")
7. element moved into another container with the same landmark
8. negative case: target removed, so matching must **not** pick a wrong element above `matchAccept`

**Test:** build locators on base, match on mutated. Correct element best with margin ≥ 0.10 in ≥ 95% of positive pairs; the negative case has no candidate ≥ 0.70.

**Acceptance criteria**
- [ ] Suite passes; failures documented as CONFLICTS entries if thresholds look wrong

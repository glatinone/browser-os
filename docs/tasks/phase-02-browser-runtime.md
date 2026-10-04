# Phase 2: Browser runtime (`packages/browser`, `packages/runtime/src/sessions`)

Read first: `docs/specs/browser-runtime.md` (entire), `docs/SECURITY.md` §2–§3 and §7, ADR-002, ADR-003.
Runtime dependency added in this phase: `playwright-core` (in `packages/browser` only).

---

## P2-01 · Browser executable discovery

| Field | Value |
|---|---|
| depends_on | P1-04 |
| supervision | cheap-ok |
| size | S |
| spec | browser-runtime §1.1 |

**Files:** `packages/browser/src/executables.ts`, `test/executables.test.ts`.

**Requirements**
1. `findExecutable(channel, { platform, env, exists }): string | null`, a pure function with injected `exists(path) => boolean`.
2. Env overrides first: `BOS_CHROME_PATH` (chrome/chromium), `BOS_EDGE_PATH` (msedge).
3. Known locations:
   - **win32:**
     - `%PROGRAMFILES%\Google\Chrome\Application\chrome.exe`
     - `%PROGRAMFILES(X86)%\…`
     - `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`
     - Edge under `Microsoft\Edge\Application\msedge.exe` in the same roots
   - **darwin:**
     - `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
     - `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`
   - **linux:**
     - `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`
     - `/usr/bin/microsoft-edge`, `/usr/bin/microsoft-edge-stable`
     - `/usr/bin/chromium`, `/usr/bin/chromium-browser`
4. `chromium` channel: if not found, return `null`. The LaunchProvider then lets Playwright use its managed Chromium.
5. `defaultChannel({ ... })`: `chrome` if found, else `msedge`, else `chromium`.

**Tests:** table-driven per platform with a fake `exists`.

**Acceptance criteria**
- [x] No filesystem access in tests; all paths built with `node:path` win32/posix variants as appropriate

**Implementation notes**
- The env override is the **first candidate**, not an unconditional answer: it is checked with the
  injected `exists` and a stale override falls through to the known locations. `chromium` reads
  `BOS_CHROME_PATH` too (it is the "Chromium family" override).
- `%LOCALAPPDATA%` is a root only when the variable is set, and `chromium` has no win32/darwin
  locations at all — Playwright's bundled Chromium is not a system install, so `null` there is the
  documented result, not a failure.

---

## P2-02 · Profile directories (filesystem)

| Field | Value |
|---|---|
| depends_on | P1-04 |
| supervision | cheap-ok |
| size | S |
| spec | browser-runtime §1; SECURITY.md §2 (S1) |

**Files:** `packages/browser/src/profiles.ts`, `test/profiles.test.ts`.

**Requirements**
1. `validateProfileName(name)` → throws `BosError('INVALID_REQUEST')` unless it matches `/^[a-z0-9][a-z0-9-]{0,31}$/`.
2. `profileDir(bosHome, name)` → `<bosHome>/profiles/<name>` (absolute, normalized).
3. `assertInsideProfiles(bosHome, dir)`: resolves real paths (follows symlinks if they exist) and throws `PERMISSION_DENIED` if `dir` is not strictly inside `<bosHome>/profiles` (S1).
4. `ensureProfileDir(bosHome, name)` creates the directory (recursive) and returns the path.
5. `isProfileLocked(dir): Promise<boolean>`: true if Chrome's `SingletonLock` (POSIX symlink) or `lockfile` (Windows) exists **and** the owning process is alive. POSIX: the SingletonLock target is `hostname-pid`; check the pid with `process.kill(pid, 0)`. Windows: try to open `lockfile` for exclusive write and treat `EBUSY`/`EPERM` as locked. A stale lock → false.

**Tests:** temp dirs; name validation table; traversal attempts (`../x`, absolute path elsewhere, symlink escape on POSIX); stale lock vs live lock (spawn a dummy process holding the pid on POSIX; on Windows, hold the file open in the test).

**Acceptance criteria**
- [x] S1 covered

**Implementation notes**
- **The Windows lock probe works, but the card's Windows *test* cannot.** Measured against a real
  Chrome 154 profile on Windows 11: Chrome creates an empty `lockfile` (no `SingletonLock`, no
  pid) and holds it with an exclusive share mode, so `fs.open(lockfile, 'r+')` fails with `EBUSY`
  while it is alive and succeeds once it is gone. But Node always opens with
  `FILE_SHARE_READ|WRITE|DELETE`, so a *Node* holder is never exclusive and the probe would
  succeed — "hold the file open in the test" does not reproduce a lock. `test/profiles.test.ts`
  therefore holds it with a PowerShell `FileShare.None` handle, which does produce `EBUSY`.
- `profileDir` is pure path arithmetic and does **not** validate `name`; `assertInsideProfiles` is
  the guard (S1) and must be applied by whoever accepts a directory from outside. `ensureProfileDir`
  does not call it: the name is validated first, so its result is inside by construction.
- `isProfileLocked` decides staleness per platform rather than by the file's existence, because
  Chrome never deletes lock files and Browser-OS does not either (SECURITY §2).

---

## P2-03 · CDP transport, counting wrapper, isolated worlds

| Field | Value |
|---|---|
| depends_on | P2-04 |
| supervision | cheap-ok (review recommended) |
| size | M |
| spec | browser-runtime §4; SECURITY.md S19 |

**Files:** `packages/browser/src/cdp/transport.ts`, `cdp/counting-transport.ts`, `cdp/isolated-worlds.ts`, `cdp/helpers.js.ts`; tests `test/cdp.browser.test.ts`, `test/counting-transport.test.ts`.

**Requirements**
1. `PlaywrightCdpTransport` implements `CdpTransport` over a Playwright `CDPSession`. `send` passes through. `on` subscribes and returns an unsubscribe function. Playwright types stay internal.
2. Implement `PageHandle.cdp()` (left unimplemented in P2-04) using `createPageCdp(page)`, which creates the session once per page and enables `Page`, `DOM`, `DOMSnapshot`, `Accessibility`, `Network`. It **must not** call `Runtime.enable`.
3. `CountingCdpTransport(inner)` counts calls per method: `counts(): Record<string, number>`, `total()`, `reset()`.
4. `IsolatedWorlds`:
   - `get(frameId)` returns the `executionContextId` of world `bos`. It creates the world with `Page.createIsolatedWorld({ frameId, worldName: 'bos', grantUniveralAccess: false })` and installs the helpers.
   - The id is cached until `Page.frameNavigated` for that frame.
   - `evaluate<T>(frameId, fnSource, args)` runs `Runtime.callFunctionOn`/`Runtime.evaluate` with `contextId` and `returnByValue: true`.
5. Helpers bundle (string), idempotent, defines `globalThis.__bos` **inside the isolated world only**, with:
   - `mutationCount()`: a `MutationObserver` on `document` (childList, attributes, characterData, subtree) incrementing a counter
   - `readValue(el)`
   - placeholders for the `probe` (filled in P4-09) and `extract` (P3-01) helpers

**Tests**
- Unit: counting transport.
- Browser:
  - the world is created
  - `__bos` is not visible from the main world (S19): evaluating `typeof window.__bos` via `page.evaluate` is `'undefined'`
  - the mutation counter increases after a DOM change
  - the world is recreated after navigation

**Acceptance criteria**
- [x] No `Runtime.enable` anywhere (grep test)

**Implementation notes**
- One file added to the card's list: `cdp/playwright.ts` holds `PlaywrightCdpTransport`,
  `createPageCdp(page)` and the `PAGE_DOMAINS` list. It cannot live in `cdp/transport.ts`,
  because `createPageCdp` takes a Playwright `Page` and `transport.ts` is re-exported from
  `src/index.ts` — that would put a Playwright type straight into `dist/index.d.ts` and break
  the P2-04 criterion. `cdp/playwright.ts` is therefore internal; only `PageHandle.cdp()`
  reaches it. `cdp/transport.ts`, `counting-transport.ts` and `isolated-worlds.ts` carry no
  Playwright type and are exported.
- The `Runtime` guard is behavioural first: `test/cdp.browser.test.ts` subscribes to
  `Runtime.executionContextCreated` on the page's own transport and asserts nothing arrives,
  with a **control** session that does enable the domain and does receive events — otherwise
  the assertion could pass simply because the event never arrives for anyone. The card's grep
  test is kept alongside it, and it scans every `.ts` under `src/`, not just `cdp/`.
- `cdp/helpers.js.ts` is a TypeScript file whose *contents* are a JavaScript string, so the
  compiled name is `helpers.js.js` (the card and spec §4 both name the source that way). The
  bundle is installed with `Runtime.evaluate` carrying the world's `contextId`, which is the
  only thing that confines `__bos` to the `bos` world (S19). Re-installing it is a no-op.
- `probe` and `extract` in the bundle throw with the block that fills them in (P4-09, P3-01),
  so a caller arriving early fails loudly instead of reading `undefined`.
- `IsolatedWorlds.get()` de-duplicates concurrent callers through a pending map, so two
  callers cannot create two worlds in one frame; a failed creation clears the pending entry
  so a retry is possible.
- `test/support/raw-page.ts` holds the duck-typed raw-page accessor both browser test files
  now share (see the P2-04 note about `instanceof` across module graphs).

---

## P2-04 · LaunchProvider and PageHandle

| Field | Value |
|---|---|
| depends_on | P2-01, P2-02 |
| supervision | cheap-ok |
| size | M |
| spec | browser-runtime §2; SECURITY.md S2, S4 |

**Files:**
- `packages/browser/src/provider.ts` (interfaces from the spec)
- `providers/launch-provider.ts`
- `page-handle.ts`
- `tests/helpers/launch-test-browser.ts`
- tests `test/launch-provider.browser.test.ts`, `test/launch-options.test.ts`

**Requirements**
1. `LaunchProvider.open({ profile, headless, viewport })` → `chromium.launchPersistentContext(profile.userDataDir, { channel, headless, viewport: null, acceptDownloads: true })`. Use exactly the profile channel: `chrome`/`msedge` not found by `findExecutable` → `BROWSER_NOT_FOUND` (no silent fallback; integration §13). Only channel `chromium` uses Playwright's bundled Chromium.
2. `buildLaunchOptions(profile, opts)` is a separate pure function. It must never include `ignoreDefaultArgs` containing `--enable-automation`, `--disable-blink-features=AutomationControlled`, or any `userAgent` override (S4 unit test).
3. Pipe transport (Playwright default). Assert in a test that no `DevToolsActivePort` file is created in the profile dir (S2).
4. `BrowserHandle` and `PageHandle` per the spec:
   - page ids come from `newId('pg')`, mapped to Playwright pages
   - `onPage` fires for popups and new tabs
   - `onDisconnected` fires on browser close or crash
   - `cdp()` is implemented in P2-03; leave it throwing `BosError('INTERNAL', 'not implemented')` here
5. Before launching, `isProfileLocked` → `PROFILE_LOCKED`. Launch errors are mapped to `BROWSER_LAUNCH_FAILED` with `cause`.
6. `launchTestBrowser()` helper for tests: temp `BOS_HOME`, profile `test`, headless Chromium.

**Tests (browser):**
- launch, then `pages().length >= 1`
- `newPage`
- `close`
- a cookie set on the fixture site via `document.cookie` persists after close and relaunch of the same profile
- `onPage` fires on `window.open`
- locked profile → `PROFILE_LOCKED`

**Acceptance criteria**
- [x] S2, S4 tests pass
- [x] No Playwright type exported from `src/index.ts`

**Implementation notes**
- Two extra files beyond the card, both type-only so later tasks have something to
  implement against: `cdp/transport.ts` (`CdpTransport`, for `PageHandle.cdp()`) and
  `driver/types.ts` (`PageDriver`/`ResolvedTarget`/`DriverResult`, spec §5 + integration §6).
  `PageHandleImpl` is deliberately **not** re-exported from `src/index.ts`; only the
  `PageHandle` interface is, which is what keeps Playwright out of the public surface
  (verified: `grep -c playwright packages/browser/dist/index.d.ts` → 0).
- `LaunchProvider` takes a `deps` seam (`findExecutable`, `isProfileLocked`) so the two
  pre-flight checks are unit-tested in `test/launch-provider.test.ts` without a browser.
  The real lock is still exercised end-to-end: `test/launch-provider.browser.test.ts` opens
  the same profile twice and the second `open` gets `PROFILE_LOCKED` from Chrome itself.
- `buildLaunchOptions` defaults `headless` to `profile.headless` rather than `false`, so a
  profile created headless stays that way unless the caller says otherwise.
- `packages/browser` now devDepends on `@browser-os/tests` (integration §15) and that package
  depends on every package, so the workspace has a cycle. `pnpm-workspace.yaml` sets
  `ignoreWorkspaceCycles: true` or `pnpm -r typecheck` refuses to run at all.
- Browser-test caveat: a workspace package can be loaded through two module graphs in one
  Vitest run, so `instanceof` against a class from this package is unreliable in
  `*.browser.test.ts`; duck-type or compare the file paths instead.

---

## P2-05 · CdpEndpointProvider

| Field | Value |
|---|---|
| depends_on | P2-04 |
| supervision | cheap-ok |
| size | S |
| spec | browser-runtime §2; SECURITY.md S3 |

**Files:** `packages/browser/src/providers/cdp-endpoint-provider.ts`, tests `test/cdp-endpoint.test.ts` (unit), `test/cdp-endpoint.browser.test.ts`.

**Requirements**
1. Accepts `ws://` or `http://` endpoints whose host is `127.0.0.1`, `localhost` or `[::1]`. Anything else → `PERMISSION_DENIED` (S3).
2. `chromium.connectOverCDP(endpoint)`, using `browser.contexts()[0]` (or a new context if none).
3. `close()` disconnects without killing the browser (`ownership: 'attached'`).
4. Capabilities: `persistentProfile: false` (unknown), others true.

**Tests:**
- Unit: host validation table.
- Browser: spawn Playwright Chromium with `--remote-debugging-port=0` on a temp user-data-dir (read `DevToolsActivePort`), attach, list pages, disconnect, then verify the browser is still alive.

**Acceptance criteria**
- [x] S3 covered

**Implementation notes**
- `ownership` is a **Session** field, not a `BrowserHandle` one (data-models §2, memory §66), so
  `provider.ts` is unchanged from the spec's interface. What carries it is `kind`: `'launch'` is
  `'launched'`, everything else attaches to a browser the user owns. This provider implements
  the other half of the requirement — `close()` calls `browser.close()`, which for a
  `connectOverCDP` client drops the connection and leaves the process running.
- The loopback allowlist is literally the three spellings the spec names. `127.0.0.2` and the
  expanded IPv6 form of `::1` are therefore refused: fail closed, and say so, rather than
  growing a second list of "also loopback" addresses.
- The S3 unit test aims at `ws://10.255.255.1` (a black hole). If the guard ever stopped
  running before `connectOverCDP`, that test would hang into its timeout instead of passing.
- New `page-registry.ts` holds the page bookkeeping (wrap once, keep order, notify, signal
  disconnect once) that `LaunchProvider` had inline; both providers now share it. Copying it
  into this provider would have duplicated ~60 lines, and three more providers are planned
  (chrome-consent, extension, lightpanda). `launch-provider.ts` is refactored onto it — its
  behaviour is unchanged and covered by the P2-04 browser tests.
- The browser test spawns real Chromium with `--remote-debugging-port=0` over a temp
  user-data-dir and reads the port out of `DevToolsActivePort`. It asks Chrome over HTTP
  whether it is still alive rather than through Playwright, so the check does not depend on
  Playwright's own context bookkeeping.
- `viewport` is honoured only when the provider has to create a context; an attached browser's
  existing window belongs to the user.

---

## P2-06 · Manual setup mode launcher

| Field | Value |
|---|---|
| depends_on | P2-01, P2-02 |
| supervision | cheap-ok |
| size | S |
| spec | browser-runtime §1.1 |

**Files:** `packages/browser/src/manual-launch.ts`, `test/manual-launch.test.ts`.

**Requirements**
1. `buildManualLaunchCommand(executable, userDataDir)` → `{ command, args }` with args exactly `[`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check']`. No remote debugging flags, no `--enable-automation`.
2. `openManual(profile)`: spawns the process detached (`stdio: 'ignore'`, `unref()`) and returns the pid. Missing executable → `BROWSER_NOT_FOUND`. Locked profile → `PROFILE_LOCKED`.

**Tests:** unit test of the command builder (asserts the absence of `--remote-debugging-port`, `--remote-debugging-pipe`, `--enable-automation`); `openManual` with an injected fake spawn.

**Acceptance criteria**
- [x] Never launches with debugging enabled

**Implementation notes**
- `windowsHide: true` is added to the spawn options beyond the card. On Windows a detached child
  gets a console window of its own (Node's documented behaviour), which would flash up beside the
  browser the human just asked for; the flag is harmless elsewhere.
- The `deps` seam is typed with our own `SpawnedProcess` / `ManualSpawnOptions` rather than node's
  `SpawnOptions`, which keeps `node:child_process` out of the published declaration and lets the
  test assert the exact spawn options instead of a subset.
- `openManual` returns `number | null`: on Windows the pid can still be missing right after spawn,
  and inventing one would be worse than saying we do not have it.
- The S1 check (profile dir inside `<BOS_HOME>/profiles`) is deliberately **not** repeated here.
  The directory was validated when the profile was created (P2-02), and `openManual(profile)` has
  no `BOS_HOME` to validate against — inventing one would be a second, weaker source of truth.
- The test file builds its own profile fixture rather than importing one: P2-05 introduces a shared
  `test/support/dummy-profile.ts`, and depending on an unmerged branch would have made this PR
  unmergeable on its own. The two can be unified once both have landed.

---

## P2-07 · Session manager

| Field | Value |
|---|---|
| depends_on | P2-04, P2-05 |
| supervision | cheap-ok (review recommended) |
| size | M |
| spec | browser-runtime §3 |

**Files:** `packages/runtime/src/sessions/session-manager.ts`, `sessions/page-registry.ts`, tests `packages/runtime/test/session-manager.test.ts` (fake providers), `test/session-manager.browser.test.ts`.

**Requirements**
1. Implement the `SessionManager` interface from the spec. Constructor deps:
   - `providers: Record<kind, BrowserProvider>`
   - `profiles: { getByName(name): BrowserProfile | null }`
   - `persist?: { upsert(session): void }` (wired to SQLite in P7-07)
   - `events: EventBus`
   - `clock: Clock`
2. `open` returns the existing live session for the profile (rule 17).
3. Active page tracking: new pages opened by `onPage` become active (event `session.status` with `reason: 'active-page-changed'`). When the active page closes, fall back to the opener, else the most recent page.
4. `onDisconnected` → status `disconnected` + event. `reconnect(id)` relaunches with the same profile and provider, opens the last active URL, then status `ready`.
5. Per-page async mutex (`withPageLock(sessionId, pageId, fn)`). While held, session status is `busy`; it returns to `ready` after.
6. `close(id)` closes the handle and sets status `closed`.

**Tests**
- Unit (fake provider):
  - reuse
  - active page changes
  - disconnect → reconnect
  - lock serialization (two concurrent `withPageLock` calls run sequentially; different pages run concurrently)
- Browser: kill the browser process (`process.kill(pid)`) → `disconnected` event → `reconnect` restores the URL.

**Acceptance criteria**
- [x] `open` twice returns the same session id
- [x] Lock tests deterministic (no sleeps; use deferred promises)

**Implementation notes**
- **Deviation from the card's browser test.** The card says to kill the browser process with
  `process.kill(pid)`, but no provider exposes a pid for a browser it launched: LaunchProvider
  uses a persistent context and `BrowserHandle.pid` is `null` by design (integration §13,
  asserted in P2-04). The first attempt was a spawned Chromium behind `CdpEndpointProvider`,
  which does have a pid — but after the browser died the replacement Chromium silently failed to
  write `DevToolsActivePort` on that port (measured: the port was bindable again within 3 ms, so
  it is Chrome's own bind that fails, not a lingering socket). The test therefore uses
  LaunchProvider and quits the browser from the outside with `Browser.close` on the page's CDP
  session — the same `disconnected` event, no pid involved.
- **`about:blank` is not a url worth restoring.** A page is activated when it opens and only
  navigates afterwards; and when a browser dies its pages close one after another, so the active
  page's fallback (its opener, usually a blank first page) would overwrite the url to restore.
  `#rememberUrl` ignores `''`/`about:blank`, which is what makes the reconnected page come back
  on the url it died on. Found by the browser test, not by reasoning.
- `newPage(url)` waits for the navigation to commit (`Page.frameNavigated`), so the returned
  `PageInfo` carries the real url; a url Chrome refuses reports `errorText` and is not waited on.
- `withPageLock` chains per page and keeps the chain alive when the work rejects, so a failed
  action cannot strand the next caller. `busy` is counted, so it only clears when the last lock
  is released.
- `reconnect` retries nothing. A crash followed immediately by a reconnect can land in the window
  where the OS has not reaped the old process and the profile still reads as locked; the browser
  test waits for `isProfileLocked` to clear first. A bounded retry inside `reconnect` is a
  candidate follow-up — the router calls it once (action-router §4.1).
- Deliberately **not** in this task although spec §3 mentions them: the daemon-start sweep that
  closes sessions left live by a previous daemon run, and `config.sessionIdleMinutes`. Neither is
  in the card, and the sweep needs a `list()` on the persistence port that does not exist yet.
- `tests/helpers` gained `dummyProfile`, and `packages/browser/test/support/dummy-profile.ts` is
  gone — the dedupe the P2-06 note promised once both branches had landed.

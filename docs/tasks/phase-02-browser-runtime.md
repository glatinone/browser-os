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
- [ ] S1 covered

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
- [ ] No `Runtime.enable` anywhere (grep test)

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
- [ ] S2, S4 tests pass
- [ ] No Playwright type exported from `src/index.ts`

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
- [ ] S3 covered

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
- [ ] Never launches with debugging enabled

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
- [ ] `open` twice returns the same session id
- [ ] Lock tests deterministic (no sleeps; use deferred promises)

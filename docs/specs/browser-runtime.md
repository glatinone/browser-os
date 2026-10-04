# Spec: Browser Runtime: Providers, Profiles, Sessions, Drivers (`packages/browser`, `packages/runtime/src/sessions`)

**Status:** Authoritative for MVP · **Owner packages:** `@browser-os/browser` (Playwright/CDP), `@browser-os/runtime` (session manager)
**Related:** ADR-001, ADR-002, ADR-003, ADR-013, `SECURITY.md` §2–3

`playwright-core` is imported **only** inside `packages/browser`. Everything it exports uses `protocol` types and the interfaces below.

---

## 1. Profiles

A **profile** is a Browser-OS-owned Chrome user-data-dir at `<BOS_HOME>/profiles/<name>`. It holds cookies, storage, extensions and settings, all managed by Chrome itself.

Rules:
- Browser-OS **never** uses the user's default Chrome/Edge user-data-dir. Chrome 136+ blocks remote debugging there anyway, and it is the user's most sensitive profile (ADR-003). `ProfileManager.create` rejects any `userDataDir` outside `<BOS_HOME>/profiles/`.
- One Chrome process per user-data-dir (Chrome enforces this). Before launching, check for Chrome's `SingletonLock` / `lockfile` in the directory. If it is held by a live process → `PROFILE_LOCKED`.
- Default profile name: `default`. Default channel: `chrome` if installed, else `msedge`, else `chromium` (Playwright-managed; mainly for CI).

### 1.1 Manual setup mode (`bos profile open <name>`)

Launches the real browser executable for the channel with `--user-data-dir=<dir>` and **no automation**: no CDP, no Playwright, no `--enable-automation`. The command returns immediately. The human logs in to sites (Google, Microsoft Entra, LinkedIn, …), completes MFA or passkeys, installs extensions and closes the window. Later automation sessions reuse the cookies from the profile.

This is the supported way to authenticate. Identity providers that refuse automated browsers see a normal browser driven by a human. Browser-OS does not hide automation in automated sessions (SECURITY.md §7).

Executable discovery: `packages/browser/src/executables.ts` resolves the channel executable per OS (Playwright's channel resolution is used for automated launches; for manual mode we need the path ourselves). Known install locations per OS plus env override `BOS_CHROME_PATH` / `BOS_EDGE_PATH`. Missing → `BROWSER_NOT_FOUND`.

---

## 2. Providers

```ts
// packages/browser/src/provider.ts
export interface ProviderCapabilities {
  persistentProfile: boolean;
  screenshots: boolean;
  oopif: boolean;
  headful: boolean;
  uploads: boolean;
  downloads: boolean;
}

export interface BrowserProvider {
  readonly kind: 'launch' | 'cdp-endpoint' | 'chrome-consent' | 'extension' | 'lightpanda';
  readonly capabilities: ProviderCapabilities;
  open(opts: OpenOptions): Promise<BrowserHandle>;
}

export interface OpenOptions {
  profile: BrowserProfile;           // for 'launch'
  headless?: boolean;
  cdpEndpoint?: string;              // for 'cdp-endpoint' (loopback only)
  viewport?: { width: number; height: number } | null;   // null = window size (default)
}

export interface BrowserHandle {
  readonly pid: number | null;
  pages(): PageHandle[];
  newPage(): Promise<PageHandle>;
  onPage(cb: (page: PageHandle) => void): () => void;          // popups / new tabs
  onDisconnected(cb: (reason: string) => void): () => void;
  close(): Promise<void>;
}

export interface PageHandle {
  readonly id: string;               // pg_...
  url(): string;
  title(): Promise<string>;
  opener(): PageHandle | null;
  cdp(): Promise<CdpTransport>;      // main-frame CDP session (cached per page)
  driver(): PageDriver;
  bringToFront(): Promise<void>;
  close(): Promise<void>;
  onClose(cb: () => void): () => void;
}
```

| Provider | MVP? | Implementation |
|---|---|---|
| `LaunchProvider` | **MVP (default)** | `chromium.launchPersistentContext(userDataDir, { channel, headless, viewport: null, acceptDownloads: true })`. Transport is Playwright's pipe: **no TCP debugging port is opened**, so other local processes cannot attach to the logged-in profile. Browser lifetime = daemon lifetime. |
| `CdpEndpointProvider` | MVP (small) | `chromium.connectOverCDP(endpoint)`; endpoint must be `127.0.0.1`/`localhost`/`[::1]`. For tests, interop and power users who start Chrome themselves. `ownership = 'attached'`; closing the session disconnects but does not kill the browser. |
| `ChromeConsentProvider` | post-MVP | Chrome 144+ `chrome://inspect/#remote-debugging` consent flow to reach the user's **real** browser, with a per-connection Allow dialog. Needs Playwright ≥ 1.60 verification (task P13-01). |
| `ExtensionProvider` | post-MVP | Own MV3 extension relaying CDP via `chrome.debugger` (ADR-013). |
| `LightpandaProvider` | future | Out-of-process CDP endpoint, headless extract-only workloads, capability flags false for screenshots/persistentProfile. AGPL: never linked, only spoken to over CDP. |

The router reads `capabilities` to skip tiers a provider cannot support (e.g. no `vision` without `screenshots`).

**Launch flags:** Playwright defaults plus nothing that hides automation. Explicitly **forbidden**: `ignoreDefaultArgs: ['--enable-automation']`, `--disable-blink-features=AutomationControlled`, user-agent spoofing, stealth plugins (SECURITY.md §7).

---

## 3. Session manager (`packages/runtime/src/sessions/session-manager.ts`)

```ts
export interface SessionManager {
  open(opts: { profileName: string; provider?: 'launch' | 'cdp-endpoint'; headless?: boolean; cdpEndpoint?: string }): Promise<Session>;
  get(id: string): Session | null;
  list(): Session[];
  close(id: string): Promise<void>;
  reconnect(id: string): Promise<Session>;
  page(sessionId: string, pageId?: string): PageHandle;      // default: active page
  pages(sessionId: string): PageInfo[];
  newPage(sessionId: string, url?: string): Promise<PageInfo>;
  selectPage(sessionId: string, pageId: string): Promise<void>;
  closePage(sessionId: string, pageId: string): Promise<void>;
}
```

Behaviour:
- `open`: if a session for that profile is live (`status` not `closed`/`disconnected`) → **return it** (CODING_AGENT rule 17). Otherwise launch, register pages, set `activePageId` to the first page, persist to `sessions`, emit `session.status`.
- **New tabs/popups:** a page opened by an action becomes the active page; the `ActionResult.url` reflects it and an event `session.status` with `reason: 'active-page-changed'` is emitted. Closing the active page falls back to its opener, else the most recent page.
- **Disconnect/crash:** `onDisconnected` → status `disconnected`, event. `reconnect(id)` relaunches the same profile (cookies survive on disk), restores the last active URL in a new page, and sets status `ready`. The router calls `reconnect` once on `BROWSER_DISCONNECTED` before giving up (action-router §4.1).
- **Daemon start:** sessions persisted as live from a previous daemon run are marked `closed` (their browser died with the old daemon; LaunchProvider is pipe-based).
- **Idle timeout:** `config.sessionIdleMinutes` (default `0` = never).
- **Status `busy`** while the per-page lock is held; `waiting_for_human` while a human gate is open.

---

## 4. CDP sessions and isolated worlds (`packages/browser/src/cdp/`)

- `cdp(page)`: `context.newCDPSession(page)` wrapped as a `CdpTransport`; created once per page, on creation enable `Page`, `DOM`, `DOMSnapshot`, `Accessibility`, `Network`. **Do not** call `Runtime.enable` (unnecessary console/exception traffic; isolated worlds do not need it).
- **Isolated world `bos`:** `IsolatedWorlds.get(frameId)` returns an `executionContextId`, created with `Page.createIsolatedWorld({ frameId, worldName: 'bos', grantUniveralAccess: false })` (sic: the parameter really is spelled `Univeral` in CDP) and cached until `Page.frameNavigated` for that frame. On creation, install the helpers bundle (mutation counter, probe helper, value reader). The helpers are an idempotent string from `packages/browser/src/cdp/helpers.js.ts`.
- All page-side JavaScript runs **only** in the `bos` world. Never `page.evaluate` in the main world, because page scripts could observe or tamper with it.
- `CountingCdpTransport` wrapper (tests/benchmarks) counts round trips per method.

---

## 5. PageDriver (`packages/browser/src/driver/`)

```ts
export interface ResolvedTarget {
  backendNodeId: number;
  cdpFrameId: string;
  locator: ElementLocator;     // for the Playwright fallback
  role: string;
  name: string;
}

export interface DriverResult {
  ok: boolean;
  effect: 'none' | 'committed' | 'unknown';   // action-router §4.1
  error?: { code: ErrorCode; message: string };
  urlBefore: string;
  urlAfter: string;
  navigated: boolean;
  newPageId?: string;
}

export interface PageDriver {
  cdpPerform(action: BrowserAction, target: ResolvedTarget | null, value?: string): Promise<DriverResult>;
  playwrightPerform(action: BrowserAction, target: ResolvedTarget | null, value?: string): Promise<DriverResult>;
  navigate(url: string, timeoutMs: number): Promise<DriverResult>;
  readValue(target: ResolvedTarget): Promise<string | null>;
  settle(quietMs: number, maxMs: number): Promise<{ waitedMs: number; capped: boolean }>;
  mutationCounter(): Promise<number>;
  extract(target: ResolvedTarget | null, format: 'text' | 'links' | 'table'): Promise<unknown>;
  uploadFiles(target: ResolvedTarget, paths: string[]): Promise<DriverResult>;   // policy checked by runtime
  screenshot(): Promise<{ base64: string; mediaType: 'image/png' }>;             // vision tier only (post-MVP use)
}
```

CDP executor details are in action-router §6. Additional rules:
- **Hit-test acceptance:** `DOM.getNodeForLocation(x, y, includeUserAgentShadowDOM: true)` returns a node that is the target, a descendant of it, or (for checkbox/radio) inside an associated `<label>`. Anything else → `TARGET_OBSCURED`, `effect: 'none'`.
- Coordinates: `DOM.getContentQuads` returns viewport coordinates of the frame's own document; for same-process iframes CDP already returns top-level coordinates. OOPIF composition is P11-02.
- Mouse sequence: `mouseMoved` → `mousePressed` (`clickCount`) → `mouseReleased`. If an exception occurs after `mousePressed` was sent → `effect: 'unknown'`.
- `navigate` uses Playwright `page.goto(url, { waitUntil: 'domcontentloaded', timeout })`. `chrome-error://` final URL → `NAVIGATION_FAILED`.
- `settle`: tracks in-flight `Document`/`XHR`/`Fetch` requests from `Network.requestWillBeSent` / `loadingFinished` / `loadingFailed` and the isolated-world mutation counter. It returns when both have been quiet for `quietMs`, or at `maxMs`.
- `extract`: `text` → visible text of the target or the page (via the `bos` world helper, max 20k chars); `links` → `{ text, href }[]`; `table` → first `<table>` under target as `string[][]`.

---

## 6. Downloads and uploads

- Downloads: when `policy.downloads.enabled`, Playwright `download` events save to `policy.downloads.dir ?? <BOS_HOME>/downloads/<sessionId>/` with a sanitized filename; event `session.status` with `reason: 'download-complete'` and the path. Disabled → downloads are cancelled.
- Uploads: `BrowserAction` `{ type: 'upload', target, paths }` (integration §3), executed by the Playwright path via `uploadFiles`. The runtime rejects paths outside `policy.uploads.allowedDirs` (resolved, symlinks followed) with `PERMISSION_DENIED`. Upload is risk `medium` (R8).

---

## 7. Test requirements (summary)

- Executable discovery: table tests with fake filesystem per OS.
- Profile manager: rejects dirs outside `<BOS_HOME>/profiles`, name validation, lock detection.
- LaunchProvider (browser test, Chromium in CI): launch, page list, newPage, close; cookie set on fixture site persists across close + reopen of the same profile.
- Session manager: `open` twice returns the same session; crash simulation (kill browser pid) → `disconnected` → `reconnect` → `ready`, last URL restored.
- CdpEndpointProvider: rejects non-loopback endpoints; attaches to a Chromium started by the test with `--remote-debugging-port=0` on a temp profile.
- CDP executor on fixture pages: click, fill (input, textarea, contenteditable), press, select, scroll, hover; obscured button → `TARGET_OBSCURED`, `effect: 'none'`; Playwright fallback succeeds.
- `settle` returns within `maxMs` on a page with constant polling.
- Isolated world: helpers are not visible from the main world (`typeof window.__bos === 'undefined'` in main world).

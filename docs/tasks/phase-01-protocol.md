# Phase 1: Protocol (`packages/protocol`)

Read first: `docs/specs/data-models.md` (entire file), `docs/specs/protocol.md` §3–5.
All tasks: `supervision: cheap-ok`. Runtime dependency allowed: `zod`.

---

## P1-01 · IDs and errors

| Field | Value |
|---|---|
| depends_on | P0-01 |
| size | S |
| spec | data-models §1–2 |

**Files:** `packages/protocol/src/ids.ts`, `src/errors.ts`, export from `src/index.ts`; tests `test/ids.test.ts`, `test/errors.test.ts`.

**Requirements**
1. `newId(prefix)` exactly per spec (Crockford base32: `0123456789ABCDEFGHJKMNPQRSTVWXYZ`; 10 time chars + 16 random chars from `crypto.getRandomValues`).
2. IDs created in increasing ms are lexicographically increasing (after the prefix).
3. `BosError` with `code`, `details`, `retryable` (defaults per spec), `cause` passed to `super`, `toJSON()`. `isBosError()` works across realms (check `name === 'BosError' && typeof code === 'string'`).

**Tests:** format regex `/^ses_[0-9A-HJKMNP-TV-Z]{26}$/`; 10k ids unique; ordering across a mocked clock; retryable defaults for every code; `toJSON` shape.

**Acceptance criteria**
- [ ] Types and behaviour match spec exactly

**Implementation notes**

Implemented 2026-10-04. Two choices worth knowing:

- **`ERROR_CODES` is the single source of the `ErrorCode` union**: the array is declared with `as const` and the type is
  `(typeof ERROR_CODES)[number]`. Adding a code is one edit, the type cannot drift from the list, and tests can enumerate
  every code — which is how the "retryable defaults for every code" requirement is actually verified. It lives in `errors.ts`,
  not a new file, because the card fixes the file list.
- **`ID_PREFIXES` is exported** for the same reason: the test table iterates the real prefix list instead of a copy.
- `newId` uses the global `crypto.getRandomValues` (no import), 16 bytes for 16 chars. The `% 32` mapping is unbiased
  because 256 is divisible by 32.

The card's regex is given for `ses_` specifically; prefix lengths differ (`pg` = 2, `perm` = 4), so the test builds the
pattern per prefix rather than assuming three letters.

Verification: `pnpm build`, `pnpm lint` (boundaries OK), `pnpm test` → 16 files / 56 tests pass. `packages/protocol/src`
reports 100% statements, branches and lines.

---

## P1-02 · Data model types

| Field | Value |
|---|---|
| depends_on | P1-01 |
| size | M |
| spec | data-models §3–10 |

**Files:** `src/browser.ts`, `src/dom.ts`, `src/actions.ts`, `src/tasks.ts`, `src/policy.ts`, `src/context.ts`, `src/model.ts`, `src/events.ts`; test `test/types.test.ts`.

**Requirements**
1. Copy every type from the spec verbatim (names, fields, optionality, comments).
2. Implement the two runtime constants: `TARGETLESS` (`ReadonlySet<ActionType>` = navigate, wait) plus helper `hasTarget(action): boolean` (true if `'target' in action && action.target !== undefined`), and `DEFAULT_POLICY: Policy` with the defaults listed in the spec comments (`downloads: { enabled: false, dir: null }`, `uploads: { allowedDirs: [] }`, `sites: []`, `tiers: { llm: true, vision: false, human: true }`).
3. `mergePolicy(base: Policy, override: DeepPartial<Policy>): Policy` (pure; arrays replaced, not merged).

**Tests:** `expectTypeOf` checks for discriminated unions (`BrowserAction`, `Target`, `ValueSource`); `hasTarget` cases; `mergePolicy` cases.

**Acceptance criteria**
- [ ] `pnpm -r typecheck` passes; types identical to spec

**Implementation notes**

Implemented 2026-10-04. Notes for the next agent:

- All eight files from the card exist and mirror `data-models.md` §3–§10 field for field, comments included. Every
  cross-file reference uses `import type`, so the modules have no runtime dependency on each other and `index.ts` can
  re-export all of them in dependency order without a cycle.
- **`TARGETLESS` vs `hasTarget`.** The spec comment lists the targetless types as "navigate, wait, (press|scroll|extract
  when target undefined)". A `Set` cannot express a conditional, so `TARGETLESS` holds only `navigate` and `wait` while
  `hasTarget(action)` answers the real question per action (`'target' in action && action.target !== undefined`). Both are
  required by the card and both are tested.
- `DEFAULT_POLICY` and `mergePolicy` live in `policy.ts` together with `DeepPartial`. `mergePolicy` merges nested objects
  key by key and **replaces** arrays (an override listing three upload directories means exactly three); `sites` is replaced
  wholesale because order decides which policy matches first.
- `ActionResult.risk` is `RiskLevel | null` and `error.details` is `Record<string, unknown>` as fixed by integration §3.

Verification: `pnpm build`, `pnpm lint` (boundaries OK), `pnpm test` → 17 files / 67 tests pass. The `types.test.ts`
`expectTypeOf` assertions are the compile-time proof that the discriminated unions kept their shapes: `pnpm build` fails
if they drift.

---

## P1-03 · Zod schemas and RPC method table

| Field | Value |
|---|---|
| depends_on | P1-02 |
| size | M |
| spec | data-models (all), protocol §3–4 |

**Files:** `src/schemas.ts`, `src/rpc.ts`; tests `test/schemas.test.ts`, `test/rpc.test.ts`.

**Requirements**
1. A zod schema for every protocol-crossing type: `BrowserProfile`, `Session`, `PageInfo`, `FrameInfo`, `SemanticElement`, `TextBlock`, `Observation`, `ElementLocator`, `ValueSource`, `Target`, `BrowserAction`, `ActionResult`, `Task`, `Trajectory`, `TrajectoryStep`, `ActionCacheEntry`, `Policy` (with defaults via `.default()` matching `DEFAULT_POLICY`), `PermissionRequest`, `BosEvent` envelope. Name them `XxxSchema`. Add a compile-time check that `z.infer<typeof XxxSchema>` is assignable to `Xxx` and vice versa (helper type `AssertEqual`).
2. Validation constraints from the spec: profile name regex, task key regex, ref regex `^e\d+$`, `TextBlock` ref `^t\d+$`, max lengths where specified.
3. `rpc.ts`: `export const RPC_METHODS = { 'system.hello': { params: ..., result: ... }, ... }` for **every** method in protocol §4, plus `type RpcMethod = keyof typeof RPC_METHODS`, `type RpcParams<M>`, `type RpcResult<M>`. Also the JSON-RPC envelope schemas (request, success response, error response, notification) and `toRpcError(e: unknown)` mapping `BosError` → `{ code: -32000, message, data: { bosCode, retryable, details } }` and unknown errors → `INTERNAL`.
4. `PROTOCOL_VERSION = '1'`.
5. `ConfigSchema` for `config.json` (protocol §6), all fields optional with defaults.

**Tests:** for each schema, one valid sample passes and two invalid samples fail; every RPC method has params and result schemas; `toRpcError` mapping.

**Acceptance criteria**
- [ ] Every method in protocol §4 is present in `RPC_METHODS`
- [ ] Type/schema equality assertions compile

---

## P1-04 · Masking, EventBus, paths, target syntax

| Field | Value |
|---|---|
| depends_on | P1-02 |
| size | S |
| spec | data-models §10 and file layout; memory §2; protocol §5 (target syntax) |

**Files:** `src/mask.ts`, `src/event-bus.ts`, `src/paths.ts`, `src/target-syntax.ts`, `src/clock.ts` (`systemClock: Clock`); tests for each.

**Requirements**
1. `SENSITIVE_NAME_RE`, `isSensitiveName()`, `isSensitiveField()` and `maskAction(action, opts?: { sensitiveTarget?: boolean })` exactly as in `docs/specs/integration.md` §2. `maskAction` masks `literal` values when `sensitiveTarget` is true; callers pass `true` before resolution.
2. `EventBus`: `on(type | '*', handler) → unsubscribe`, `emit(event)`. Handlers run synchronously, and an exception in one handler does not stop the others (catch and report via an optional `onError` constructor callback).
3. `resolveBosHome(env, platform, homedir)` per memory §2 (pure; inputs injected).
4. `parseTargetString(s: string, lastObservationId: string | null): Target` per protocol §5: `@e12` → ref (throws `INVALID_REQUEST` if `lastObservationId` is null); `key=value` pairs with keys `role|name|text|css|nth` (values may be double-quoted) → query; anything else → intent.

**Tests:** table-driven for each function; EventBus wildcard and error isolation; `resolveBosHome` for win32/darwin/linux with and without `BOS_HOME`/`XDG_DATA_HOME`; target parsing edge cases (`role=button name="Sign in"`, `"the search box"`, `@e3`).

**Acceptance criteria**
- [ ] 100% branch coverage on `mask.ts` and `target-syntax.ts`

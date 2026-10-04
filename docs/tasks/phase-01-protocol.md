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

**Implementation notes**

Implemented 2026-10-04. `src/schemas.ts` (22 protocol-crossing schemas + `HumanRequest`/`HumanAnswer` + the event union)
and `src/rpc.ts` (36 methods, wire envelopes, `toRpcError`, `ConfigSchema`). `zod@4.6.5` is the package's only runtime dependency.

**One real bug this task surfaced, worth remembering for the other packages:** `rpc.ts` first imported `BosError`,
`ErrorCodeSchema` and `isBosError` from the barrel `./index.js` — and `index.js` re-exports `rpc.js`. That is a runtime
cycle: `index` starts evaluating `rpc`, `rpc` reads back a partially initialised `index`, and `ErrorCodeSchema` arrives as
`undefined`. zod v4 builds object shapes lazily, so the module loaded fine and only *threw on the first parse*
("Invalid element at key 'bosCode': expected a Zod schema"). The rule for every later package: a module the barrel
re-exports must import its siblings by concrete path, never through the barrel.

Three zod v4 behaviours that cost time and are now encoded in the tests:
- `z.record(z.enum([...]), value)` requires **every** enum key. That is right for `Policy.risk` (the type is a full
  `Record<RiskLevel, …>` and protocol §6 spells all three); partial overrides are `mergePolicy`'s job, not the schema's.
- `.default()` on an object whose fields already have defaults needs the **full output** value, not `{}`
  (hence `PolicySchema.default(DEFAULT_POLICY)`), and the type error only appears at that call site.
- `z.enum` accepts the `ERROR_CODES` array directly, so `ErrorCodeSchema` picks up any new code automatically.

Tests: a table of 22 schemas each with one valid and two invalid samples (44 negative cases), the 36-method contract
against the protocol §4 list, `toRpcError` for BosError / plain Error / non-errors, the four wire envelopes, and
`ConfigSchema` defaults. `pnpm build` also runs the 19 `AssertEqual` checks, so a schema that drifts from its interface
fails the build rather than a test.

Verification: `pnpm build`, `pnpm -r typecheck`, `pnpm lint` (boundaries OK), `pnpm test` → 19 files / 129 tests pass
(62 more than P1-02). `packages/protocol/src` coverage 89.6% statements / 95.7% branches.

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

**Implementation notes**

Implemented 2026-10-04. Five files: `mask.ts`, `event-bus.ts`, `paths.ts`, `target-syntax.ts`, `clock.ts`.
`mask.ts` and `target-syntax.ts` both report **100% branch coverage**.

Decisions the specs left open, each now pinned by a test:

1. **`maskAction` defaults `sensitiveTarget` to `true`** (integration §2: before resolution the element is unknown, so
   every literal is masked) and always returns a **new** action object — the input is never mutated, and the tests assert
   that plus idempotence and that the original value appears nowhere in the output.
2. **`fieldsOf` lives in `mask.ts`.** integration §2 requires the mapping (`type`→inputType, `aria-label`→ariaLabel) and the
   card fixes the file list, so it sits beside the check it feeds.
3. **`paths.ts` joins with the separator of the *platform argument*, never the host.** Otherwise "resolveBosHome is correct
   on win32/darwin/linux" could only be tested on three machines. A missing/empty `LOCALAPPDATA` falls back to
   `<home>/AppData/Local`, and `BOS_HOME=''` is treated as unset (an unset variable is often exported as an empty string).
4. **`parseTargetString` throws `INVALID_REQUEST` for an empty or whitespace-only target** instead of returning an empty
   intent: an empty target is a caller bug, and failing with a clear code beats a confusing `TARGET_NOT_FOUND` later.
   Everything else follows the documented catch-all, including `@nope` → intent.
5. **A fully quoted intent is unwrapped** (`"the search box"` → text `the search box`). Quoting groups words, the way a
   shell does; keeping the quotes in the target text would leak syntax into the intent. A lone unmatched quote is kept as-is.
6. **`EventBus` swallows a throwing handler when no `onError` was given.** Library code must not write to the console
   (CODING_AGENT §7), so the choice is report-via-callback or drop; both are tested, along with unsubscribe-during-emit and
   subscribe-during-emit.

**One unreachable branch was deleted, not tested.** `tokenize` guarded its tail token with `current.length > 0`, which can
never be false because the caller trims first. Rather than write a test for code that cannot fail (CODING_AGENT §5), the
guard is gone — that is what took `target-syntax.ts` from 98.57% to 100% branch coverage.

**A type error only `pnpm build` caught:** `mask.ts` imported `ElementLocator` from `actions.js` instead of `dom.js`. All 191
tests passed anyway, because esbuild strips types without checking them. This is the concrete reason the documented
verification order is build → typecheck → lint → test and not the reverse.

**Reading the coverage table:** `funcs` shows 50% for these files and `mask.ts` shows 95% statements with *no* uncovered
lines. That is a measurement artifact — v8 counts each function twice (the source and its transformed copy) and the second
copy is never entered, so `5/10` functions is really `5/5`. Lines and branches are reliable; the 50% is not.

Verification: `pnpm build`, `pnpm -r typecheck`, `pnpm lint` (boundaries OK), `pnpm test` → 24 files / 193 tests pass
(64 more than P1-03).

// Steps F and G of action-router §4 (dispatch, verify, settle) plus the `action_runs`
// write of §8, kept out of the router so the effect rule has one home.
//
// The driver never throws on a failed action (packages/browser): it answers with a
// `DriverResult` whose `effect` says whether anything reached the page (§4.1). A driver
// that *does* throw — the older contract the unit-test fakes still speak — is read into
// the same shape, so one rule covers both:
//
//   none      → nothing was dispatched, so Playwright may retry it exactly once;
//   committed → it went out; verify and settle it, never re-dispatch;
//   unknown   → it may have gone out (S20): fail as ACTION_FAILED carrying the effect.
//
// `execute` turns every failure here into a failed ActionResult; nothing below escapes
// the router as an exception.

import type { DriverResult, PageDriver, ResolvedTarget } from '@browser-os/browser';
import type { ActionResult, BrowserAction, ErrorCode, ExecutionContext } from '@browser-os/protocol';
import { ERROR_CODES } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import { originOfUrl, type RouterConstants, type RunPort } from './types.js';
import { pageChanged, settleAfter, verifyAction } from './verify.js';

/** Which executor actually ran the action (the `driver` field of ActionResult). */
export type DriverName = 'cdp' | 'playwright';

export interface DispatchOutcome {
  via: DriverName;
  result: DriverResult;
}

/**
 * Step F: dispatch through CDP, fall back to Playwright only while the failed attempt
 * provably had no effect, and throw a `BosError` if both executors failed.
 */
export async function dispatch(input: {
  action: BrowserAction;
  target: ResolvedTarget;
  value: string | undefined;
  driver: PageDriver;
}): Promise<DispatchOutcome> {
  const { action, target, value, driver } = input;

  const cdp = await attempt(() => driver.cdpPerform(action, target, value));
  if (cdp.ok) return { via: 'cdp', result: cdp };
  if (cdp.effect !== 'none') throw hardFailure(cdp);

  const playwright = await attempt(() => driver.playwrightPerform(action, target, value));
  if (playwright.ok) return { via: 'playwright', result: playwright };
  throw hardFailure(playwright);
}

/**
 * Runs one driver call and normalizes every way it can come back:
 * - a `DriverResult` → used as-is;
 * - a throw carrying `code`/`effect` → the older driver contract, read into a result;
 * - a throw with neither → `unknown`, because an unexplained failure proves nothing;
 * - no result at all → `unknown` too: absence of an answer is not proof that nothing
 *   happened, so it must never authorize a retry.
 */
export async function attempt(run: () => Promise<DriverResult | undefined>): Promise<DriverResult> {
  try {
    const result = await run();
    if (result && typeof result.ok === 'boolean') return result;
    return unreported('the driver returned no result');
  } catch (error) {
    const raw = (error ?? {}) as { code?: unknown; effect?: unknown; message?: unknown };
    const effect =
      raw.effect === 'none' || raw.effect === 'committed' || raw.effect === 'unknown' ? raw.effect : 'unknown';
    const code =
      typeof raw.code === 'string' && (ERROR_CODES as readonly string[]).includes(raw.code)
        ? (raw.code as ErrorCode)
        : 'ACTION_FAILED';
    const message = typeof raw.message === 'string' && raw.message !== '' ? raw.message : String(error);
    return unreported(message, code, effect);
  }
}

function unreported(
  message: string,
  code: ErrorCode = 'ACTION_FAILED',
  effect: 'none' | 'committed' | 'unknown' = 'unknown',
): DriverResult {
  return { ok: false, effect, error: { code, message }, urlBefore: '', urlAfter: '', navigated: false };
}

/**
 * One action, one failure (§4.1 / S20):
 * - `none` — even the Playwright fallback reached nothing, so the driver's own code is
 *   the useful answer, and `details.effect` records why a retry would be pointless;
 * - anything else — input may have gone out: `ACTION_FAILED` carrying the effect, and
 *   this run never re-dispatches it.
 */
function hardFailure(result: DriverResult): BosError {
  const { effect } = result;
  const message = result.error?.message ?? 'the driver could not perform the action';
  const code: ErrorCode = effect === 'none' ? (result.error?.code ?? 'ACTION_FAILED') : 'ACTION_FAILED';
  return new BosError(code, message, { details: { effect } });
}

/** Where the action left the page, and any tab it opened. */
export interface Aftermath {
  url: string;
  newPageId: string | undefined;
}

/**
 * Step G: verify what §7 can verify (skipped when the navigation already decided the
 * answer), let the page settle, and report the boundary the action crossed.
 */
export async function verifyAndSettle(input: {
  action: BrowserAction;
  driver: PageDriver;
  target: ResolvedTarget;
  value: string | undefined;
  driverResult: DriverResult;
  changed: boolean;
  constants: RouterConstants;
  actionTimeoutMs: number;
}): Promise<Aftermath> {
  const { action, driver, target, value, driverResult, changed, constants, actionTimeoutMs } = input;
  await verifyAction({ action, driver, target, value, changed });
  await settleAfter(driver, constants, actionTimeoutMs, changed);
  return { url: driverResult.urlAfter ?? '', newPageId: driverResult.newPageId ?? undefined };
}

/**
 * Did the action cross a navigation boundary (action-router §7)? Computed by the caller
 * *before* verify, so a failed verification still reports the navigation that happened.
 */
export function crossedBoundary(result: DriverResult): boolean {
  return pageChanged(result.urlBefore ?? '', result.urlAfter ?? '', result.navigated === true);
}

/**
 * The quiet window after a targetless `navigate`: the navigation already waited for its
 * own load, this waits out late SPA renders before the aftermath is read. Distinct from
 * `settleAfter`, whose `changed` flag says a navigation *happened mid-dispatch* and would
 * skip the wait.
 */
export async function settleAfterNavigate(
  driver: PageDriver,
  constants: RouterConstants,
  actionTimeoutMs: number,
): Promise<void> {
  try {
    await driver.settle(constants.settleQuietMs, Math.min(constants.settleMaxMs, actionTimeoutMs));
  } catch {
    // Settling is best effort: a driver that cannot settle still delivered the navigation.
  }
}

/**
 * action-router §8 / memory §3: one `action_runs` row per executed action — failures
 * included, because that is where the error codes and per-tier latencies live.
 *
 * Best effort by design: a store that cannot write must not turn an action that already
 * reached the page into an error. P7-06 owns what a failed write does beyond this.
 */
export function persistRun(runs: RunPort, ctx: ExecutionContext, result: ActionResult): void {
  try {
    runs.insert({ sessionId: ctx.sessionId, taskId: ctx.taskId, origin: originOfUrl(result.url) }, result);
  } catch {
    // Swallowed on purpose: the ActionResult in the caller's hand is the source of truth.
  }
}

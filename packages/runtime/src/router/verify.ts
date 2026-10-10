import type { PageDriver, ResolvedTarget } from '@browser-os/browser';
import type { BrowserAction } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import type { Resolution, RouterConstants } from './types.js';

export function toResolvedTarget(resolution: Resolution): ResolvedTarget {
  const { entry, element } = resolution;
  return {
    backendNodeId: entry.backendNodeId,
    cdpFrameId: entry.cdpFrameId,
    locator: entry.locator,
    role: element.role,
    name: element.name,
  };
}

/** True when the action crossed a navigation boundary (action-router §7). */
export function pageChanged(urlBefore: string, urlAfter: string, navigated: boolean): boolean {
  return navigated || urlAfter !== urlBefore;
}

/**
 * action-router §7: only `fill` and `select` are verifiable by reading the
 * field back; click, press, hover and scroll stay dispatched-state machines.
 * Values never reach the error message or its details — the field is masked by
 * `maskAction`, and an error must not undo that.
 */
export async function verifyAction(input: {
  action: BrowserAction;
  driver: PageDriver;
  target: ResolvedTarget;
  value: string | undefined;
  changed: boolean;
}): Promise<void> {
  const { action, driver, target, value, changed } = input;
  if (changed || value === undefined) return;
  if (action.type !== 'fill' && action.type !== 'select') return;

  const actual = await driver.readValue(target);
  if (actual === value) return;

  throw new BosError('VERIFICATION_FAILED', 'The field does not hold the requested value', {
    details: { type: action.type, role: target.role, name: target.name },
  });
}

/**
 * action-router §7 quiet window. `settle` is capped by both the constant and
 * the per-action budget, and never fails an action that already succeeded.
 */
export async function settleAfter(
  driver: PageDriver,
  constants: RouterConstants,
  actionTimeoutMs: number,
  changed: boolean,
): Promise<void> {
  if (changed) return;
  try {
    await driver.settle(constants.settleQuietMs, Math.min(constants.settleMaxMs, actionTimeoutMs));
  } catch {
    // Settling is best effort: a driver that cannot settle still delivered the action.
  }
}

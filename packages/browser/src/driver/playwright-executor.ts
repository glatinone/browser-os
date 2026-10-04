// The Playwright executor: the fallback the router reaches for when the CDP path refused the
// target (action-router §6). It is only ever used after `effect: 'none'` — falling back after
// `unknown` could run the same action twice (§4.1).

import { BosError, type BrowserAction } from '@browser-os/protocol';
import type { Locator, Page } from 'playwright-core';
import { locatorFor } from './locator-for.js';
import { type DriverOutcome, refuse, unsure } from './op.js';
import type { ResolvedTarget } from './types.js';

/** The budget the spec gives the fallback. */
const ACTION_TIMEOUT_MS = 2000;
const DEFAULT_SCROLL_PX = 600;

export async function playwrightPerform(
  page: Page,
  action: BrowserAction,
  target: ResolvedTarget | null,
  value?: string,
): Promise<DriverOutcome> {
  try {
    switch (action.type) {
      case 'click': {
        const locator = await needLocator(page, action.type, target);
        await locator.click({
          timeout: ACTION_TIMEOUT_MS,
          ...(action.button === undefined ? {} : { button: action.button }),
          ...(action.clickCount === undefined ? {} : { clickCount: action.clickCount }),
        });
        return committed();
      }
      case 'hover': {
        const locator = await needLocator(page, action.type, target);
        await locator.hover({ timeout: ACTION_TIMEOUT_MS });
        return committed();
      }
      case 'fill': {
        const locator = await needLocator(page, action.type, target);
        await locator.fill(needValue(action.type, value), { timeout: ACTION_TIMEOUT_MS });
        if (action.submit === true) await locator.press('Enter', { timeout: ACTION_TIMEOUT_MS });
        return committed();
      }
      case 'press': {
        // Without a target the key goes to the page, which is how `press` is defined.
        if (target === null) {
          await page.keyboard.press(action.key);
          return committed();
        }
        const locator = await needLocator(page, action.type, target);
        await locator.press(action.key, { timeout: ACTION_TIMEOUT_MS });
        return committed();
      }
      case 'select': {
        const locator = await needLocator(page, action.type, target);
        await locator.selectOption(needValue(action.type, value), { timeout: ACTION_TIMEOUT_MS });
        return committed();
      }
      case 'scroll': {
        const deltaY = (action.direction === 'down' ? 1 : -1) * (action.amountPx ?? DEFAULT_SCROLL_PX);
        if (target !== null) {
          const locator = await needLocator(page, action.type, target);
          await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
        }
        await page.mouse.wheel(0, deltaY);
        return committed();
      }
      default:
        throw new BosError('INVALID_REQUEST', `the Playwright executor does not do ${action.type}`, {});
    }
  } catch (error) {
    return failed(error, action.type);
  }
}

async function needLocator(page: Page, actionType: string, target: ResolvedTarget | null): Promise<Locator> {
  if (target === null) {
    throw new BosError('INVALID_REQUEST', `A ${actionType} needs a target`, {});
  }
  return await locatorFor(page, target.locator);
}

function needValue(actionType: string, value: string | undefined): string {
  if (value === undefined) {
    throw new BosError('INVALID_REQUEST', `A ${actionType} needs a value`, {});
  }
  return value;
}

/**
 * Playwright's timeout message says whether it ever got as far as acting: "waiting for … to be
 * visible / enabled / stable / receive events" means it did not, so the effect is `none` and the
 * router may still retry or escalate. Anything else may have gone out, so it is `unknown`.
 */
function failed(error: unknown, actionType: string): DriverOutcome {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' && message.includes('waiting for')) {
    return refuse('TARGET_NOT_INTERACTABLE', `${actionType} never reached the element: ${message}`);
  }
  return unsure(error);
}

function committed(): DriverOutcome {
  return { ok: true, effect: 'committed' };
}

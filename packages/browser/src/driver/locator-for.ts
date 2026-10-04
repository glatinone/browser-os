// Playwright locators from a stored `ElementLocator` (action-router §6).
//
// The order is the spec's, and it matters: a test-only attribute is the most precise handle a
// page can offer, a role+name pair is next, and a CSS path is the last resort.

import { BosError, type ElementLocator } from '@browser-os/protocol';
import type { FrameLocator, Locator, Page } from 'playwright-core';

/** Test-only attributes, in the order the spec tries them. */
const TEST_ATTRIBUTES = ['data-testid', 'data-test', 'data-qa'] as const;

type Scope = Page | FrameLocator;

export interface LocatorStrategy {
  /** A short name for the strategy; the unit tests assert the order through it. */
  readonly name: string;
  build(scope: Scope): Locator;
}

/**
 * Every strategy that could address this locator, best first. Exported because the order is the
 * contract, and a test that cannot see the candidate list can only guess at it.
 */
export function locatorStrategies(locator: ElementLocator): LocatorStrategy[] {
  const strategies: LocatorStrategy[] = [];

  for (const attribute of TEST_ATTRIBUTES) {
    const value = locator.attrs[attribute];
    if (value !== undefined && value !== '') {
      strategies.push({
        name: attribute,
        build: (scope) => scope.locator(`[${attribute}="${escapeValue(value)}"]`),
      });
    }
  }

  if (!locator.nameIsDynamic && locator.role !== '' && locator.name !== '') {
    strategies.push({
      name: 'role',
      // `getByRole` types the role as a union; the resolver already produced a real one.
      build: (scope) =>
        scope.getByRole(locator.role as Parameters<Scope['getByRole']>[0], {
          name: locator.name,
          exact: true,
        }),
    });
  }

  const id = locator.attrs.id;
  if (id !== undefined && id !== '') {
    strategies.push({ name: 'id', build: (scope) => scope.locator(`#${escapeValue(id)}`) });
  }

  if (locator.cssPath !== '') {
    strategies.push({ name: 'cssPath', build: (scope) => scope.locator(playwrightCss(locator.cssPath)) });
  }

  return strategies;
}

export async function locatorFor(page: Page, locator: ElementLocator): Promise<Locator> {
  const strategy = locatorStrategies(locator)[0];
  if (strategy === undefined) {
    throw new BosError('TARGET_NOT_FOUND', 'the locator carries nothing to look for', {
      details: { locator },
    });
  }

  let scope: Scope = page;
  for (const frame of locator.framePath) scope = scope.frameLocator(frame);

  const built = strategy.build(scope);
  // `.nth()` only when the strategy is genuinely ambiguous: on a unique locator it would turn a
  // working strategy into a strict-mode failure.
  if ((await built.count()) > 1) return built.nth(locator.ordinal);
  return built;
}

/** CDP writes shadow boundaries as `" >>> "`; Playwright's own CSS pierces open shadow roots. */
export function playwrightCss(cssPath: string): string {
  return cssPath
    .split('>>>')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
}

function escapeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

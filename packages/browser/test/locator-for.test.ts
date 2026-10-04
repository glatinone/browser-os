import type { ElementLocator } from '@browser-os/protocol';
import type { Locator, Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { locatorFor, locatorStrategies, playwrightCss } from '../src/driver/locator-for.js';

interface Call {
  kind: string;
  detail: unknown;
}

/** Stands in for a page, a frame or a locator: only the calls matter here. */
class FakeScope {
  constructor(
    readonly calls: Call[],
    readonly matches = 1,
  ) {}

  locator(selector: string): Locator {
    this.calls.push({ kind: 'locator', detail: selector });
    return this as unknown as Locator;
  }

  getByRole(role: string, options: unknown): Locator {
    this.calls.push({ kind: 'getByRole', detail: { role, options } });
    return this as unknown as Locator;
  }

  frameLocator(selector: string): FakeScope {
    this.calls.push({ kind: 'frameLocator', detail: selector });
    return new FakeScope(this.calls, this.matches);
  }

  nth(index: number): Locator {
    this.calls.push({ kind: 'nth', detail: index });
    return this as unknown as Locator;
  }

  async count(): Promise<number> {
    return this.matches;
  }
}

function fakePage(matches = 1): { page: Page; calls: Call[] } {
  const calls: Call[] = [];
  return { page: new FakeScope(calls, matches) as unknown as Page, calls };
}

function locator(overrides: Partial<ElementLocator> = {}): ElementLocator {
  return {
    v: 1,
    role: 'button',
    name: 'Save',
    nameIsDynamic: false,
    tag: 'button',
    attrs: {},
    context: [],
    cssPath: '',
    framePath: [],
    ordinal: 0,
    ...overrides,
  };
}

describe('locatorStrategies order', () => {
  it('prefers a test attribute over everything else', () => {
    const strategies = locatorStrategies(locator({ attrs: { 'data-testid': 'save', id: 'save' }, cssPath: '#save' }));

    expect(strategies.map((strategy) => strategy.name)).toEqual(['data-testid', 'role', 'id', 'cssPath']);
  });

  it('tries the three test attributes in the spec order', () => {
    const strategies = locatorStrategies(
      locator({ attrs: { 'data-test': 'b', 'data-qa': 'c', 'data-testid': 'a' }, role: '', name: '' }),
    );

    expect(strategies.map((strategy) => strategy.name)).toEqual(['data-testid', 'data-test', 'data-qa']);
  });

  it('skips the role when the name was dynamic, and skips the id when there is none', () => {
    const strategies = locatorStrategies(locator({ nameIsDynamic: true, cssPath: 'button.save' }));

    expect(strategies.map((strategy) => strategy.name)).toEqual(['cssPath']);
  });

  it('has nothing to offer for a locator that carries no handle at all', () => {
    expect(locatorStrategies(locator({ role: '', name: '' }))).toEqual([]);
  });
});

describe('locatorFor', () => {
  it('builds exactly one locator, from the best strategy', async () => {
    const { page, calls } = fakePage();

    await locatorFor(page, locator({ attrs: { 'data-testid': 'save', id: 'save' }, cssPath: '#save' }));

    expect(calls).toEqual([{ kind: 'locator', detail: '[data-testid="save"]' }]);
  });

  it('asks for the role with an exact name when there is no test attribute', async () => {
    const { page, calls } = fakePage();

    await locatorFor(page, locator());

    expect(calls).toEqual([{ kind: 'getByRole', detail: { role: 'button', options: { name: 'Save', exact: true } } }]);
  });

  it('flattens shadow boundaries, which Playwright pierces by itself', async () => {
    const { page, calls } = fakePage();

    await locatorFor(page, locator({ role: '', name: '', cssPath: 'bos-panel >>> #save' }));

    expect(calls).toEqual([{ kind: 'locator', detail: 'bos-panel #save' }]);
    expect(playwrightCss('a >>> b >>> c')).toBe('a b c');
  });

  it('enters the frames in order, outermost first', async () => {
    const { page, calls } = fakePage();

    await locatorFor(page, locator({ framePath: ['iframe#checkout', 'iframe#payment'] }));

    expect(calls.map((call) => `${call.kind}:${String(call.detail)}`)).toEqual([
      'frameLocator:iframe#checkout',
      'frameLocator:iframe#payment',
      'getByRole:[object Object]',
    ]);
  });

  it('disambiguates with nth only when the strategy is ambiguous', async () => {
    const ambiguous = fakePage(3);
    await locatorFor(ambiguous.page, locator({ ordinal: 2 }));
    expect(ambiguous.calls).toContainEqual({ kind: 'nth', detail: 2 });

    const unique = fakePage();
    await locatorFor(unique.page, locator());
    expect(unique.calls.some((call) => call.kind === 'nth')).toBe(false);
  });

  it('refuses a locator with nothing to look for', async () => {
    const { page } = fakePage();

    await expect(locatorFor(page, locator({ role: '', name: '' }))).rejects.toMatchObject({
      code: 'TARGET_NOT_FOUND',
    });
  });
});

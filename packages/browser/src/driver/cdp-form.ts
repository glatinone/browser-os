// CDP form input: fill, select and scroll (action-router §6).
//
// The split between the two errors is the point of `effect`: focusing and selecting dispatch no
// input, so failing there is `'none'`; from the moment text or a wheel event goes out, a failure
// is `'unknown'` (§4.1).

import type { CdpTransport } from '../cdp/transport.js';
import { cdpPress } from './cdp-keyboard.js';
import { type Point, pointAtTarget } from './cdp-pointer.js';
import { type CdpContext, type DriverOutcome, refuse, unsure } from './op.js';
import type { ResolvedTarget } from './types.js';

/** PERFORMANCE.md's default wheel distance for one scroll action. */
const DEFAULT_SCROLL_PX = 600;

export interface FillOptions {
  /** Press Enter once the value is in, as the action's `submit` flag asks. */
  submit?: boolean;
}

export async function cdpFill(
  ctx: CdpContext,
  target: ResolvedTarget,
  value: string,
  opts: FillOptions = {},
): Promise<DriverOutcome> {
  const { transport } = ctx;

  try {
    await transport.send('DOM.focus', { backendNodeId: target.backendNodeId });
    await ctx.call(
      `function () {
        const element = this;
        if (typeof element.select === 'function') { element.select(); return true; }
        if (element.isContentEditable === true) {
          const range = document.createRange();
          range.selectNodeContents(element);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return true;
        }
        return false;
      }`,
      [],
      target,
    );
  } catch (error) {
    return refuse('TARGET_NOT_INTERACTABLE', `could not focus the field: ${describe(error)}`);
  }

  try {
    await transport.send('Input.insertText', { text: value });
    if ((await readField(ctx, target)) === value) return finish(opts, transport, target);

    // A field backed by framework state ignores inserted text: it re-renders from its own value.
    // Going through the native setter and announcing input/change is what such a field listens to.
    await ctx.call(
      `function (next) {
        const element = this;
        // The descriptor has to come from the element's own prototype: the input setter called on
        // a contenteditable throws "Illegal invocation", and a plain element has no value at all.
        const prototype = element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : element instanceof HTMLInputElement
            ? HTMLInputElement.prototype
            : null;
        const descriptor = prototype === null
          ? undefined
          : Object.getOwnPropertyDescriptor(prototype, 'value');
        if (descriptor === undefined || descriptor.set === undefined) {
          element.textContent = next;
        } else {
          descriptor.set.call(element, next);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }`,
      [value],
      target,
    );

    if ((await readField(ctx, target)) !== value) {
      return {
        ok: false,
        effect: 'committed',
        error: {
          code: 'VERIFICATION_FAILED',
          message: `the field does not hold ${JSON.stringify(value)}`,
        },
      };
    }
  } catch (error) {
    return unsure(error);
  }

  return finish(opts, transport, target);
}

export async function cdpSelect(ctx: CdpContext, target: ResolvedTarget, value: string): Promise<DriverOutcome> {
  try {
    await ctx.transport.send('DOM.focus', { backendNodeId: target.backendNodeId });
  } catch (error) {
    return refuse('TARGET_NOT_FOUND', `could not focus the select: ${describe(error)}`);
  }

  let matched: string | null;
  try {
    matched = await ctx.call<string | null>(
      `function (wanted) {
        const element = this;
        if (element.tagName !== 'SELECT') return null;
        const options = Array.from(element.options);
        // Playwright's own order: by value first, then by label.
        let option = options.find((candidate) => candidate.value === wanted);
        if (option === undefined) {
          const trimmed = wanted.trim().toLowerCase();
          option = options.find(
            (candidate) => (candidate.textContent ?? '').trim().toLowerCase() === trimmed,
          );
        }
        if (option === undefined) return null;
        element.value = option.value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return option.value;
      }`,
      [value],
      target,
    );
  } catch (error) {
    return unsure(error);
  }

  if (matched === null) {
    return refuse('TARGET_NOT_FOUND', `no option matches ${JSON.stringify(value)}`);
  }
  return { ok: true, effect: 'committed' };
}

export async function cdpScroll(
  transport: CdpTransport,
  target: ResolvedTarget | null,
  direction: 'up' | 'down',
  amountPx?: number,
): Promise<DriverOutcome> {
  const deltaY = (direction === 'down' ? 1 : -1) * (amountPx ?? DEFAULT_SCROLL_PX);

  let point: Point;
  if (target === null) {
    const centre = await viewportCentre(transport);
    if (centre === null) return refuse('TARGET_NOT_INTERACTABLE', 'the viewport has no size');
    point = centre;
  } else {
    const found = await pointAtTarget(transport, target);
    if (!('point' in found)) return found;
    point = found.point;
  }

  try {
    await transport.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Math.round(point.x),
      y: Math.round(point.y),
      deltaX: 0,
      deltaY,
      button: 'none',
      buttons: 0,
    });
  } catch (error) {
    return unsure(error);
  }

  return { ok: true, effect: 'committed' };
}

/** What the field holds, as the page sees it — the same question `readValue` asks. */
async function readField(ctx: CdpContext, target: ResolvedTarget): Promise<string | null> {
  return await ctx.call<string | null>('function () { return globalThis.__bos.readValue(this); }', [], target);
}

async function finish(opts: FillOptions, transport: CdpTransport, target: ResolvedTarget): Promise<DriverOutcome> {
  if (opts.submit !== true) return { ok: true, effect: 'committed' };
  return await cdpPress(transport, 'Enter', target);
}

async function viewportCentre(transport: CdpTransport): Promise<Point | null> {
  const metrics = (await transport.send('Page.getLayoutMetrics', {})) as {
    layoutViewport?: { clientWidth?: number; clientHeight?: number };
  };
  const width = metrics.layoutViewport?.clientWidth;
  const height = metrics.layoutViewport?.clientHeight;
  if (width === undefined || height === undefined) return null;
  return { x: width / 2, y: height / 2 };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// CDP pointer input: scroll into view, find a point that is really the target, dispatch
// (browser-runtime §5 hit-test acceptance; action-router §6 executor table).
//
// Expected outcomes come back with their `effect`, per action-router §4.1:
//   none    — no input was dispatched: geometry or the hit-test refused the target
//   unknown — input may have been dispatched and the call errored afterwards
// `committed` belongs to the caller, which is the only one that knows the whole call completed.

import type { CdpTransport } from '../cdp/transport.js';
import { type DriverOutcome, refuse, unsure } from './op.js';
import type { ResolvedTarget } from './types.js';

export interface ClickOptions {
  button?: 'left' | 'right' | 'middle';
  clickCount?: 1 | 2;
}

interface Quad {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface TargetPoint {
  point: Point;
  /** The document scroll the point was measured against. */
  scroll: Point;
}

interface DescribedNode {
  nodeId?: number;
  backendNodeId?: number;
  parentId?: number;
  nodeName?: string;
  attributes?: string[];
}

/** How far the hit-test walks before it stops believing the target is an ancestor. */
const MAX_ANCESTOR_LEVELS = 30;

/** `Input.dispatchMouseEvent` button masks, as CDP defines them. */
const BUTTONS: Record<NonNullable<ClickOptions['button']>, number> = { left: 1, right: 2, middle: 4 };

export async function cdpClick(
  transport: CdpTransport,
  target: ResolvedTarget,
  opts: ClickOptions = {},
): Promise<DriverOutcome> {
  const pointed = await clickPoint(transport, target);
  if (!('x' in pointed)) return pointed;

  const button = opts.button ?? 'left';
  const buttons = BUTTONS[button];
  const clickCount = opts.clickCount ?? 1;

  try {
    await moveMouse(transport, pointed);
    // A double click is two press/release pairs with a rising `clickCount`: one pair carrying
    // `clickCount: 2` alone does not make the browser emit `dblclick`.
    for (let count = 1; count <= clickCount; count += 1) {
      await dispatch(transport, {
        type: 'mousePressed',
        x: pointed.x,
        y: pointed.y,
        button,
        buttons,
        clickCount: count,
      });
      await dispatch(transport, {
        type: 'mouseReleased',
        x: pointed.x,
        y: pointed.y,
        button,
        buttons: 0,
        clickCount: count,
      });
    }
  } catch (error) {
    return unsure(error);
  }

  return { ok: true, effect: 'committed' };
}

/** Moves the pointer onto the target and nothing else. */
export async function cdpHover(transport: CdpTransport, target: ResolvedTarget): Promise<DriverOutcome> {
  const pointed = await clickPoint(transport, target);
  if (!('x' in pointed)) return pointed;

  try {
    await moveMouse(transport, pointed);
  } catch (error) {
    return unsure(error);
  }

  return { ok: true, effect: 'committed' };
}

/**
 * Where the target is: scrolled into view, then the centre of its largest quad that is inside the
 * viewport. No quad at all, or none on screen, is a refusal rather than a bad guess.
 */
export async function pointAtTarget(
  transport: CdpTransport,
  target: ResolvedTarget,
): Promise<TargetPoint | DriverOutcome> {
  await transport.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId });

  const answered = (await transport.send('DOM.getContentQuads', {
    backendNodeId: target.backendNodeId,
  })) as { quads?: number[][] };
  const quads = (answered.quads ?? []).map(toQuad).filter((quad) => quad.width > 0 && quad.height > 0);
  if (quads.length === 0) {
    return refuse('TARGET_NOT_INTERACTABLE', 'the target has no box to point at');
  }

  // The quads and the mouse events are both in viewport coordinates, so the on-screen part of the
  // document is simply the viewport rectangle.
  const metrics = (await transport.send('Page.getLayoutMetrics', {})) as {
    layoutViewport?: { pageX?: number; pageY?: number; clientWidth?: number; clientHeight?: number };
  };
  const layout = metrics.layoutViewport;
  const onScreen: Quad = {
    x: 0,
    y: 0,
    width: layout?.clientWidth ?? 0,
    height: layout?.clientHeight ?? 0,
  };
  const visible = quads.filter((quad) => overlaps(quad, onScreen));
  if (visible.length === 0) {
    return refuse('TARGET_NOT_INTERACTABLE', 'the target is outside the viewport');
  }

  return {
    point: centre(largest(visible)),
    scroll: { x: layout?.pageX ?? 0, y: layout?.pageY ?? 0 },
  };
}

/** The point a click would land on: `pointAtTarget`, plus proof that the point is really there. */
async function clickPoint(transport: CdpTransport, target: ResolvedTarget): Promise<Point | DriverOutcome> {
  const found = await pointAtTarget(transport, target);
  if (!('point' in found)) return found;

  // The two coordinate spaces differ, which is easy to miss and hard to debug: the quads and the
  // mouse events are in viewport coordinates, while the hit-test takes document coordinates and
  // only answers for what is currently on screen. The scroll offset goes on for this call alone.
  const hit = (await transport.send('DOM.getNodeForLocation', {
    x: Math.round(found.point.x + found.scroll.x),
    y: Math.round(found.point.y + found.scroll.y),
    includeUserAgentShadowDOM: true,
  })) as { nodeId?: number };

  if (!(await reachesTarget(transport, target, hit.nodeId))) {
    return refuse(
      'TARGET_OBSCURED',
      `another element covers the target at ${Math.round(found.point.x)},${Math.round(found.point.y)}`,
    );
  }

  return found.point;
}

/**
 * Whether a click at the hit node would reach the target: the node is the target or inside it,
 * or it is a label the browser will translate into a click on the control.
 */
async function reachesTarget(
  transport: CdpTransport,
  target: ResolvedTarget,
  hitNodeId: number | undefined,
): Promise<boolean> {
  if (hitNodeId === undefined) return false;
  const targetNodeId = await frontendNodeId(transport, target.backendNodeId);
  if (targetNodeId === null) return false;

  let current: number | null = hitNodeId;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS && current !== null; level += 1) {
    if (current === targetNodeId) return true;
    current = await parentOf(transport, current);
  }

  return await labelReaches(transport, targetNodeId, hitNodeId);
}

/**
 * A checkbox or radio hides behind its `<label>` as often as not — the visible box belongs to
 * the label, the input is transparent on top of it or beside it. Clicking the label is a click
 * on the control, so that is accepted (§5).
 */
async function labelReaches(transport: CdpTransport, targetNodeId: number, hitNodeId: number): Promise<boolean> {
  const targetNode = await describeNode(transport, { nodeId: targetNodeId });
  if (targetNode === undefined) return false;
  if ((targetNode.nodeName ?? '').toLowerCase() !== 'input') return false;
  const type = attribute(targetNode, 'type').toLowerCase();
  if (type !== 'checkbox' && type !== 'radio') return false;
  const id = attribute(targetNode, 'id');

  let current: number | null = hitNodeId;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS && current !== null; level += 1) {
    const node: DescribedNode | undefined = await describeNode(transport, { nodeId: current });
    if (node === undefined) return false;
    if ((node.nodeName ?? '').toLowerCase() === 'label') {
      // An explicit `<label for=...>`, or a label that wraps the control.
      if (id !== '' && attribute(node, 'for') === id) return true;
      if (await contains(transport, node.nodeId, targetNodeId)) return true;
    }
    current = node.parentId ?? null;
  }
  return false;
}

/** Whether `containerId` is somewhere above `nodeId`. */
async function contains(transport: CdpTransport, containerId: number | undefined, nodeId: number): Promise<boolean> {
  if (containerId === undefined) return false;
  let current: number | null = nodeId;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS && current !== null; level += 1) {
    if (current === containerId) return true;
    current = await parentOf(transport, current);
  }
  return false;
}

/** A backend node id lives longer than a frontend one; the DOM domain walks frontend ids. */
async function frontendNodeId(transport: CdpTransport, backendNodeId: number): Promise<number | null> {
  const answer = (await transport.send('DOM.pushNodesByBackendIdsToFrontend', {
    backendNodeIds: [backendNodeId],
  })) as { nodeIds?: (number | null)[] };
  const nodeId = answer.nodeIds?.[0];
  return typeof nodeId === 'number' ? nodeId : null;
}

async function parentOf(transport: CdpTransport, nodeId: number): Promise<number | null> {
  const node = await describeNode(transport, { nodeId });
  return node?.parentId ?? null;
}

async function describeNode(transport: CdpTransport, by: { nodeId: number }): Promise<DescribedNode | undefined> {
  const answer = (await transport.send('DOM.describeNode', by)) as { node?: DescribedNode };
  return answer.node;
}

function attribute(node: DescribedNode, name: string): string {
  const attributes = node.attributes ?? [];
  const at = attributes.indexOf(name);
  return at === -1 ? '' : (attributes[at + 1] ?? '');
}

async function moveMouse(transport: CdpTransport, point: Point): Promise<void> {
  await dispatch(transport, {
    type: 'mouseMoved',
    x: point.x,
    y: point.y,
    button: 'none',
    buttons: 0,
  });
}

async function dispatch(transport: CdpTransport, event: Record<string, unknown>): Promise<void> {
  await transport.send('Input.dispatchMouseEvent', event);
}

/** `DOM.getContentQuads` answers with eight numbers per quad, in viewport coordinates. */
function toQuad(raw: number[]): Quad {
  const [x1, y1, x2, y2, x3, y3, x4, y4] = raw;
  const xs = [x1, x2, x3, x4].filter((value): value is number => value !== undefined);
  const ys = [y1, y2, y3, y4].filter((value): value is number => value !== undefined);
  if (xs.length === 0 || ys.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
}

function overlaps(quad: Quad, viewport: Quad): boolean {
  return (
    quad.x < viewport.x + viewport.width &&
    quad.x + quad.width > viewport.x &&
    quad.y < viewport.y + viewport.height &&
    quad.y + quad.height > viewport.y
  );
}

function largest(quads: Quad[]): Quad {
  return quads.reduce((best, quad) => (quad.width * quad.height > best.width * best.height ? quad : best));
}

function centre(quad: Quad): Point {
  return { x: quad.x + quad.width / 2, y: quad.y + quad.height / 2 };
}

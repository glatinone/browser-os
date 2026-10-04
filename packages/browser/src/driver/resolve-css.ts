// CSS selector → ResolvedTarget, for tests and e2e (task P3-01).
//
// A stand-in for the real resolver (dom-intelligence §8, P4-01): it fills `ElementLocator` with
// what the DOM domain knows and leaves the fingerprint fields empty, because nothing in Phase 3
// matches against them yet. Nothing here needs Playwright.

import { BosError, type ElementLocator } from '@browser-os/protocol';
import type { CdpTransport } from '../cdp/transport.js';
import type { ResolvedTarget } from './types.js';

interface DescribeNodeResult {
  backendNodeId?: number;
  nodeName?: string;
  attributes?: string[];
}

export async function resolveCss(transport: CdpTransport, css: string): Promise<ResolvedTarget> {
  // The frame we query in is the frame the target belongs to. `DOM.describeNode` reports a
  // `frameId` only for frame-owner elements, and that is the frame they *contain* — the target
  // is the element itself, which lives in this document.
  const tree = (await transport.send('Page.getFrameTree', {})) as {
    frameTree?: { frame?: { id?: string } };
  };
  const cdpFrameId = tree.frameTree?.frame?.id;
  if (cdpFrameId === undefined) {
    throw new BosError('INTERNAL', 'Page.getFrameTree returned no frame', {});
  }

  const describedDocument = (await transport.send('DOM.getDocument', { depth: -1 })) as {
    root?: { nodeId?: number };
  };
  const rootNodeId = describedDocument.root?.nodeId;
  if (rootNodeId === undefined) {
    throw new BosError('INTERNAL', 'DOM.getDocument returned no root node', {});
  }

  const found = (await transport.send('DOM.querySelector', {
    nodeId: rootNodeId,
    selector: css,
  })) as { nodeId?: number };
  const nodeId = found.nodeId;
  if (nodeId === undefined || nodeId === 0) {
    throw new BosError('TARGET_NOT_FOUND', `No element matches ${css}`, { details: { css } });
  }

  const described = (await transport.send('DOM.describeNode', { nodeId })) as {
    node?: DescribeNodeResult;
  };
  const node = described.node;
  if (node?.backendNodeId === undefined) {
    throw new BosError('INTERNAL', `DOM.describeNode returned an incomplete node for ${css}`, {
      details: { css },
    });
  }

  const attributes = node.attributes ?? [];
  const attribute = (name: string): string => {
    const at = attributes.indexOf(name);
    return at === -1 ? '' : (attributes[at + 1] ?? '');
  };
  const tag = (node.nodeName ?? '').toLowerCase();
  const name = attribute('aria-label') || attribute('name') || attribute('id');

  const locator: ElementLocator = {
    v: 1,
    role: tag,
    name,
    nameIsDynamic: false,
    tag,
    attrs: {},
    context: [],
    cssPath: css,
    framePath: [],
    ordinal: 0,
  };

  return { backendNodeId: node.backendNodeId, cdpFrameId, locator, role: tag, name };
}

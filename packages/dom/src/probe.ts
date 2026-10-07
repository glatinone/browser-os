import type { CdpTransport, ElementLocator, HelperWorlds, Rect } from '@browser-os/protocol';
import type { ProbeCandidate } from './locator.js';

interface DescribeNodeResponse {
  node?: {
    backendNodeId?: number;
    nodeName?: string;
    attributes?: string[];
  };
}

interface PartialAxResponse {
  nodes?: Array<{
    role?: { value?: string };
    name?: { value?: string };
    properties?: Array<{ name: string; value?: { value?: unknown } }>;
  }>;
}

interface BoxModelResponse {
  model?: {
    border?: number[];
  };
}

interface CallFunctionResponse {
  result?: {
    type?: string;
    subtype?: string;
    objectId?: string;
  };
}

interface GetPropertiesResponse {
  result?: Array<{
    name: string;
    value?: {
      objectId?: string;
    };
  }>;
}

/**
 * Fast-path probe for cached targets (dom-intelligence §8.3).
 * Resolves durable locators on the main frame in <= 4 CDP round trips for a single candidate.
 */
export async function probe(
  cdp: CdpTransport,
  worlds: HelperWorlds,
  locatorOrFrameId: ElementLocator | string,
  maybeLocator?: ElementLocator,
): Promise<ProbeCandidate[]> {
  let mainCdpFrameId = '';
  let locator: ElementLocator;

  if (typeof locatorOrFrameId === 'string') {
    mainCdpFrameId = locatorOrFrameId;
    locator = maybeLocator ?? ({} as ElementLocator);
  } else {
    locator = locatorOrFrameId;
  }

  // Frame path > 0 indicates child frame target: probe operates only on main frame in MVP (§8.3)
  if (locator.framePath && locator.framePath.length > 0) {
    return [];
  }

  const worldsInternal = worlds as unknown as {
    get?: (frameId: string) => Promise<number>;
    contexts?: Map<string, number>;
  };

  if (!mainCdpFrameId) {
    if (worldsInternal.contexts && worldsInternal.contexts.size > 0) {
      mainCdpFrameId = worldsInternal.contexts.keys().next().value ?? '';
    }
    if (!mainCdpFrameId) {
      const tree = (await cdp.send('Page.getFrameTree', {})) as {
        frameTree?: { frame?: { id?: string } };
      };
      mainCdpFrameId = tree.frameTree?.frame?.id ?? '';
    }
  }

  let executionContextId: number | undefined;
  if (typeof worldsInternal.get === 'function' && mainCdpFrameId) {
    executionContextId = await worldsInternal.get(mainCdpFrameId);
  }

  const callRes = (await cdp.send('Runtime.callFunctionOn', {
    functionDeclaration: 'function (loc) { return globalThis.__bos.probe(loc); }',
    executionContextId,
    arguments: [{ value: locator }],
    returnByValue: false,
  })) as CallFunctionResponse;

  const resultObj = callRes.result;
  if (!resultObj?.objectId || resultObj.subtype === 'null' || resultObj.type === 'undefined') {
    return [];
  }

  let candidateObjectIds: string[] = [];
  if (resultObj.subtype === 'array') {
    const propsRes = (await cdp.send('Runtime.getProperties', {
      objectId: resultObj.objectId,
      ownProperties: true,
    })) as GetPropertiesResponse;

    candidateObjectIds = (propsRes.result ?? [])
      .filter((p) => /^\d+$/.test(p.name) && typeof p.value?.objectId === 'string')
      .map((p) => p.value?.objectId)
      .filter((id): id is string => typeof id === 'string');
  } else {
    candidateObjectIds = [resultObj.objectId];
  }

  const candidatePromises = candidateObjectIds.map(async (objectId) => {
    const [descRes, axRes, boxRes] = await Promise.all([
      cdp.send('DOM.describeNode', { objectId }) as Promise<DescribeNodeResponse>,
      cdp.send('Accessibility.getPartialAXTree', {
        objectId,
        fetchRelatives: false,
      }) as Promise<PartialAxResponse>,
      (cdp.send('DOM.getBoxModel', { objectId }) as Promise<BoxModelResponse>).catch(() => null),
    ]);

    const node = descRes.node;
    const backendNodeId = node?.backendNodeId ?? 0;
    const tag = (node?.nodeName ?? '').toLowerCase();

    const attrs: Record<string, string> = {};
    const attributes = node?.attributes ?? [];
    for (let i = 0; i < attributes.length; i += 2) {
      const key = attributes[i];
      if (key) attrs[key.toLowerCase()] = attributes[i + 1] ?? '';
    }

    const axNode = axRes.nodes?.[0];
    const role = axNode?.role?.value ?? tag;
    const name = axNode?.name?.value ?? attrs['aria-label'] ?? attrs.name ?? attrs.id ?? '';

    let disabled = attrs.disabled !== undefined;
    if (axNode?.properties) {
      for (const prop of axNode.properties) {
        if (prop.name === 'disabled' && prop.value?.value === true) {
          disabled = true;
        }
      }
    }

    let rect: Rect | null = null;
    const border = boxRes?.model?.border;
    if (border && border.length >= 8) {
      const b0 = border[0] ?? 0;
      const b1 = border[1] ?? 0;
      const b2 = border[2] ?? 0;
      const b3 = border[3] ?? 0;
      const b4 = border[4] ?? 0;
      const b5 = border[5] ?? 0;
      const b6 = border[6] ?? 0;
      const b7 = border[7] ?? 0;
      const xs = [b0, b2, b4, b6];
      const ys = [b1, b3, b5, b7];
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      const w = Math.max(...xs) - x;
      const h = Math.max(...ys) - y;
      rect = { x, y, w, h };
    }

    return {
      backendNodeId,
      role,
      name,
      rect,
      disabled: disabled || undefined,
      attrs,
    };
  });

  const candidates = await Promise.all(candidatePromises);
  return candidates.filter((c) => c.backendNodeId > 0);
}

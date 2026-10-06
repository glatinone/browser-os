import type { CdpTransport } from '@browser-os/protocol';
import type { RawLayoutMetrics, RawSnapshot, RawSnapshotDocument } from './types-raw.js';

export interface RawFrame {
  id: string;
  url: string;
  name?: string;
  parentId?: string | null;
  outOfProcess?: boolean;
}

export interface RawDocument {
  frameId?: string;
  nodes: Array<{
    nodeId: number;
    backendNodeId: number;
    nodeType: number;
    nodeName: string;
    localName: string;
    nodeValue?: string;
    attributes: string[];
    textValue?: string;
    inputValue?: string;
    inputChecked?: boolean;
    optionSelected?: boolean;
    isClickable: boolean;
    parentIndex?: number;
    childIndexes: number[];
    shadowRoot?: 'open' | 'closed';
    contentDocumentIndex?: number;
  }>;
  layout: Array<{
    nodeIndex: number;
    bounds: [number, number, number, number]; // [x, y, w, h]
    styles: Record<string, string>;
    paintOrder: number | null;
  }>;
}

export interface RawCapture {
  snapshot: RawSnapshot;
  layoutMetrics: RawLayoutMetrics;
  frameTree: FrameTreeNode | null;
  capturedAt: number;
  documents: RawDocument[];
  axTrees: Array<{
    frameId: string;
    nodes: Array<{
      backendDOMNodeId: number;
      role: string;
      name: string;
      value?: string;
      ignored: boolean;
      props: Record<string, unknown>;
    }>;
  }>;
  viewport: { width: number; height: number; pageX: number; pageY: number };
  frames: RawFrame[];
  warnings: string[];
}

const FRAME_AX_TIMEOUT_MS = 1500;
const LARGE_PAGE_NODES = 15000;

type CdpRecord = Record<string, unknown>;
interface AxProperty extends CdpRecord {
  name?: string;
  value?: { value?: unknown } | unknown;
}
interface AxNode extends CdpRecord {
  backendDOMNodeId?: number;
  nodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  ignored?: boolean;
  properties?: AxProperty[];
}
interface FrameTreeNode extends CdpRecord {
  frame: { id: string; url?: string; name?: string };
  parentId?: string;
  childFrames?: FrameTreeNode[];
}
function stringAt(strings: string[] | undefined, index: number | undefined): string {
  return index === undefined ? '' : (strings?.[index] ?? '');
}

function rareString(
  data: { index: number[]; value: number[] } | undefined,
  nodeIndex: number,
  strings: string[] | undefined,
): string | undefined {
  const offset = data?.index.indexOf(nodeIndex) ?? -1;
  return offset < 0 ? undefined : stringAt(strings, data?.value[offset]);
}

function rareNumber(data: { index: number[]; value: number[] } | undefined, nodeIndex: number): number | undefined {
  const offset = data?.index.indexOf(nodeIndex) ?? -1;
  return offset < 0 ? undefined : data?.value[offset];
}

function decodeAttributes(values: number[] | undefined, strings: string[] | undefined): string[] {
  if (!values) return [];
  return values.map((value) => stringAt(strings, value));
}

function tupleBounds(values: number[] | undefined): [number, number, number, number] {
  return [values?.[0] ?? 0, values?.[1] ?? 0, values?.[2] ?? 0, values?.[3] ?? 0];
}

function decodeComputedStyles(values: number[] | undefined, strings: string[] | undefined): Record<string, string> {
  // DOMSnapshot returns layout styles as one string index per requested
  // computedStyles entry, in request order:
  // ['display', 'visibility', 'opacity', 'pointer-events', 'cursor', 'position'].
  const keys = ['display', 'visibility', 'opacity', 'pointerEvents', 'cursor', 'position'];
  const styles: Record<string, string> = {};
  for (let index = 0; index < (values?.length ?? 0) && index < keys.length; index++) {
    const value = stringAt(strings, values?.[index]);
    if (value) styles[keys[index] as string] = value;
  }
  return styles;
}

async function getAxTreeForFrame(
  cdp: CdpTransport,
  frameId: string,
  timeoutMs = FRAME_AX_TIMEOUT_MS,
): Promise<
  Array<{
    backendDOMNodeId: number;
    role: string;
    name: string;
    value?: string;
    ignored: boolean;
    props: Record<string, unknown>;
  }>
> {
  try {
    const result = await Promise.race([
      cdp.send('Accessibility.getFullAXTree', { frameId }) as Promise<{ nodes?: AxNode[] }>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('AX timeout')), timeoutMs)),
    ]);
    return (result.nodes || []).map((n) => ({
      backendDOMNodeId: n.backendDOMNodeId ?? n.nodeId ?? 0,
      role: n.role?.value ?? '',
      name: n.name?.value ?? '',
      value: n.value?.value,
      ignored: n.ignored ?? false,
      props:
        n.properties?.reduce((acc: Record<string, unknown>, p) => {
          if (p.name) {
            const value = p.value;
            acc[p.name] =
              typeof value === 'object' && value !== null && 'value' in value
                ? (value as { value?: unknown }).value
                : value;
          }
          return acc;
        }, {}) ?? {},
    }));
  } catch {
    return [];
  }
}

export async function captureRaw(cdp: CdpTransport, opts: { frameAxTimeoutMs?: number } = {}): Promise<RawCapture> {
  const warnings: string[] = [];
  const [beforeDocument, frameTreeResult, layoutMetrics, snapshot] = await Promise.all([
    cdp.send('DOM.getDocument', { depth: 0 }) as Promise<{ root?: { backendNodeId?: number } }>,
    cdp.send('Page.getFrameTree') as Promise<{ frameTree?: FrameTreeNode }>,
    cdp.send('Page.getLayoutMetrics') as Promise<RawLayoutMetrics>,
    cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: ['display', 'visibility', 'opacity', 'pointer-events', 'cursor', 'position'],
      includePaintOrder: true,
      includeDOMRects: true,
    }) as Promise<{ strings?: string[]; documents?: RawSnapshotDocument[] }>,
  ]);

  const frames: RawFrame[] = [];
  const collectFrames = (tree: FrameTreeNode): void => {
    frames.push({
      id: tree.frame.id,
      url: tree.frame.url ?? '',
      name: tree.frame.name,
      parentId: tree.parentId ?? null,
    });
    tree.childFrames?.forEach(collectFrames);
  };
  if (frameTreeResult.frameTree) collectFrames(frameTreeResult.frameTree);

  const cssVisualViewport = layoutMetrics.cssVisualViewport ?? layoutMetrics.visualViewport ?? {};
  const viewport = {
    width: cssVisualViewport.clientWidth ?? cssVisualViewport.pageWidth ?? 0,
    height: cssVisualViewport.clientHeight ?? cssVisualViewport.pageHeight ?? 0,
    pageX: cssVisualViewport.pageX ?? 0,
    pageY: cssVisualViewport.pageY ?? 0,
  };

  const documents: RawDocument[] = [];
  const docs = snapshot.documents ?? [];
  const nodeCount = docs.reduce((count, doc) => count + (doc.nodes?.nodeType?.length ?? 0), 0);
  const rawSnapshot: RawSnapshot = { strings: snapshot.strings ?? [], documents: docs };
  if (nodeCount > LARGE_PAGE_NODES) warnings.push(`Large page: ${nodeCount} nodes`);

  for (const doc of docs) {
    const nodeColumns = doc.nodes ?? {};
    const nodeCountForDoc = nodeColumns.nodeType?.length ?? 0;
    const rawNodes = Array.from({ length: nodeCountForDoc }, (_, idx) => ({
      nodeId: idx,
      backendNodeId: nodeColumns.backendNodeId?.[idx] ?? 0,
      nodeType: nodeColumns.nodeType?.[idx] ?? 1,
      nodeName: stringAt(snapshot.strings, nodeColumns.nodeName?.[idx]),
      localName: stringAt(snapshot.strings, nodeColumns.localName?.[idx]),
      nodeValue: stringAt(snapshot.strings, nodeColumns.nodeValue?.[idx]),
      attributes: decodeAttributes(nodeColumns.attributes?.[idx], snapshot.strings),
      textValue:
        rareString(nodeColumns.textValue, idx, snapshot.strings) ??
        stringAt(snapshot.strings, nodeColumns.nodeValue?.[idx]),
      inputValue: rareString(nodeColumns.inputValue, idx, snapshot.strings),
      inputChecked: nodeColumns.inputChecked?.index.includes(idx),
      optionSelected: nodeColumns.optionSelected?.index.includes(idx),
      isClickable: nodeColumns.isClickable?.index.includes(idx) ?? false,
      parentIndex: nodeColumns.parentIndex?.[idx],
      childIndexes: nodeColumns.childNodeIndexes?.[idx] ?? [],
      shadowRoot: rareString(nodeColumns.shadowRootType, idx, snapshot.strings) as 'open' | 'closed' | undefined,
      contentDocumentIndex: rareNumber(nodeColumns.contentDocumentIndex, idx),
    }));
    const layout = doc.layout ?? {};
    const rawLayouts = (layout.nodeIndex ?? []).map((nodeIndex, layoutIdx) => ({
      nodeIndex,
      bounds: tupleBounds(layout.bounds?.[layoutIdx]),
      styles: decodeComputedStyles(layout.styles?.[layoutIdx], snapshot.strings),
      paintOrder: layout.paintOrders?.[layoutIdx] ?? null,
    }));
    documents.push({
      frameId: doc.frameId === undefined ? undefined : stringAt(snapshot.strings, doc.frameId),
      nodes: rawNodes,
      layout: rawLayouts,
    });
  }

  const axTrees: RawCapture['axTrees'] = [];
  const timeoutMs = opts.frameAxTimeoutMs ?? FRAME_AX_TIMEOUT_MS;
  const axResults = await Promise.all(
    frames.map(async (frame) => ({
      frame,
      nodes: await getAxTreeForFrame(cdp, frame.id, timeoutMs),
    })),
  );
  for (const { frame, nodes } of axResults) {
    if (nodes.length === 0 && frame.id !== frames[0]?.id) warnings.push(`AX tree empty for frame ${frame.id}`);
    axTrees.push({ frameId: frame.id, nodes });
  }

  const afterDocument = (await cdp.send('DOM.getDocument', { depth: 0 })) as { root?: { backendNodeId?: number } };
  const beforeRoot = beforeDocument.root?.backendNodeId;
  const afterRoot = afterDocument.root?.backendNodeId;
  if (beforeRoot !== undefined && afterRoot !== undefined && beforeRoot !== afterRoot) {
    warnings.push(`Document changed during capture: ${beforeRoot} -> ${afterRoot}`);
  }

  return {
    snapshot: rawSnapshot,
    layoutMetrics,
    frameTree: frameTreeResult.frameTree ?? null,
    capturedAt: Date.now(),
    documents,
    axTrees,
    viewport,
    frames,
    warnings,
  };
}

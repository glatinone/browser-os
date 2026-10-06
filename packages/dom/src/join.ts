import type { RawCapture, RawFrame } from './capture.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface NodeRow {
  idx: number;
  backendNodeId: number;
  docIndex: number;
  frameId: string;
  parentIdx: number | null;
  tag: string;
  attrs: Record<string, string>;
  shadowHostIdx: number | null;
  bounds: Rect | null;
  styles: {
    display?: string;
    visibility?: string;
    opacity?: string;
    pointerEvents?: string;
    cursor?: string;
    position?: string;
  };
  paintOrder: number | null;
  isClickable: boolean;
  inputValue?: string;
  inputChecked?: boolean;
  ax?: {
    role: string;
    name: string;
    value?: string;
    ignored: boolean;
    props: Record<string, unknown>;
  };
}

export interface TextRow {
  parentIdx: number;
  text: string;
}

export interface NodeTable {
  rows: NodeRow[];
  texts: TextRow[];
  frames: RawFrame[];
  viewport: { width: number; height: number; pageX: number; pageY: number };
}

export function joinRawCapture(raw: RawCapture): NodeTable {
  const rows: NodeRow[] = [];
  const texts: TextRow[] = [];
  const localToRow = new Map<string, number>();
  const hostByDocument = new Map<number, number>();

  for (const docIdx of inlineDocumentOrder(raw)) {
    const doc = raw.documents[docIdx];
    if (!doc) continue;
    const nodes = doc.nodes ?? [];
    const layoutMap = new Map(doc.layout.map((layout) => [layout.nodeIndex, layout]));
    const frameId = doc.frameId ?? raw.frames[docIdx]?.id ?? raw.frames[0]?.id ?? '';
    const documentParent = hostByDocument.get(docIdx) ?? null;

    for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
      const node = nodes[nodeIdx];
      if (!node) continue;
      const localParent = node.parentIndex === undefined || node.parentIndex < 0 ? null : node.parentIndex;
      const parentIdx = nearestElementParent(nodes, localParent, localToRow, docIdx, documentParent);
      if (node.nodeType !== 1) {
        if (node.nodeType === 3 && node.textValue && parentIdx !== null)
          texts.push({ parentIdx, text: node.textValue });
        continue;
      }
      const layout = layoutMap.get(nodeIdx);
      const row: NodeRow = {
        idx: rows.length,
        backendNodeId: node.backendNodeId ?? 0,
        docIndex: docIdx,
        frameId,
        parentIdx,
        tag: node.nodeName?.toLowerCase() ?? '',
        attrs: parseAttributes(node.attributes ?? []),
        shadowHostIdx: findShadowHost(nodes, localParent, localToRow, docIdx, documentParent),
        bounds: layout ? { x: layout.bounds[0], y: layout.bounds[1], w: layout.bounds[2], h: layout.bounds[3] } : null,
        styles: layout?.styles ?? {},
        paintOrder: layout?.paintOrder ?? null,
        isClickable: node.isClickable ?? false,
        inputValue: node.inputValue,
        inputChecked: node.inputChecked,
      };
      rows.push(row);
      localToRow.set(`${docIdx}:${nodeIdx}`, row.idx);
    }

    for (const [nodeIdx, node] of nodes.entries()) {
      if (node?.contentDocumentIndex !== undefined) {
        const host = localToRow.get(`${docIdx}:${nodeIdx}`);
        if (host !== undefined) hostByDocument.set(node.contentDocumentIndex, host);
      }
    }
  }

  // Join AX trees through a backend-node index. Zero IDs are not valid join keys.
  const rowsByBackendId = new Map(rows.filter((row) => row.backendNodeId > 0).map((row) => [row.backendNodeId, row]));
  for (const axTree of raw.axTrees) {
    for (const axNode of axTree.nodes) {
      const backendNodeId = axNode.backendDOMNodeId;
      if (!backendNodeId) continue;
      const row = rowsByBackendId.get(backendNodeId);
      if (row && row.frameId === axTree.frameId) {
        row.ax = {
          role: axNode.role,
          name: axNode.name,
          value: axNode.value,
          ignored: axNode.ignored,
          props: axNode.props,
        };
      }
    }
  }

  return {
    rows,
    texts,
    frames: raw.frames,
    viewport: raw.viewport,
  };
}

function inlineDocumentOrder(raw: RawCapture): number[] {
  const childrenByDocument = new Map<number, number[]>();
  for (const [docIdx, doc] of raw.documents.entries()) {
    for (const node of doc.nodes) {
      if (node.contentDocumentIndex !== undefined) {
        const children = childrenByDocument.get(docIdx) ?? [];
        children.push(node.contentDocumentIndex);
        childrenByDocument.set(docIdx, children);
      }
    }
  }
  const order: number[] = [];
  const visited = new Set<number>();
  const visit = (docIdx: number): void => {
    if (visited.has(docIdx) || !raw.documents[docIdx]) return;
    visited.add(docIdx);
    order.push(docIdx);
    for (const child of childrenByDocument.get(docIdx) ?? []) visit(child);
  };
  visit(0);
  for (let docIdx = 0; docIdx < raw.documents.length; docIdx++) visit(docIdx);
  return order;
}

function nearestElementParent(
  nodes: NonNullable<RawCapture['documents'][number]['nodes']>,
  nodeIdx: number | null,
  localToRow: Map<string, number>,
  docIdx: number,
  documentParent: number | null,
): number | null {
  let current = nodeIdx;
  while (current !== null) {
    const mapped = localToRow.get(`${docIdx}:${current}`);
    if (mapped !== undefined) return mapped;
    current = nodes[current]?.parentIndex ?? null;
    if (current !== null && current < 0) current = null;
  }
  return documentParent;
}

function findShadowHost(
  nodes: NonNullable<RawCapture['documents'][number]['nodes']>,
  nodeIdx: number | null,
  localToRow: Map<string, number>,
  docIdx: number,
  documentParent: number | null,
): number | null {
  let current = nodeIdx;
  while (current !== null) {
    const node = nodes[current];
    if (!node) break;
    if (node.shadowRoot) {
      return nearestElementParent(nodes, node.parentIndex ?? null, localToRow, docIdx, documentParent);
    }
    current = node.parentIndex ?? null;
    if (current !== null && current < 0) current = null;
  }
  return null;
}

function parseAttributes(attrs: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < attrs.length; i += 2) {
    const key = attrs[i];
    const value = attrs[i + 1] ?? '';
    if (key) {
      result[key.toLowerCase()] = value;
    }
  }
  return result;
}

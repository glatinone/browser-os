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
  let globalIdx = 0;
  const localToGlobal = new Map<string, number>();

  for (let docIdx = 0; docIdx < raw.documents.length; docIdx++) {
    const doc = raw.documents[docIdx];
    if (!doc) continue;
    const nodes = doc.nodes || [];
    const layouts = doc.layout || [];

    // Build a map of nodeIndex -> layout info
    const layoutMap = new Map<number, (typeof layouts)[number]>();
    for (const l of layouts) {
      layoutMap.set(l.nodeIndex, l);
    }

    // DOMSnapshot carries the frame identity for each flattened document. Fall back only for
    // hand-built legacy captures that predate the raw frameId field.
    const frameId = doc.frameId ?? raw.frames[docIdx]?.id ?? raw.frames[0]?.id ?? '';

    for (let nodeIdx = 0; nodeIdx < nodes.length; nodeIdx++) {
      const n = nodes[nodeIdx];
      if (!n) continue;
      const layout = layoutMap.get(nodeIdx);
      const bounds = layout
        ? {
            x: layout.bounds[0],
            y: layout.bounds[1],
            w: layout.bounds[2],
            h: layout.bounds[3],
          }
        : null;

      // Convert to viewport coordinates if needed (MVP: assume already in viewport or same origin)
      // In a full implementation, we'd subtract pageX/pageY and add iframe offsets

      const parentIdx = n.parentIndex === undefined ? null : (localToGlobal.get(`${docIdx}:${n.parentIndex}`) ?? null);
      const row: NodeRow = {
        idx: globalIdx,
        backendNodeId: n.backendNodeId ?? 0,
        docIndex: docIdx,
        frameId,
        parentIdx,
        tag: n.nodeName?.toLowerCase() ?? '',
        attrs: parseAttributes(n.attributes ?? []),
        shadowHostIdx: null,
        bounds,
        styles: layout?.styles ?? {},
        paintOrder: null, // DOMSnapshot doesn't provide paint order directly in this format
        isClickable: n.isClickable ?? false,
        inputValue: n.inputValue,
        inputChecked: n.inputChecked,
      };

      localToGlobal.set(`${docIdx}:${nodeIdx}`, globalIdx);
      // Only element nodes (nodeType 1) go into rows
      if (n.nodeType === 1) {
        rows.push(row);
      } else if (n.nodeType === 3 && n.textValue && parentIdx !== null) {
        texts.push({ parentIdx, text: n.textValue });
      }

      globalIdx++;
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

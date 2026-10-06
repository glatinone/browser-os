export type CdpStringIndex = number;

export interface RawSnapshotNodeArrays {
  nodeType?: number[];
  nodeName?: number[];
  localName?: number[];
  nodeValue?: number[];
  backendNodeId?: number[];
  parentIndex?: number[];
  childNodeIndexes?: number[][];
  attributes?: number[][];
  shadowRootType?: { index: number[]; value: number[] };
  contentDocumentIndex?: { index: number[]; value: number[] };
  textValue?: { index: number[]; value: number[] };
  inputValue?: { index: number[]; value: number[] };
  inputChecked?: { index: number[] };
  optionSelected?: { index: number[] };
  isClickable?: { index: number[] };
}

export interface RawSnapshotLayoutTree {
  nodeIndex?: number[];
  bounds?: number[][];
  styles?: number[][];
  text?: number[];
  paintOrders?: number[];
}

export interface RawSnapshotDocument {
  frameId?: number;
  nodes?: RawSnapshotNodeArrays;
  layout?: RawSnapshotLayoutTree;
}

export interface RawSnapshot {
  strings: string[];
  documents: RawSnapshotDocument[];
}

export interface RawLayoutMetrics {
  cssVisualViewport?: {
    clientWidth?: number;
    clientHeight?: number;
    pageX?: number;
    pageY?: number;
    pageWidth?: number;
    pageHeight?: number;
  };
  visualViewport?: RawLayoutMetrics['cssVisualViewport'];
}

export interface RawFrameTreeNode {
  frame: { id: string; url?: string; name?: string };
  parentId?: string;
  childFrames?: RawFrameTreeNode[];
}

export interface RawAxNode {
  backendDOMNodeId?: number;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  ignored?: boolean;
  properties?: Array<{ name?: string; value?: { value?: unknown } | unknown }>;
}

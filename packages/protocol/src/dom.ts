// DOM observation types (data-models §4). Pipeline: specs/dom-intelligence.md.

import type { FrameInfo } from './browser.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
} // CSS px, top-level viewport coordinates

export interface ElementState {
  disabled?: true;
  checked?: boolean | 'mixed';
  expanded?: boolean;
  selected?: true;
  focused?: true;
  required?: true;
  readonly?: true;
  editable?: true; // input, textarea, contenteditable
}

/** What the model and the calling agent see. Compact by design. */
export interface SemanticElement {
  ref: string; // "e1".."eN"; valid ONLY within the Observation that produced it
  role: string; // computed ARIA role (button, link, textbox, combobox, checkbox, ...)
  name: string; // accessible name, whitespace-collapsed, max 120 chars
  tag: string; // lowercase tag name
  value?: string; // current value, max 120 chars; bullets for password or secret fields
  placeholder?: string;
  description?: string; // aria-description / title, max 120 chars
  href?: string; // links: same-origin -> path only; cross-origin -> full URL
  inputType?: string; // <input type>
  state: ElementState;
  inViewport: boolean;
  rect: Rect | null;
  frame: string; // FrameInfo.id ("f0" = main)
  context: string[]; // <= 2 nearest container labels, e.g. ["navigation:Primary", "dialog:Sign in"]
}

export interface TextBlock {
  ref: string; // "t1".."tN"
  text: string; // max 300 chars
  role: 'heading' | 'paragraph' | 'listitem' | 'cell' | 'status' | 'alert' | 'text';
  level?: number; // heading level
  frame: string;
}

export interface Observation {
  id: string; // obs_...
  sessionId: string;
  pageId: string;
  url: string;
  title: string;
  capturedAt: number;
  frames: FrameInfo[];
  elements: SemanticElement[]; // interactive elements only
  text: TextBlock[]; // non-interactive visible text, only when requested (includeText)
  dialogs: string[]; // names of open modal dialogs (topmost first)
  challenge: ChallengeKind | null; // detected security challenge (specs/dom-intelligence.md §9)
  warnings: string[]; // e.g. "frame f3 omitted: AX timeout"
  stats: {
    domNodes: number;
    axNodes: number;
    elements: number;
    captureMs: number; // CDP round trips
    buildMs: number; // our processing
    estTokens: number; // ceil(serializedLength / 4)
    large: boolean; // domNodes > LARGE_PAGE_NODES (15000)
  };
}

export type ChallengeKind = 'login' | 'captcha' | 'mfa' | 'passkey' | 'consent' | 'unknown';

/**
 * Durable description of an element, stored in the action cache and trajectories.
 * Resolved against a fresh observation by the fingerprint matcher (specs/dom-intelligence.md §8).
 * Never contains user-typed values.
 */
export interface ElementLocator {
  v: 1;
  role: string;
  name: string; // "" when nameIsDynamic
  nameIsDynamic: boolean; // true if the name contained a param value at record time
  tag: string;
  attrs: Partial<Record<StableAttr, string>>;
  context: string[];
  cssPath: string; // see dom-intelligence §8.2; shadow boundaries joined with " >>> "
  framePath: string[]; // iframe selectors from top; [] = main frame
  ordinal: number; // 0-based index among elements with same role+name in that observation
}

export type StableAttr =
  | 'id'
  | 'name'
  | 'type'
  | 'placeholder'
  | 'aria-label'
  | 'title'
  | 'alt'
  | 'href'
  | 'autocomplete'
  | 'data-testid'
  | 'data-test'
  | 'data-qa'
  | 'role';

/** Value type of ObservationIndex.entries. */
export interface IndexEntry {
  backendNodeId: number;
  frameId: string; // FrameInfo.id
  cdpFrameId: string; // real CDP frame id
  locator: ElementLocator;
}

/** Internal (daemon-side only) index from refs to live nodes. Never sent to models or clients. */
export interface ObservationIndex {
  observationId: string;
  pageId: string;
  entries: Map<string, IndexEntry>; // key = ref ("e12")
}

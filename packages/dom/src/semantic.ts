import type {
  ElementState,
  FrameInfo,
  Observation,
  ObservationIndex,
  SemanticElement,
  TextBlock,
} from '@browser-os/protocol';
import { isSensitiveField, MASKED_VALUE, newId } from '@browser-os/protocol';
import type { RawCapture } from './capture.js';
import { isInteractive } from './interactive.js';
import { joinRawCapture, type NodeRow, type NodeTable, type Rect } from './join.js';
import { collapse, truncate } from './normalize.js';
import { inViewport, isVisible, modalScope } from './visibility.js';

export type { ObservationIndex } from '@browser-os/protocol';

interface SemanticBuildResult {
  observation: Observation;
  index: ObservationIndex;
}

export interface SemanticOptions {
  url?: string;
  title?: string;
  sessionId?: string;
  pageId?: string;
  capturedAt?: number;
  includeText?: boolean;
  maxTextChars?: number;
}

export function buildSemanticElements(table: NodeTable, options: SemanticOptions = {}): SemanticElement[] {
  const scope = modalScope(table);
  return table.rows
    .filter((row) => isInteractive(row, table) && isVisible(row, table))
    .filter((row) => scope.dialogIdx === null || isInside(row, scope.dialogIdx, table))
    .map((row, index) => toSemanticElement(row, index + 1, table, options.url));
}

export function buildTextBlocks(table: NodeTable, maxTextChars = 4000): TextBlock[] {
  const blocks: TextBlock[] = [];
  let used = 0;
  for (const text of table.texts) {
    if (used >= maxTextChars) break;
    const row = table.rows.find((candidate) => candidate.idx === text.parentIdx);
    if (!row || !isVisible(row, table) || !text.text.trim()) continue;
    const value = truncate(text.text, Math.min(300, maxTextChars - used));
    if (!value) continue;
    blocks.push({ ref: `t${blocks.length + 1}`, text: value, role: textRole(row), frame: frameLabel(row, table) });
    used += value.length;
  }
  return blocks;
}

export function buildObservation(raw: RawCapture, meta: SemanticOptions = {}): SemanticBuildResult {
  return buildObservationFromTable(joinRawCapture(raw), meta, raw.warnings);
}

export function buildObservationFromTable(
  table: NodeTable,
  meta: SemanticOptions = {},
  warnings: string[] = [],
): SemanticBuildResult {
  const id = newId('obs');
  const elements = buildSemanticElements(table, meta);
  const text = meta.includeText ? buildTextBlocks(table, meta.maxTextChars) : [];
  const elementRows = table.rows
    .filter((row) => isInteractive(row, table) && isVisible(row, table))
    .filter((row) => {
      const scope = modalScope(table);
      return scope.dialogIdx === null || isInside(row, scope.dialogIdx, table);
    });
  const frames = table.frames.map(
    (frame, index): FrameInfo => ({
      id: `f${index}`,
      parentId: frame.parentId ? `f${table.frames.findIndex((candidate) => candidate.id === frame.parentId)}` : null,
      url: frame.url,
      name: frame.name ?? null,
      outOfProcess: frame.outOfProcess ?? false,
    }),
  );
  const observation: Observation = {
    id,
    sessionId: meta.sessionId ?? '',
    pageId: meta.pageId ?? '',
    url: meta.url ?? '',
    title: meta.title ?? '',
    capturedAt: meta.capturedAt ?? Date.now(),
    frames,
    elements,
    text,
    dialogs: modalScope(table).dialogs,
    challenge: null,
    warnings: [...warnings],
    stats: {
      domNodes: table.rows.length + table.texts.length,
      axNodes: table.rows.filter((row) => row.ax).length,
      elements: elements.length,
      captureMs: 0,
      buildMs: 0,
      estTokens: 0,
      large: table.rows.length + table.texts.length > 15000,
    },
  };
  const entries = new Map<
    string,
    {
      backendNodeId: number;
      frameId: string;
      cdpFrameId: string;
      locator: {
        v: 1;
        role: string;
        name: string;
        nameIsDynamic: false;
        tag: string;
        attrs: Record<string, never>;
        context: string[];
        cssPath: string;
        framePath: string[];
        ordinal: number;
      };
    }
  >();
  elements.forEach((element) => {
    const row = elementRows[Number(element.ref.slice(1)) - 1];
    if (row)
      entries.set(element.ref, {
        backendNodeId: row.backendNodeId,
        frameId: element.frame,
        cdpFrameId: row.frameId,
        locator: {
          v: 1,
          role: element.role,
          name: element.name,
          nameIsDynamic: false,
          tag: element.tag,
          attrs: {},
          context: element.context,
          cssPath: '',
          framePath: [],
          ordinal: 0,
        },
      });
  });
  return { observation, index: { observationId: id, pageId: meta.pageId ?? '', entries } };
}

function toSemanticElement(row: NodeRow, refNumber: number, table: NodeTable, url = ''): SemanticElement {
  const attrs = row.attrs;
  const inputType = attrs.type?.toLowerCase();
  const role = semanticRole(row, inputType);
  const name = accessibleName(row, table);
  const sensitive = isSensitiveField({
    inputType,
    name: attrs.name,
    id: attrs.id,
    autocomplete: attrs.autocomplete,
    ariaLabel: attrs['aria-label'],
  });
  const state: ElementState = {};
  if (row.ax?.props.disabled === true || attrs.disabled !== undefined) state.disabled = true;
  if (row.inputChecked !== undefined) state.checked = row.inputChecked;
  if (row.ax?.props.checked === true) state.checked = true;
  if (row.ax?.props.expanded === true) state.expanded = true;
  if (row.ax?.props.selected === true) state.selected = true;
  if (row.ax?.props.focused === true) state.focused = true;
  if (row.ax?.props.required === true || attrs.required !== undefined) state.required = true;
  if (row.ax?.props.readonly === true || attrs.readonly !== undefined) state.readonly = true;
  if (
    role === 'textbox' ||
    role === 'searchbox' ||
    role === 'combobox' ||
    row.tag === 'textarea' ||
    attrs.contenteditable !== undefined
  )
    state.editable = true;
  const value = row.ax?.value ?? row.inputValue;
  const frame = frameLabel(row, table);
  return {
    ref: `e${refNumber}`,
    role,
    name,
    tag: row.tag,
    ...(value ? { value: sensitive ? MASKED_VALUE : truncate(value, 120) } : {}),
    ...(attrs.placeholder ? { placeholder: truncate(attrs.placeholder, 120) } : {}),
    ...(attrs.title && attrs.title !== name ? { description: truncate(attrs.title, 120) } : {}),
    ...(attrs.href ? { href: normalizeHref(attrs.href, url) } : {}),
    ...(inputType ? { inputType } : {}),
    state,
    inViewport: inViewport(row.bounds, table.viewport),
    rect: roundedRect(row.bounds),
    frame,
    context: contexts(row, table),
  };
}

function semanticRole(row: NodeRow, inputType = ''): string {
  const axRole = row.ax?.role;
  if (axRole && !['generic', 'none'].includes(axRole)) return axRole;
  if (row.attrs.contenteditable !== undefined) return 'textbox';
  if (row.tag === 'a') return 'link';
  if (row.tag === 'button' || (row.tag === 'input' && ['submit', 'button', 'reset', 'image'].includes(inputType)))
    return 'button';
  if (row.tag === 'select') return 'combobox';
  if (row.tag === 'textarea') return 'textbox';
  if (inputType === 'checkbox') return 'checkbox';
  if (inputType === 'radio') return 'radio';
  if (inputType === 'range') return 'slider';
  if (inputType === 'number') return 'spinbutton';
  if (inputType === 'search') return 'searchbox';
  if (row.tag === 'input') return 'textbox';
  return 'generic';
}

function accessibleName(row: NodeRow, table: NodeTable): string {
  const attrs = row.attrs;
  const descendantText = table.texts
    .filter((text) => text.parentIdx === row.idx)
    .map((text) => text.text)
    .join(' ');
  return truncate(
    collapse(
      row.ax?.name ??
        attrs['aria-label'] ??
        attrs.placeholder ??
        attrs.title ??
        attrs.alt ??
        (row.tag === 'button' ? attrs.value : undefined) ??
        descendantText,
    ),
    120,
  );
}

function contexts(row: NodeRow, table: NodeTable): string[] {
  const accepted = new Set([
    'dialog',
    'alertdialog',
    'navigation',
    'banner',
    'main',
    'search',
    'form',
    'region',
    'complementary',
    'contentinfo',
    'menu',
    'menubar',
    'tablist',
    'toolbar',
    'group',
    'row',
  ]);
  const result: string[] = [];
  let parent = table.rows.find((candidate) => candidate.idx === row.parentIdx);
  while (parent && result.length < 2) {
    const role = parent.ax?.role;
    const name = parent.ax?.name?.trim();
    if (role && accepted.has(role) && (name || !['group', 'row'].includes(role)))
      result.push(name ? `${role}:${truncate(name, 40)}` : role);
    parent = table.rows.find((candidate) => candidate.idx === parent?.parentIdx);
  }
  return result;
}

function isInside(row: NodeRow, ancestorIdx: number, table: NodeTable): boolean {
  let parent = row.parentIdx;
  while (parent !== null) {
    if (parent === ancestorIdx) return true;
    parent = table.rows.find((candidate) => candidate.idx === parent)?.parentIdx ?? null;
  }
  return row.idx === ancestorIdx;
}

function frameLabel(row: NodeRow, table: NodeTable): string {
  const index = table.frames.findIndex((frame) => frame.id === row.frameId);
  return `f${Math.max(0, index)}`;
}

function roundedRect(rect: Rect | null): Rect | null {
  return rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) } : null;
}

function normalizeHref(href: string, pageUrl: string): string {
  try {
    const resolved = new URL(href, pageUrl);
    const page = new URL(pageUrl);
    return resolved.origin === page.origin
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : resolved.toString();
  } catch {
    return href;
  }
}

function textRole(row: NodeRow): TextBlock['role'] {
  if (/^h[1-6]$/.test(row.tag)) return 'heading';
  if (row.ax?.role === 'listitem' || row.tag === 'li') return 'listitem';
  if (row.ax?.role === 'cell' || row.tag === 'td' || row.tag === 'th') return 'cell';
  if (row.ax?.role === 'status') return 'status';
  if (row.ax?.role === 'alert') return 'alert';
  return 'paragraph';
}

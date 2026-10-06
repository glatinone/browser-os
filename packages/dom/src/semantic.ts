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
import { detectChallenge } from './challenge.js';
import { isInteractive } from './interactive.js';
import { joinRawCapture, type NodeRow, type NodeTable, type Rect } from './join.js';
import { collapse, truncate } from './normalize.js';
import { estimateTokens, serializeLines } from './serialize.js';
import { effectiveRect, inViewport, isVisible, modalScope } from './visibility.js';

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
  let currentKey: string | null = null;
  let currentTexts: string[] = [];
  let currentRow: NodeRow | null = null;

  const flush = (): void => {
    if (!currentRow || currentTexts.length === 0) {
      currentTexts = [];
      currentKey = null;
      currentRow = null;
      return;
    }
    const merged = collapse(currentTexts.join(' '));
    if (merged) {
      const remaining = maxTextChars - used;
      if (remaining <= 0) {
        currentTexts = [];
        currentKey = null;
        currentRow = null;
        return;
      }
      const value = truncate(merged, Math.min(300, remaining));
      if (value) {
        const anchorRole = textRole(currentRow);
        blocks.push({
          ref: `t${blocks.length + 1}`,
          text: value,
          role: anchorRole,
          ...(anchorRole === 'heading' ? { level: headingLevel(currentRow) } : {}),
          frame: frameLabel(currentRow, table),
        });
        used += value.length;
      }
    }
    currentTexts = [];
    currentKey = null;
    currentRow = null;
  };

  for (const text of table.texts) {
    if (used >= maxTextChars) break;
    const row = table.rows.find((candidate) => candidate.idx === text.parentIdx);
    if (!row || !isVisible(row, table)) continue;
    const collapsed = collapse(text.text ?? '');
    if (!collapsed) continue;
    const anchor = nearestTextAncestor(row, table);
    const key = `${anchor.idx}:${textRole(anchor)}:${frameLabel(anchor, table)}`;
    if (currentKey !== null && key !== currentKey) flush();
    currentKey = key;
    currentRow = anchor;
    currentTexts.push(collapsed);
  }
  flush();
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
  const scope = modalScope(table);
  const elementRows = table.rows.filter(
    (row) =>
      isInteractive(row, table) &&
      isVisible(row, table) &&
      (scope.dialogIdx === null || isInside(row, scope.dialogIdx, table)),
  );
  const elements = elementRows.map((row, index) => toSemanticElement(row, index + 1, table, meta.url));
  const fullText = buildTextBlocks(table, meta.maxTextChars);
  const text = meta.includeText ? fullText : [];
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
    dialogs: scope.dialogs,
    challenge: detectChallenge({ url: meta.url ?? '', title: meta.title ?? '', text: fullText } as Observation, table),
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
  observation.stats.estTokens = estimateTokens(serializeLines(observation));
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
  const rect = effectiveRect(row, table);
  const description =
    typeof row.ax?.props.description === 'string' && collapse(row.ax.props.description)
      ? truncate(collapse(row.ax.props.description as string), 120)
      : attrs.title && attrs.title !== name
        ? truncate(attrs.title, 120)
        : undefined;
  return {
    ref: `e${refNumber}`,
    role,
    name,
    tag: row.tag,
    ...(value ? { value: sensitive ? MASKED_VALUE : truncate(value, 120) } : {}),
    ...(attrs.placeholder ? { placeholder: truncate(attrs.placeholder, 120) } : {}),
    ...(description ? { description } : {}),
    ...(attrs.href ? { href: normalizeHref(attrs.href, url) } : {}),
    ...(inputType ? { inputType } : {}),
    state,
    inViewport: inViewport(rect, table.viewport),
    rect: roundedRect(rect),
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
  const options = describeSelectOptions(row, table);
  return truncate(
    collapse(
      row.ax?.name ??
        attrs['aria-label'] ??
        attrs.placeholder ??
        attrs.title ??
        attrs.alt ??
        (row.tag === 'button' ? attrs.value : undefined) ??
        descendantText ??
        '',
    ) + (options && !row.ax?.name ? ` (${options})` : ''),
    120,
  );
}

export function describeSelectOptions(row: NodeRow, table: NodeTable): string | undefined {
  if (row.tag !== 'select') return undefined;
  const options: string[] = [];
  const visit = (parentIdx: number | null): void => {
    for (const candidate of table.rows) {
      if (candidate.parentIdx !== parentIdx) continue;
      if (candidate.tag === 'option' || candidate.tag === 'optgroup') {
        const label =
          candidate.ax?.name ||
          collapse(
            table.texts
              .filter((text) => text.parentIdx === candidate.idx)
              .map((text) => text.text)
              .join(' '),
          );
        if (candidate.tag === 'option' && label) options.push(label);
      }
      if (options.length >= 10) return;
      visit(candidate.idx);
      if (options.length >= 10) return;
    }
  };
  visit(row.idx);
  return options.length > 0 ? `options: ${options.slice(0, 10).join(' | ')}` : undefined;
}

function nearestTextAncestor(row: NodeRow, table: NodeTable): NodeRow {
  const blockRoles = new Set(['heading', 'paragraph', 'listitem', 'cell', 'status', 'alert']);
  let current: NodeRow | undefined = row;
  while (current) {
    if (blockRoles.has(textRole(current))) return current;
    current = table.rows.find((candidate) => candidate.idx === current?.parentIdx);
  }
  return row;
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
  if (row.ax?.role === 'paragraph' || row.tag === 'p') return 'paragraph';
  return 'text';
}

function headingLevel(row: NodeRow): number | undefined {
  const match = /^h([1-6])$/.exec(row.tag);
  return match ? Number(match[1]) : undefined;
}

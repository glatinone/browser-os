import type { NodeRow, NodeTable } from './join.js';

export const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'treeitem',
]);

const NATIVE_TAGS = new Set(['button', 'select', 'textarea', 'summary']);

export function hasNativeInteractiveSemantics(row: NodeRow): boolean {
  if (NATIVE_TAGS.has(row.tag)) return true;
  if (row.tag === 'a') return Boolean(row.attrs.href);
  if (row.tag === 'input') return row.attrs.type?.toLowerCase() !== 'hidden';
  return false;
}

export function hasInteractiveRole(row: NodeRow): boolean {
  return Boolean(row.ax?.role && INTERACTIVE_ROLES.has(row.ax.role));
}

export function hasEditableSemantics(row: NodeRow): boolean {
  const value = row.attrs.contenteditable?.toLowerCase();
  return value === '' || value === 'true' || value === 'plaintext-only';
}

export function hasClickableSemantics(row: NodeRow): boolean {
  const tabindex = parseTabIndex(row.attrs.tabindex);
  return row.isClickable && (row.styles.cursor === 'pointer' || tabindex >= 0 || Boolean(row.attrs.role));
}

export function hasFocusableSemantics(row: NodeRow): boolean {
  return parseTabIndex(row.attrs.tabindex) >= 0 && row.ax?.props.focusable === true;
}

export function isDescendantDuplicate(row: NodeRow, table: NodeTable): boolean {
  let parent = parentRow(row, table);
  while (parent) {
    if (
      isInteractiveCandidate(parent) &&
      row.ax?.role === parent.ax?.role &&
      isContainedName(row.ax?.name ?? '', parent.ax?.name ?? '')
    ) {
      return true;
    }
    parent = parentRow(parent, table);
  }
  return false;
}

export function isInteractive(row: NodeRow, table: NodeTable): boolean {
  if (row.tag === 'option' && isNativeSelectOption(row, table)) return false;
  const native = hasNativeInteractiveSemantics(row);
  const candidate =
    native ||
    hasInteractiveRole(row) ||
    hasEditableSemantics(row) ||
    hasClickableSemantics(row) ||
    hasFocusableSemantics(row);
  if (!candidate) return false;
  if (row.ax?.ignored && !native && !hasEditableSemantics(row)) return false;
  return !isDescendantDuplicate(row, table);
}

function isInteractiveCandidate(row: NodeRow): boolean {
  return (
    hasNativeInteractiveSemantics(row) ||
    hasInteractiveRole(row) ||
    hasEditableSemantics(row) ||
    hasClickableSemantics(row) ||
    hasFocusableSemantics(row)
  );
}

function isNativeSelectOption(row: NodeRow, table: NodeTable): boolean {
  let parent = parentRow(row, table);
  while (parent) {
    if (parent.tag === 'select') return true;
    parent = parentRow(parent, table);
  }
  return false;
}

function parentRow(row: NodeRow, table: NodeTable): NodeRow | undefined {
  if (row.parentIdx === null) return undefined;
  return table.rows.find((candidate) => candidate.idx === row.parentIdx);
}

function isContainedName(name: string, ancestorName: string): boolean {
  const child = name.trim().toLowerCase();
  const parent = ancestorName.trim().toLowerCase();
  return child.length === 0 || parent === child || parent.includes(child);
}

function parseTabIndex(value: string | undefined): number {
  if (value === undefined) return -1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : -1;
}

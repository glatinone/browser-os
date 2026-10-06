import type { NodeRow, NodeTable, Rect } from './join.js';

export function inViewport(rect: Rect | null, viewport: NodeTable['viewport']): boolean {
  if (!rect || rect.w <= 0 || rect.h <= 0) return false;
  return rect.x < viewport.width && rect.x + rect.w > 0 && rect.y < viewport.height && rect.y + rect.h > 0;
}

export function isVisible(row: NodeRow, table: NodeTable): boolean {
  if (!hasUsableBounds(row)) {
    return isLabeledFormControl(row, table);
  }
  if (row.styles.display === 'none' || row.styles.visibility === 'hidden' || row.styles.visibility === 'collapse')
    return false;
  if (row.styles.opacity === '0') return isLabeledFormControl(row, table);
  return !hasHiddenAncestor(row, table);
}

export function modalScope(table: NodeTable): { dialogIdx: number | null; dialogs: string[] } {
  const dialogs = table.rows
    .filter((row) => {
      const role = row.ax?.role;
      const modal = row.attrs['aria-modal'] === 'true' || row.ax?.props.modal === true;
      return (role === 'dialog' || role === 'alertdialog') && modal && isVisible(row, table);
    })
    .sort((a, b) => (b.paintOrder ?? -1) - (a.paintOrder ?? -1));

  return {
    dialogIdx: dialogs[0]?.idx ?? null,
    dialogs: dialogs.map((row) => row.ax?.name ?? '').filter(Boolean),
  };
}

function hasUsableBounds(row: NodeRow): boolean {
  return Boolean(row.bounds && row.bounds.w >= 1 && row.bounds.h >= 1);
}

function hasHiddenAncestor(row: NodeRow, table: NodeTable): boolean {
  let parent = parentRow(row, table);
  while (parent) {
    if (
      parent.styles.display === 'none' ||
      parent.styles.visibility === 'hidden' ||
      parent.styles.visibility === 'collapse'
    ) {
      return true;
    }
    parent = parentRow(parent, table);
  }
  return false;
}

function isLabeledFormControl(row: NodeRow, table: NodeTable): boolean {
  const type = row.attrs.type?.toLowerCase();
  if (row.tag !== 'input' || (type !== 'checkbox' && type !== 'radio')) return false;
  if (row.styles.display === 'none' || row.styles.visibility === 'hidden') return false;

  const id = row.attrs.id;
  return table.rows.some((candidate) => {
    if (candidate.tag !== 'label') return false;
    const labelledFor = candidate.attrs.for;
    const wraps = candidate.parentIdx === row.idx || row.parentIdx === candidate.idx;
    return Boolean(
      candidate.bounds && candidate.bounds.w >= 1 && candidate.bounds.h >= 1 && ((id && labelledFor === id) || wraps),
    );
  });
}

function parentRow(row: NodeRow, table: NodeTable): NodeRow | undefined {
  if (row.parentIdx === null) return undefined;
  return table.rows.find((candidate) => candidate.idx === row.parentIdx);
}

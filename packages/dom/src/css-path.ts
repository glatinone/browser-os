import type { NodeRow, NodeTable } from './join.js';

const UNSTABLE_ID_PATTERNS = [
  /\d{4,}/,
  /[0-9a-f]{8,}/i,
  /^:r[0-9a-z]+:$/,
  /^(ember|react|vue|ng|mui|radix|headlessui)[-_]?\d*/i,
  /^[a-z]{1,3}\d+$/i,
];

export function isStableId(id: string): boolean {
  if (!id) return false;
  return !UNSTABLE_ID_PATTERNS.some((pattern) => pattern.test(id));
}

function testIdSelector(attrs: Record<string, string>): string | null {
  for (const key of ['data-testid', 'data-test', 'data-qa']) {
    const value = attrs[key];
    if (value) return `[${key}="${value}"]`;
  }
  return null;
}

function computeTagSelector(row: NodeRow, table: NodeTable): string {
  const tag = row.tag.toLowerCase();
  const siblings = table.rows.filter(
    (r) => r.docIndex === row.docIndex && r.parentIdx === row.parentIdx && r.shadowHostIdx === row.shadowHostIdx,
  );
  const sameTag = siblings.filter((r) => r.tag.toLowerCase() === tag);
  if (sameTag.length > 1) {
    const idx = sameTag.findIndex((r) => r.idx === row.idx);
    const k = idx >= 0 ? idx + 1 : 1;
    return `${tag}:nth-of-type(${k})`;
  }
  return tag;
}

function scopeCssPath(table: NodeTable, startIdx: number, scopeHostIdx: number | null): string {
  const segments: string[] = [];
  let curr: NodeRow | null = table.rows[startIdx] ?? null;

  while (curr !== null) {
    if (scopeHostIdx !== null && curr.idx === scopeHostIdx) {
      break;
    }

    const id = curr.attrs.id;
    if (id && isStableId(id)) {
      segments.unshift(`#${id}`);
      break;
    }

    const testId = testIdSelector(curr.attrs);
    if (testId) {
      segments.unshift(testId);
      break;
    }

    segments.unshift(computeTagSelector(curr, table));

    if (curr.parentIdx === null) break;
    if (scopeHostIdx !== null && curr.parentIdx === scopeHostIdx) {
      break;
    }

    const parentRow = table.rows[curr.parentIdx];
    if (parentRow && parentRow.shadowHostIdx !== curr.shadowHostIdx) {
      break;
    }

    curr = parentRow ?? null;
  }

  const trimmed = segments.slice(-8);
  return trimmed.join(' > ');
}

/**
 * Builds cssPath per dom-intelligence §8.2.
 * Crossing a shadow root: host's path, then " >>> ", then path inside shadow tree.
 */
export function cssPath(table: NodeTable, rowIdx: number): string {
  const row = table.rows[rowIdx];
  if (!row) return '';

  if (row.shadowHostIdx === null) {
    return scopeCssPath(table, rowIdx, null);
  }

  const hostPath = cssPath(table, row.shadowHostIdx);
  const shadowPath = scopeCssPath(table, rowIdx, row.shadowHostIdx);
  return hostPath ? `${hostPath} >>> ${shadowPath}` : shadowPath;
}

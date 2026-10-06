import type { NodeRow, NodeTable } from '@browser-os/dom';
import { effectiveRect, inViewport, isVisible, modalScope, visibleRect } from '@browser-os/dom';
import { describe, expect, it } from 'vitest';

const row = (overrides: Partial<NodeRow> = {}): NodeRow => ({
  idx: 1,
  backendNodeId: 1,
  docIndex: 0,
  frameId: 'main',
  parentIdx: null,
  tag: 'div',
  attrs: {},
  shadowHostIdx: null,
  bounds: { x: 0, y: 0, w: 20, h: 20 },
  styles: {},
  paintOrder: 1,
  isClickable: false,
  ...overrides,
});
const table = (rows: NodeRow[]): NodeTable => ({
  rows,
  texts: [],
  frames: [{ id: 'main', url: '', name: '', parentId: null }],
  viewport: { width: 100, height: 100, pageX: 0, pageY: 0 },
});

describe('visibility rules', () => {
  it('checks viewport intersection and usable bounds', () => {
    expect(inViewport({ x: 90, y: 90, w: 20, h: 20 }, { width: 100, height: 100, pageX: 0, pageY: 0 })).toBe(true);
    expect(inViewport({ x: 0, y: 0, w: 0, h: 20 }, { width: 100, height: 100, pageX: 0, pageY: 0 })).toBe(false);
  });
  it('rejects hidden ancestors and zero-sized rows', () => {
    const hidden = row({ idx: 1, styles: { display: 'none' } });
    const child = row({ idx: 2, parentIdx: 1 });
    expect(isVisible(child, table([hidden, child]))).toBe(false);
    expect(
      isVisible(row({ bounds: { x: 0, y: 0, w: 0, h: 0 } }), table([row({ bounds: { x: 0, y: 0, w: 0, h: 0 } })])),
    ).toBe(false);
  });
  it('selects the topmost modal and returns names in paint order', () => {
    const first = row({
      idx: 1,
      paintOrder: 1,
      ax: { role: 'dialog', name: 'First', ignored: false, props: { modal: true } },
    });
    const second = row({
      idx: 2,
      paintOrder: 2,
      ax: { role: 'dialog', name: 'Second', ignored: false, props: { modal: true } },
    });
    expect(modalScope(table([first, second]))).toEqual({ dialogIdx: 2, dialogs: ['Second', 'First'] });
  });

  it('keeps a zero-size labeled checkbox and reports the label rect', () => {
    const input = row({
      idx: 1,
      tag: 'input',
      attrs: { type: 'checkbox', id: 'news' },
      bounds: { x: 0, y: 0, w: 0, h: 0 },
      styles: { opacity: '0' },
    });
    const label = row({
      idx: 2,
      tag: 'label',
      attrs: { for: 'news' },
      bounds: { x: 10, y: 20, w: 80, h: 16 },
    });
    const rows = [input, label];
    expect(isVisible(input, table(rows))).toBe(true);
    expect(effectiveRect(input, table(rows))).toEqual({ x: 10, y: 20, w: 80, h: 16 });
    expect(visibleRect(input, table(rows))).toEqual({ x: 10, y: 20, w: 80, h: 16 });
  });

  it('rejects hidden and collapsed subtrees', () => {
    const root = row({ idx: 1 });
    const hidden = row({ idx: 2, parentIdx: 1, styles: { visibility: 'hidden' } });
    const collapsed = row({ idx: 3, parentIdx: 1, styles: { visibility: 'collapse' } });
    const rows = [root, hidden, collapsed];
    expect(isVisible(hidden, table(rows))).toBe(false);
    expect(isVisible(collapsed, table(rows))).toBe(false);
    expect(visibleRect(hidden, table(rows))).toBeNull();
    expect(visibleRect(collapsed, table(rows))).toBeNull();
  });
});

import type { NodeRow, NodeTable } from '@browser-os/dom';
import {
  hasClickableSemantics,
  hasEditableSemantics,
  hasFocusableSemantics,
  hasInteractiveRole,
  hasNativeInteractiveSemantics,
  isInteractive,
  isTopmostEditable,
} from '@browser-os/dom';
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

describe('interactivity rules', () => {
  it('recognizes native controls and links', () => {
    expect(hasNativeInteractiveSemantics(row({ tag: 'button' }))).toBe(true);
    expect(hasNativeInteractiveSemantics(row({ tag: 'a', attrs: { href: '/home' } }))).toBe(true);
    expect(hasNativeInteractiveSemantics(row({ tag: 'input', attrs: { type: 'hidden' } }))).toBe(false);
  });
  it('recognizes roles, editable, clickable, and focusable semantics', () => {
    expect(hasInteractiveRole(row({ ax: { role: 'button', name: '', ignored: false, props: {} } }))).toBe(true);
    expect(hasEditableSemantics(row({ attrs: { contenteditable: 'true' } }))).toBe(true);
    expect(hasClickableSemantics(row({ isClickable: true, styles: { cursor: 'pointer' } }))).toBe(true);
    expect(
      hasFocusableSemantics(
        row({ attrs: { tabindex: '0' }, ax: { role: '', name: '', ignored: false, props: { focusable: true } } }),
      ),
    ).toBe(true);
  });
  it('drops ignored and duplicate descendants', () => {
    const parent = row({ idx: 1, tag: 'button', ax: { role: 'button', name: 'Save', ignored: false, props: {} } });
    const child = row({ idx: 2, parentIdx: 1, ax: { role: 'button', name: 'Save', ignored: false, props: {} } });
    expect(isInteractive(parent, table([parent, child]))).toBe(true);
    expect(isInteractive(child, table([parent, child]))).toBe(false);
  });

  it('keeps only the topmost editable ancestor', () => {
    const parent = row({ idx: 1, attrs: { contenteditable: 'true' } });
    const child = row({ idx: 2, parentIdx: 1, attrs: { contenteditable: 'true' } });
    expect(isTopmostEditable(parent, table([parent, child]))).toBe(true);
    expect(isTopmostEditable(child, table([parent, child]))).toBe(false);
    expect(isInteractive(parent, table([parent, child]))).toBe(true);
    expect(isInteractive(child, table([parent, child]))).toBe(false);
  });

  it('keeps a checkbox with a different role inside a clickable row', () => {
    const parent = row({
      idx: 1,
      isClickable: true,
      styles: { cursor: 'pointer' },
      ax: { role: 'generic', name: 'Subscribe', ignored: false, props: {} },
    });
    const child = row({
      idx: 2,
      parentIdx: 1,
      tag: 'input',
      attrs: { type: 'checkbox' },
      ax: { role: 'checkbox', name: 'Subscribe', ignored: false, props: {} },
    });
    expect(isInteractive(child, table([parent, child]))).toBe(true);
  });

  it('drops native select options but keeps visible listbox options', () => {
    const select = row({ idx: 1, tag: 'select' });
    const nativeOption = row({
      idx: 2,
      parentIdx: 1,
      tag: 'option',
      ax: { role: 'option', name: 'A', ignored: false, props: {} },
    });
    const listbox = row({ idx: 3, ax: { role: 'listbox', name: 'Choices', ignored: false, props: {} } });
    const listOption = row({
      idx: 4,
      parentIdx: 3,
      tag: 'option',
      ax: { role: 'option', name: 'B', ignored: false, props: {} },
    });
    expect(isInteractive(nativeOption, table([select, nativeOption]))).toBe(false);
    expect(isInteractive(listOption, table([listbox, listOption]))).toBe(true);
  });
});

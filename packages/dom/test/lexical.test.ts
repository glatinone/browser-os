import type { SemanticElement } from '@browser-os/protocol';
import { describe, expect, it } from 'vitest';
import { isCompatible } from '../src/compat.js';
import { lexicalDecision, lexicalRank } from '../src/lexical.js';

function makeElement(partial: Partial<SemanticElement> = {}): SemanticElement {
  return {
    ref: 'e1',
    role: 'button',
    name: 'Submit',
    tag: 'button',
    state: {},
    inViewport: true,
    rect: { x: 0, y: 0, w: 100, h: 30 },
    frame: 'f0',
    context: [],
    ...partial,
  };
}

describe('isCompatible', () => {
  it('compatible with fill only for editable/textbox/searchbox/combobox/spinbutton and non-disabled', () => {
    const input = makeElement({ role: 'textbox', tag: 'input', state: { editable: true } });
    const btn = makeElement({ role: 'button', tag: 'button' });
    const disabledInput = makeElement({ role: 'textbox', tag: 'input', state: { disabled: true, editable: true } });

    expect(isCompatible(input, 'fill')).toBe(true);
    expect(isCompatible(btn, 'fill')).toBe(false);
    expect(isCompatible(disabledInput, 'fill')).toBe(false);

    expect(isCompatible(makeElement({ role: 'searchbox' }), 'fill')).toBe(true);
    expect(isCompatible(makeElement({ role: 'combobox' }), 'fill')).toBe(true);
    expect(isCompatible(makeElement({ role: 'spinbutton' }), 'fill')).toBe(true);
  });

  it('compatible with select only for select tag or combobox/listbox', () => {
    const sel = makeElement({ role: 'combobox', tag: 'select' });
    const listbox = makeElement({ role: 'listbox', tag: 'div' });
    const txt = makeElement({ role: 'textbox', tag: 'input' });

    expect(isCompatible(sel, 'select')).toBe(true);
    expect(isCompatible(listbox, 'select')).toBe(true);
    expect(isCompatible(txt, 'select')).toBe(false);
  });

  it('compatible with click/hover for non-disabled elements', () => {
    const btn = makeElement({ role: 'button', tag: 'button' });
    const disabledBtn = makeElement({ role: 'button', tag: 'button', state: { disabled: true } });

    expect(isCompatible(btn, 'click')).toBe(true);
    expect(isCompatible(btn, 'hover')).toBe(true);
    expect(isCompatible(disabledBtn, 'click')).toBe(false);
    expect(isCompatible(disabledBtn, 'hover')).toBe(false);
  });

  it('compatible with upload only for file inputs', () => {
    const file = makeElement({ tag: 'input', inputType: 'file', role: 'button' });
    const text = makeElement({ tag: 'input', inputType: 'text', role: 'textbox' });

    expect(isCompatible(file, 'upload')).toBe(true);
    expect(isCompatible(text, 'upload')).toBe(false);
  });

  it('compatible with waitFor, extract, scroll for any element', () => {
    const disabledBtn = makeElement({ role: 'button', state: { disabled: true } });
    expect(isCompatible(disabledBtn, 'waitFor')).toBe(true);
    expect(isCompatible(disabledBtn, 'extract')).toBe(true);
    expect(isCompatible(disabledBtn, 'scroll')).toBe(true);
  });
});

describe('lexicalRank', () => {
  it('ranks elements with exact name match highest', () => {
    const e1 = makeElement({ ref: 'e1', role: 'button', name: 'Submit Form' });
    const e2 = makeElement({ ref: 'e2', role: 'button', name: 'Cancel' });

    const ranked = lexicalRank([e1, e2], 'click "Submit Form" button');
    expect(ranked[0]?.element.ref).toBe('e1');
    expect(ranked[0]?.score).toBeGreaterThan(0.75);
  });

  it('filters out incompatible elements by action type', () => {
    const e1 = makeElement({ ref: 'e1', role: 'button', name: 'Search' });
    const e2 = makeElement({ ref: 'e2', role: 'textbox', name: 'Search', state: { editable: true } });

    const rankedFill = lexicalRank([e1, e2], 'Search', 'fill');
    expect(rankedFill).toHaveLength(1);
    expect(rankedFill[0]?.element.ref).toBe('e2');
  });

  it('applies search bonus to search elements when search is in intent', () => {
    const e1 = makeElement({ ref: 'e1', role: 'searchbox', name: 'Items' });
    const rankedWithBonus = lexicalRank([e1], 'items search box');
    const rankedWithoutBonus = lexicalRank([e1], 'items box');
    expect(rankedWithBonus[0]?.score).toBeGreaterThan(rankedWithoutBonus[0]?.score ?? 0);
    expect(rankedWithBonus[0]?.score).toBeCloseTo((rankedWithoutBonus[0]?.score ?? 0) + 0.1, 5);
  });

  it('breaks ties using original document order', () => {
    const e1 = makeElement({ ref: 'e1', role: 'button', name: 'Save' });
    const e2 = makeElement({ ref: 'e2', role: 'button', name: 'Save' });

    const ranked = lexicalRank([e1, e2], 'Save button');
    expect(ranked[0]?.element.ref).toBe('e1');
    expect(ranked[1]?.element.ref).toBe('e2');
  });
});

describe('lexicalDecision', () => {
  it('accepts candidate when score >= accept and margin >= margin', () => {
    const e1 = makeElement({ ref: 'e1' });
    const e2 = makeElement({ ref: 'e2' });

    const decision = lexicalDecision([
      { element: e1, score: 0.85 },
      { element: e2, score: 0.65 },
    ]);
    expect(decision).toEqual({ element: e1 });
  });

  it('returns TARGET_NOT_FOUND when best score < accept threshold', () => {
    const e1 = makeElement({ ref: 'e1' });
    const decision = lexicalDecision([{ element: e1, score: 0.7 }]);
    expect(decision).toEqual({ reason: 'TARGET_NOT_FOUND' });
  });

  it('returns TARGET_AMBIGUOUS when difference to runner up is below margin', () => {
    const e1 = makeElement({ ref: 'e1' });
    const e2 = makeElement({ ref: 'e2' });

    const decision = lexicalDecision([
      { element: e1, score: 0.85 },
      { element: e2, score: 0.8 },
    ]);
    expect(decision).toEqual({ reason: 'TARGET_AMBIGUOUS' });
  });
});

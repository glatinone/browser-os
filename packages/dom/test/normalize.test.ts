import { collapse, dice, normalizeName, parseIntent, tokenize, truncate } from '@browser-os/dom';
import { describe, expect, it } from 'vitest';

describe('text normalization', () => {
  it.each([
    ['  hello\n world  ', 'hello world'],
    ['already compact', 'already compact'],
    ['', ''],
  ])('collapse(%j) -> %j', (input, expected) => {
    expect(collapse(input)).toBe(expected);
  });

  it.each([
    ['hello world', 20, 'hello world'],
    ['hello world', 6, 'hello…'],
    ['hello', 1, '…'],
    ['hello', 0, ''],
  ])('truncate(%j, %i) -> %j', (input, length, expected) => {
    expect(truncate(input, length)).toBe(expected);
  });

  it.each([
    ['Order 123', 'order #'],
    ['  Sign   In ', 'sign in'],
  ])('normalizeName(%j) -> %j', (input, expected) => {
    expect(normalizeName(input)).toBe(expected);
  });

  it('tokenizes on non-alphanumeric characters', () => {
    expect(tokenize('Search_box #2')).toEqual(['search', 'box', '2']);
  });

  it.each([
    [['sign', 'in'], ['sign', 'in'], 1],
    [['sign', 'in'], ['signin'], 0.6666666666666666],
    [[], [], 1],
    [[], ['word'], 0],
    [['word'], [], 0],
    [['cat', 'cater'], ['cat', 'category'], 0.5],
    [['cat', 'cater'], ['cater', 'cat'], 1],
    [['cater', 'cat'], ['cater'], 0.6666666666666666],
    [['cater', 'cater'], ['cater'], 0.6666666666666666],
    [['cater', 'caterlong'], ['caterlong', 'cater'], 1],
    [['cat', 'cater'], ['cat', 'cattle'], 0.5],
    [['alpha', 'alphabet'], ['alphabet', 'alpha'], 1],
    [['search'], ['searching'], 1],
    [['one'], ['two'], 0],
  ])('dice(%j, %j) -> %d', (left, right, expected) => {
    expect(dice(left, right)).toBe(expected);
  });
});

describe('parseIntent', () => {
  it.each([
    [
      'click "Sign in" and "Continue" button',
      { tokens: ['and'], exact: 'Sign in', roleHints: ['button'], searchBonus: false },
    ],
    ['the search box', { tokens: [], exact: null, roleHints: ['searchbox', 'combobox', 'textbox'], searchBonus: true }],
    ['Messages', { tokens: ['messages'], exact: null, roleHints: [], searchBonus: false }],
    [
      'type into email field',
      {
        tokens: ['email'],
        exact: null,
        roleHints: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
        searchBonus: false,
      },
    ],
    [
      'click "Sign in" and "Continue" button',
      { tokens: ['and'], exact: 'Sign in', roleHints: ['button'], searchBonus: false },
    ],
    [
      'click "Sign in" or "Continue" button',
      { tokens: ['or'], exact: 'Sign in', roleHints: ['button'], searchBonus: false },
    ],
    ['click ""', { tokens: [], exact: '', roleHints: [], searchBonus: false }],
    ['click the button link', { tokens: [], exact: null, roleHints: ['button', 'link'], searchBonus: false }],
    [
      'pick the search field and menu item',
      {
        tokens: ['pick', 'and'],
        exact: null,
        roleHints: ['searchbox', 'combobox', 'textbox', 'menuitem', 'button'],
        searchBonus: true,
      },
    ],
  ])('parses %j', (input, expected) => {
    expect(parseIntent(input)).toEqual(expected);
  });
});

import { describe, expect, it } from 'vitest';
import type { BrowserAction, ElementLocator } from '../src/index.js';
import {
  fieldsOf,
  isSensitiveField,
  isSensitiveName,
  MASKED_VALUE,
  maskAction,
  SENSITIVE_AUTOCOMPLETE,
  SENSITIVE_NAME_RE,
} from '../src/index.js';

const LOCATOR = (attrs: ElementLocator['attrs']): ElementLocator => ({
  v: 1,
  role: 'textbox',
  name: 'Password',
  nameIsDynamic: false,
  tag: 'input',
  attrs,
  context: [],
  cssPath: '#x',
  framePath: [],
  ordinal: 0,
});

const fill = (
  value: BrowserAction extends never ? never : { kind: 'literal' | 'param' | 'secret'; value?: string; name?: string },
): BrowserAction => {
  const source =
    value.kind === 'literal'
      ? { kind: 'literal' as const, value: value.value ?? '' }
      : value.kind === 'param'
        ? { kind: 'param' as const, name: value.name ?? 'q' }
        : { kind: 'secret' as const, name: value.name ?? 'TOKEN' };
  return { type: 'fill', target: { kind: 'intent', text: 'the field' }, value: source };
};

describe('SENSITIVE_NAME_RE', () => {
  it('is the single definition (integration §2), and matches the documented tokens', () => {
    for (const name of [
      'password',
      'user_password',
      'apiSecret',
      'access_token',
      'otp',
      'one-time-code',
      '2fa',
      'mfa',
      'cvv',
      'cvc',
      'card-number',
      'cc_number',
      'pin',
      'security-code',
      'verification_code',
    ]) {
      expect(SENSITIVE_NAME_RE.test(name), name).toBe(true);
    }
    for (const name of ['username', 'email', 'search', 'country', 'notes']) {
      expect(SENSITIVE_NAME_RE.test(name), name).toBe(false);
    }
  });

  it('is not a global regex, so repeated tests do not alternate (lastIndex trap)', () => {
    expect(SENSITIVE_NAME_RE.global).toBe(false);
    expect(SENSITIVE_NAME_RE.test('password')).toBe(true);
    expect(SENSITIVE_NAME_RE.test('password')).toBe(true);
  });
});

describe('isSensitiveName', () => {
  it('matches on the name, case-insensitively', () => {
    expect(isSensitiveName('Password')).toBe(true);
    expect(isSensitiveName('API_TOKEN')).toBe(true);
    expect(isSensitiveName('username')).toBe(false);
    expect(isSensitiveName('')).toBe(false);
  });

  it('is false for a missing name, and never throws on non-strings', () => {
    expect(isSensitiveName(undefined)).toBe(false);
    expect(isSensitiveName(null)).toBe(false);
  });
});

describe('isSensitiveField', () => {
  it('is true for a password input whatever it is called', () => {
    expect(isSensitiveField({ inputType: 'password' })).toBe(true);
    expect(isSensitiveField({ inputType: 'password', name: 'nickname' })).toBe(true);
  });

  it('is true for every autocomplete token in the documented set', () => {
    for (const token of SENSITIVE_AUTOCOMPLETE) {
      expect(isSensitiveField({ autocomplete: token }), token).toBe(true);
    }
  });

  it('treats the autocomplete token case-insensitively', () => {
    expect(isSensitiveField({ autocomplete: 'CURRENT-PASSWORD' })).toBe(true);
  });

  it('is true when any of name, id, ariaLabel or autocomplete looks sensitive', () => {
    expect(isSensitiveField({ name: 'user_password' })).toBe(true);
    expect(isSensitiveField({ id: 'otp-code' })).toBe(true);
    expect(isSensitiveField({ ariaLabel: 'One-time code' })).toBe(true);
    expect(isSensitiveField({ autocomplete: 'cc-number' })).toBe(true);
  });

  it('is false for an ordinary field', () => {
    expect(isSensitiveField({})).toBe(false);
    expect(isSensitiveField({ inputType: 'email', name: 'email', id: 'email', ariaLabel: 'Email address' })).toBe(
      false,
    );
  });
});

describe('fieldsOf', () => {
  it('maps locator attributes onto the field check (type -> inputType, aria-label -> ariaLabel)', () => {
    expect(
      fieldsOf(
        LOCATOR({ type: 'password', name: 'pw', id: 'p1', autocomplete: 'current-password', 'aria-label': 'Password' }),
      ),
    ).toEqual({
      inputType: 'password',
      name: 'pw',
      id: 'p1',
      autocomplete: 'current-password',
      ariaLabel: 'Password',
    });
  });

  it('produces an all-undefined shape for an element with no attributes', () => {
    const fields = fieldsOf(LOCATOR({}));
    expect(isSensitiveField(fields)).toBe(false);
    expect(fields).toEqual({
      inputType: undefined,
      name: undefined,
      id: undefined,
      autocomplete: undefined,
      ariaLabel: undefined,
    });
  });

  it('feeds isSensitiveField: a password locator is sensitive', () => {
    expect(isSensitiveField(fieldsOf(LOCATOR({ type: 'password' })))).toBe(true);
  });
});

describe('maskAction', () => {
  it('masks a literal by default, because before resolution nothing is known', () => {
    const masked = maskAction(fill({ kind: 'literal', value: 'hunter2' }));
    expect(masked).toEqual({
      type: 'fill',
      target: { kind: 'intent', text: 'the field' },
      value: { kind: 'literal', value: MASKED_VALUE },
    });
  });

  it('masks a literal when the caller says the target is sensitive', () => {
    const masked = maskAction(fill({ kind: 'literal', value: '4111 1111 1111 1111' }), { sensitiveTarget: true });
    expect(JSON.stringify(masked)).not.toContain('4111');
    expect(JSON.stringify(masked)).toContain(MASKED_VALUE);
  });

  it('keeps a literal when the caller proved the target is not sensitive', () => {
    const action = fill({ kind: 'literal', value: 'Ada Lovelace' });
    expect(maskAction(action, { sensitiveTarget: false })).toEqual(action);
  });

  it('always shows param and secret references, even when masking literals', () => {
    for (const source of [
      { kind: 'param' as const, name: 'query' },
      { kind: 'secret' as const, name: 'API_TOKEN' },
    ]) {
      const masked = maskAction(
        { type: 'fill', target: { kind: 'intent', text: 'the field' }, value: source },
        { sensitiveTarget: true },
      );
      expect(masked).toEqual({ type: 'fill', target: { kind: 'intent', text: 'the field' }, value: source });
      if (masked.type === 'fill') expect(masked.value).toEqual(source);
    }
  });

  it('masks a select value too', () => {
    const action: BrowserAction = {
      type: 'select',
      target: { kind: 'query', css: '#c' },
      value: { kind: 'literal', value: 'secret-option' },
    };
    const masked = maskAction(action, { sensitiveTarget: true });
    expect(masked).toEqual({
      type: 'select',
      target: { kind: 'query', css: '#c' },
      value: { kind: 'literal', value: MASKED_VALUE },
    });
  });

  it('copies a targetless or action without values untouched', () => {
    const click: BrowserAction = { type: 'click', target: { kind: 'intent', text: 'Sign in' } };
    expect(maskAction(click)).toEqual(click);
    const navigate: BrowserAction = { type: 'navigate', url: 'https://example.com/?token=abc' };
    expect(maskAction(navigate)).toEqual(navigate);
  });

  it('returns a new object and never mutates the input', () => {
    const action = fill({ kind: 'literal', value: 'hunter2' });
    const before = structuredClone(action);
    const masked = maskAction(action);
    expect(masked).not.toBe(action);
    expect(action).toEqual(before);
    if (masked.type === 'fill' && masked.value.kind === 'literal') expect(masked.value.value).toBe(MASKED_VALUE);
  });

  it('is idempotent', () => {
    const once = maskAction(fill({ kind: 'literal', value: 'hunter2' }));
    expect(maskAction(once)).toEqual(once);
  });

  it('never leaves the original value anywhere in the masked output', () => {
    const action = fill({ kind: 'literal', value: 'sup3r-s3cret' });
    expect(JSON.stringify(maskAction(action))).not.toContain('sup3r-s3cret');
  });
});

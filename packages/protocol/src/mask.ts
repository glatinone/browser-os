// Masking: the ONLY sensitivity definition in the codebase (integration §2).
//
// Every other document that lists a sensitivity regex refers to this one. If a
// value can be secret, it is identified here and nowhere else, so a reviewer has
// exactly one place to check when asking "can a secret leak into a log, a
// database row, an event or a model prompt?".
//
// Two directions of the same guard:
//   * before target resolution we do not yet know what the element is, so every
//     literal is masked (the safe default);
//   * after resolution the caller passes the real `sensitiveTarget`.

import type { BrowserAction, ValueSource } from './actions.js';
import type { ElementLocator } from './dom.js';

/** The one sensitivity regex. Matches field names, ids, labels and autocomplete tokens. */
export const SENSITIVE_NAME_RE =
  /pass|secret|token|otp|one.?time|2fa|mfa|cvv|cvc|card.?number|cc.?number|\bpin\b|security.?code|verification.?code/i;

/** What a masked literal looks like. Never a substring of the original value. */
export const MASKED_VALUE = '\u2022\u2022\u2022\u2022';

/** autocomplete tokens that mark a field as sensitive even when the name looks innocent. */
export const SENSITIVE_AUTOCOMPLETE: ReadonlySet<string> = new Set([
  'one-time-code',
  'cc-number',
  'cc-csc',
  'current-password',
  'new-password',
]);

/** True when a field name, id or label looks like it carries a secret. */
export function isSensitiveName(s: string | undefined | null): boolean {
  return typeof s === 'string' && SENSITIVE_NAME_RE.test(s);
}

export interface SensitiveFieldInput {
  inputType?: string | undefined;
  name?: string | undefined;
  id?: string | undefined;
  autocomplete?: string | undefined;
  ariaLabel?: string | undefined;
}

/**
 * Field-level check used by `dom` and `runtime`. Lives here, not in `dom`, so the
 * one definition is shared (integration §2).
 */
export function isSensitiveField(f: SensitiveFieldInput): boolean {
  if (f.inputType === 'password') return true;
  if (f.autocomplete !== undefined && SENSITIVE_AUTOCOMPLETE.has(f.autocomplete.toLowerCase())) return true;
  return (
    isSensitiveName(f.name) || isSensitiveName(f.id) || isSensitiveName(f.ariaLabel) || isSensitiveName(f.autocomplete)
  );
}

/** Maps an ElementLocator's stable attributes onto the field check above. */
export function fieldsOf(locator: Pick<ElementLocator, 'attrs'>): SensitiveFieldInput {
  return {
    inputType: locator.attrs.type,
    name: locator.attrs.name,
    id: locator.attrs.id,
    autocomplete: locator.attrs.autocomplete,
    ariaLabel: locator.attrs['aria-label'],
  };
}

function maskValue(value: ValueSource): ValueSource {
  // `param` and `secret` are references, not values: they are safe to show and are
  // never resolved here. Only a literal can carry a secret.
  return value.kind === 'literal' ? { kind: 'literal', value: MASKED_VALUE } : value;
}

/**
 * Returns a copy of the action with literal values masked. The input is never
 * mutated. `sensitiveTarget` defaults to true: before resolution the element is
 * unknown, and guessing "not sensitive" is how secrets leak.
 */
export function maskAction(action: BrowserAction, opts: { sensitiveTarget?: boolean } = {}): BrowserAction {
  const hideLiterals = opts.sensitiveTarget ?? true;
  if (hideLiterals && (action.type === 'fill' || action.type === 'select')) {
    return { ...action, value: maskValue(action.value) };
  }
  return { ...action };
}

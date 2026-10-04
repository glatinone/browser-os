// CDP keyboard input (action-router §6): a small key table, Playwright-style combos, keyDown/keyUp.

import type { CdpTransport } from '../cdp/transport.js';
import { type DriverOutcome, describe, refuse, unsure } from './op.js';
import type { ResolvedTarget } from './types.js';

interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  /** Only printable keys carry text; the browser inserts it for us. */
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

/** The modifier bitmask CDP uses (Input.dispatchKeyEvent). */
const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

interface Combo {
  key: KeyDefinition;
  modifiers: number;
}

/** `Control+A`, `Shift+Tab`, `Meta+Enter` or a single printable character. */
export function parseKeyCombo(combo: string): Combo | null {
  const parts = combo.split('+');
  const name = parts.pop() ?? '';
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIER_BITS[part];
    if (bit === undefined) return null;
    modifiers |= bit;
  }

  const named = NAMED_KEYS[name];
  if (named !== undefined) return { key: named, modifiers };

  if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : name;
    return {
      key: { key: name, code, keyCode: upper.charCodeAt(0), text: name },
      modifiers,
    };
  }

  return null;
}

/** Presses `combo`, focusing `target` first when there is one. */
export async function cdpPress(
  transport: CdpTransport,
  combo: string,
  target: ResolvedTarget | null,
): Promise<DriverOutcome> {
  const parsed = parseKeyCombo(combo);
  if (parsed === null) {
    return refuse('INVALID_REQUEST', `${combo} is not a key this driver knows`);
  }

  // Focusing dispatches nothing, so a failure here is still `none`.
  if (target !== null) {
    try {
      await transport.send('DOM.focus', { backendNodeId: target.backendNodeId });
    } catch (error) {
      return refuse('TARGET_NOT_FOUND', `could not focus the target: ${describe(error)}`);
    }
  }

  const shared = {
    key: parsed.key.key,
    code: parsed.key.code,
    windowsVirtualKeyCode: parsed.key.keyCode,
    nativeVirtualKeyCode: parsed.key.keyCode,
    modifiers: parsed.modifiers,
  };

  try {
    await transport.send('Input.dispatchKeyEvent', {
      // `keyDown` carries text and inserts it; `rawKeyDown` is for keys that do not.
      type: parsed.key.text === undefined ? 'rawKeyDown' : 'keyDown',
      ...shared,
      ...(parsed.key.text === undefined ? {} : { text: parsed.key.text, unmodifiedText: parsed.key.text }),
    });
    await transport.send('Input.dispatchKeyEvent', { type: 'keyUp', ...shared });
  } catch (error) {
    return unsure(error);
  }

  return { ok: true, effect: 'committed' };
}

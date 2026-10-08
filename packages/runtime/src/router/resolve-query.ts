import type { Observation, IndexEntry, ResolvedTarget, ExecutionContext } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import { DEFAULT_ROUTER_CONSTANTS } from './constants.js';

export interface QueryTarget {
  kind: 'query';
  role?: string;
  name?: string;
  text?: string;
  css?: string;
  nth?: number;
}

export function structuredFilter(
  obs: any,
  target: any
): any[] {
  let matches = obs.elements;
  
  if (target.role) {
    matches = matches.filter((el: any) => el.role === target.role);
  }
  if (target.name) {
    matches = matches.filter((el: any) => 
      el.name === target.name || el.name?.includes(target.name)
    );
  }
  if (target.text) {
    matches = matches.filter((el: any) => 
      el.value?.includes(target.text) || el.text?.includes(target.text)
    );
  }
  if (target.css) {
    matches = matches.filter((el: any) => el.cssPath === target.css);
  }
  
  return matches;
}

export function isCompatible(element: any, actionType: string): boolean {
  switch (element.role) {
    case 'textbox':
    case 'searchbox':
    case 'combobox':
    case 'spinbutton':
    case 'textbox':
      return actionType === 'fill' || actionType === 'click' || actionType === 'press' || actionType === 'waitFor' || actionType === 'extract';
    case 'button':
    case 'link':
      return actionType === 'click' || actionType === 'hover' || actionType === 'press' || actionType === 'waitFor' || actionType === 'extract';
    case 'checkbox':
    case 'radio':
    case 'switch':
      return actionType === 'click' || actionType === 'press' || actionType === 'waitFor' || actionType === 'extract';
    case 'select':
    case 'listbox':
    case 'combobox':
      return actionType === 'select' || actionType === 'click' || actionType === 'waitFor' || actionType === 'extract';
    case 'slider':
    case 'spinbutton':
      return actionType === 'click' || actionType === 'press' || actionType === 'waitFor' || actionType === 'extract';
    default:
      return actionType === 'click' || actionType === 'hover' || actionType === 'press' || actionType === 'waitFor' || actionType === 'extract';
  }
}

export async function resolveQueryTarget(
  target: any,
  ctx: any,
  attempts: any[],
  driver: any,
  observer: any
): Promise<any> {
  const obs = await driver.capture();
  const matches = structuredFilter(obs, target);
  
  if (matches.length === 0) {
    throw new BosError('TARGET_NOT_FOUND', `No elements match query`);
  }
  
  if (target.nth !== undefined && matches.length > target.nth) {
    const element = matches[target.nth];
    return buildResolution(element, 'deterministic', 'query');
  }
  
  if (matches.length === 1) {
    return buildResolution(matches[0], 'deterministic', 'query');
  }
  
  throw new BosError('TARGET_AMBIGUOUS', `${matches.length} elements match query`, {
    candidates: matches.slice(0, 5).map((el: any) => ({ ref: el.ref, role: el.role, name: el.name }))
  });
}

function buildResolution(element: any, tier: string, targetKind: string) {
  return {
    tier,
    entry: {
      backendNodeId: element.backendNodeId,
      frameId: element.frame,
      cdpFrameId: element.cdpFrameId,
      locator: element.locator,
    },
    element: { ref: element.ref, role: element.role, name: element.name },
    disabled: element.disabled,
  };
}
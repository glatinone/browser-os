import type { Observation, SemanticElement } from '@browser-os/protocol';
import { collapse, truncate } from './normalize.js';

export interface SerializeOptions {
  viewportOnly?: boolean;
}

export function serializeLines(observation: Observation, options: SerializeOptions = {}): string {
  const lines = [
    `url: ${observation.url}`,
    `title: ${observation.title}`,
    `dialogs: ${observation.dialogs.length ? observation.dialogs.join(' > ') : 'none'}`,
  ];
  if (observation.challenge) lines.push(`challenge: ${observation.challenge}`);
  for (const element of observation.elements) {
    if (options.viewportOnly && !element.inViewport) continue;
    lines.push(serializeElement(element));
  }
  for (const block of observation.text) lines.push(`${block.ref} ${block.role} "${escapeText(block.text)}"`);
  return lines.join('\n');
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function serializeElement(element: SemanticElement): string {
  const parts = [`${element.ref} ${element.role} "${escapeText(element.name)}"`];
  if (element.placeholder) parts.push(`placeholder="${escapeText(element.placeholder)}"`);
  if (element.value) parts.push(`value="${escapeText(element.value)}"`);
  if (element.state.disabled) parts.push('(disabled)');
  if (element.state.checked === true) parts.push('(checked)');
  if (element.state.expanded === true) parts.push('(expanded)');
  if (!element.inViewport) parts.push('↓offscreen');
  if (element.context.length) parts.push(`[${element.context.join(' > ')}]`);
  return parts.join(' ');
}

function escapeText(value: string): string {
  return collapse(truncate(value, 300)).replaceAll('"', '\\"');
}

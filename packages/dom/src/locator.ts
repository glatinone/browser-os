import type {
  ActionType,
  ElementLocator,
  FrameInfo,
  IndexEntry,
  Observation,
  ObservationIndex,
  Rect,
  SemanticElement,
  StableAttr,
} from '@browser-os/protocol';
import { cssPath, isStableId } from './css-path.js';
import type { NodeTable } from './join.js';
import { dice, normalizeName, tokenize } from './normalize.js';

export interface ProbeCandidate {
  backendNodeId: number;
  role: string;
  name: string;
  rect: Rect | null;
  disabled?: boolean;
  attrs?: Record<string, string>;
}

export interface ScoredMatch {
  ref: string;
  entry: IndexEntry;
  score: number;
}

const STABLE_ATTRS: StableAttr[] = [
  'id',
  'name',
  'type',
  'placeholder',
  'aria-label',
  'title',
  'alt',
  'href',
  'autocomplete',
  'data-testid',
  'data-test',
  'data-qa',
  'role',
];

const COMPATIBLE_ROLE_GROUPS: ReadonlyArray<ReadonlySet<string>> = [
  new Set(['textbox', 'searchbox', 'combobox']),
  new Set(['button', 'link', 'menuitem']),
  new Set(['checkbox', 'switch', 'menuitemcheckbox']),
  new Set(['radio', 'menuitemradio']),
  new Set(['listbox', 'combobox']),
];

function areRolesCompatible(a: string, b: string): boolean {
  return COMPATIBLE_ROLE_GROUPS.some((group) => group.has(a) && group.has(b));
}

function buildFramePath(observation: Observation, frameId: string): string[] {
  if (frameId === 'f0' || !frameId) return [];
  const frameMap = new Map(observation.frames.map((frame) => [frame.id, frame]));
  const chain: FrameInfo[] = [];
  let curr = frameMap.get(frameId);
  while (curr && curr.id !== 'f0') {
    chain.unshift(curr);
    curr = curr.parentId ? frameMap.get(curr.parentId) : undefined;
  }

  return chain.map((frame, index) => {
    if (frame.name) {
      return `iframe[name="${frame.name}"]`;
    }
    if (frame.url && frame.url !== 'about:blank') {
      try {
        const url = new URL(frame.url);
        return `iframe[src^="${url.origin}${url.pathname}"]`;
      } catch {
        // invalid URL fallback
      }
    }
    return `iframe:nth-of-type(${index + 1})`;
  });
}

/**
 * Builds durable ElementLocator per dom-intelligence §8.1.
 */
export function buildLocator(
  table: NodeTable,
  rowIdx: number,
  element: SemanticElement,
  observation: Observation,
): ElementLocator {
  const row = table.rows[rowIdx];
  const attrs: Partial<Record<StableAttr, string>> = {};

  if (row) {
    for (const key of STABLE_ATTRS) {
      let val = row.attrs[key];
      if (val !== undefined && val !== '') {
        if (key === 'id') {
          if (!isStableId(val)) continue;
        } else if (key === 'href') {
          val = val.split('?')[0] ?? '';
        }
        attrs[key] = val;
      }
    }
  }

  const nameN = normalizeName(element.name);
  const sameRoleName = observation.elements.filter(
    (el) => el.role === element.role && normalizeName(el.name) === nameN,
  );
  const ordinal = Math.max(
    0,
    sameRoleName.findIndex((el) => el.ref === element.ref),
  );

  return {
    v: 1,
    role: element.role,
    name: element.name,
    nameIsDynamic: false,
    tag: element.tag,
    attrs,
    context: element.context,
    cssPath: cssPath(table, rowIdx),
    framePath: buildFramePath(observation, element.frame),
    ordinal,
  };
}

/**
 * Replaces param values in element name with dynamic placeholder (dom-intelligence §8.1).
 */
export function applyParamsToLocator(locator: ElementLocator, paramValues: Record<string, string>): ElementLocator {
  const nameLower = locator.name.toLowerCase();
  for (const value of Object.values(paramValues)) {
    if (typeof value === 'string' && value.length >= 3 && nameLower.includes(value.toLowerCase())) {
      return {
        ...locator,
        nameIsDynamic: true,
        name: '',
      };
    }
  }
  return locator;
}

/**
 * Matches an ElementLocator against an observation per dom-intelligence §8.4.
 */
export function matchLocator(
  observation: Observation,
  index: ObservationIndex,
  locator: ElementLocator,
  actionType?: ActionType,
): ScoredMatch[] {
  const matches: ScoredMatch[] = [];

  for (const element of observation.elements) {
    const entry = index.entries.get(element.ref);
    if (!entry) continue;

    const candidateAttrs = entry.locator.attrs;
    let totalWeight = 0;
    let weightedSum = 0;

    // 1. Role (0.25)
    totalWeight += 0.25;
    let roleSignal = 0;
    if (element.role === locator.role) {
      roleSignal = 1.0;
    } else if (areRolesCompatible(element.role, locator.role)) {
      roleSignal = 0.6;
    }
    weightedSum += 0.25 * roleSignal;

    // 2. Name (0.30)
    if (!locator.nameIsDynamic) {
      totalWeight += 0.3;
      let nameSignal = 0;
      if (normalizeName(element.name) === normalizeName(locator.name)) {
        nameSignal = 1.0;
      } else {
        nameSignal = dice(tokenize(element.name), tokenize(locator.name));
      }
      weightedSum += 0.3 * nameSignal;
    }

    // 3. Strong attribute (0.25)
    const locatorStrong = locator.attrs['data-testid'] ?? locator.attrs['data-test'] ?? locator.attrs['data-qa'];
    if (locatorStrong) {
      totalWeight += 0.25;
      const candStrong = candidateAttrs['data-testid'] ?? candidateAttrs['data-test'] ?? candidateAttrs['data-qa'];
      const strongSignal = candStrong && candStrong === locatorStrong ? 1.0 : 0.0;
      weightedSum += 0.25 * strongSignal;
    }

    // 4. Stable id (0.15)
    if (locator.attrs.id) {
      totalWeight += 0.15;
      const idSignal = candidateAttrs.id === locator.attrs.id ? 1.0 : 0.0;
      weightedSum += 0.15 * idSignal;
    }

    // 5. Name attr (0.10)
    if (locator.attrs.name) {
      totalWeight += 0.1;
      const nameSignal = candidateAttrs.name === locator.attrs.name ? 1.0 : 0.0;
      weightedSum += 0.1 * nameSignal;
    }

    // 6. Placeholder (0.05)
    if (locator.attrs.placeholder) {
      totalWeight += 0.05;
      const candPlaceholder = candidateAttrs.placeholder ?? element.placeholder;
      const placeholderSignal = candPlaceholder === locator.attrs.placeholder ? 1.0 : 0.0;
      weightedSum += 0.05 * placeholderSignal;
    }

    // 7. Aria-label (0.05)
    if (locator.attrs['aria-label']) {
      totalWeight += 0.05;
      const ariaLabelSignal = candidateAttrs['aria-label'] === locator.attrs['aria-label'] ? 1.0 : 0.0;
      weightedSum += 0.05 * ariaLabelSignal;
    }

    // 8. Href (0.05)
    if (locator.attrs.href) {
      totalWeight += 0.05;
      const candHref = (candidateAttrs.href ?? element.href ?? '').split('?')[0];
      const locHref = locator.attrs.href.split('?')[0];
      const hrefSignal = candHref && candHref === locHref ? 1.0 : 0.0;
      weightedSum += 0.05 * hrefSignal;
    }

    // 9. Context overlap (0.10)
    if (locator.context.length > 0) {
      totalWeight += 0.1;
      const contextOverlap = element.context.some((c) => locator.context.includes(c));
      const contextSignal = contextOverlap ? 1.0 : 0.0;
      weightedSum += 0.1 * contextSignal;
    }

    // 10. cssPath (0.05)
    totalWeight += 0.05;
    const cssSignal = entry.locator.cssPath === locator.cssPath ? 1.0 : 0.0;
    weightedSum += 0.05 * cssSignal;

    // 11. Ordinal (0.02)
    totalWeight += 0.02;
    const ordinalSignal = entry.locator.ordinal === locator.ordinal ? 1.0 : 0.0;
    weightedSum += 0.02 * ordinalSignal;

    let score = totalWeight > 0 ? weightedSum / totalWeight : 0;

    // Hard rules
    if (roleSignal === 0) {
      score = Math.min(score, 0.5);
    }

    const frameMatch =
      entry.locator.framePath.length === locator.framePath.length &&
      entry.locator.framePath.every((frame, index) => frame === locator.framePath[index]);
    if (!frameMatch) {
      score = 0;
    }

    if ((actionType === 'click' || actionType === 'fill') && element.state.disabled) {
      score = Math.min(score, 0.5);
    }

    matches.push({ ref: element.ref, entry, score });
  }

  return matches.sort((a, b) => b.score - a.score);
}

/**
 * Verifies probe candidate identity per dom-intelligence §8.4.
 */
export function verifyIdentity(candidate: ProbeCandidate, locator: ElementLocator, actionType?: ActionType): number {
  let totalWeight = 0;
  let weightedSum = 0;

  // 1. Role (0.25)
  totalWeight += 0.25;
  let roleSignal = 0;
  if (candidate.role === locator.role) {
    roleSignal = 1.0;
  } else if (areRolesCompatible(candidate.role, locator.role)) {
    roleSignal = 0.6;
  }
  weightedSum += 0.25 * roleSignal;

  // 2. Name (0.30)
  if (!locator.nameIsDynamic) {
    totalWeight += 0.3;
    let nameSignal = 0;
    if (normalizeName(candidate.name) === normalizeName(locator.name)) {
      nameSignal = 1.0;
    } else {
      nameSignal = dice(tokenize(candidate.name), tokenize(locator.name));
    }
    weightedSum += 0.3 * nameSignal;
  }

  const candidateAttrs = candidate.attrs ?? {};

  // 3. Strong attribute (0.25)
  const locatorStrong = locator.attrs['data-testid'] ?? locator.attrs['data-test'] ?? locator.attrs['data-qa'];
  if (locatorStrong) {
    totalWeight += 0.25;
    const candStrong = candidateAttrs['data-testid'] ?? candidateAttrs['data-test'] ?? candidateAttrs['data-qa'];
    const strongSignal = candStrong && candStrong === locatorStrong ? 1.0 : 0.0;
    weightedSum += 0.25 * strongSignal;
  }

  // 4. Stable id (0.15)
  if (locator.attrs.id) {
    totalWeight += 0.15;
    const idSignal = candidateAttrs.id === locator.attrs.id ? 1.0 : 0.0;
    weightedSum += 0.15 * idSignal;
  }

  // 5. Name attr (0.10)
  if (locator.attrs.name) {
    totalWeight += 0.1;
    const nameSignal = candidateAttrs.name === locator.attrs.name ? 1.0 : 0.0;
    weightedSum += 0.1 * nameSignal;
  }

  // 6. Placeholder (0.05)
  if (locator.attrs.placeholder) {
    totalWeight += 0.05;
    const placeholderSignal = candidateAttrs.placeholder === locator.attrs.placeholder ? 1.0 : 0.0;
    weightedSum += 0.05 * placeholderSignal;
  }

  // 7. Aria-label (0.05)
  if (locator.attrs['aria-label']) {
    totalWeight += 0.05;
    const ariaLabelSignal = candidateAttrs['aria-label'] === locator.attrs['aria-label'] ? 1.0 : 0.0;
    weightedSum += 0.05 * ariaLabelSignal;
  }

  // 8. Href (0.05)
  if (locator.attrs.href) {
    totalWeight += 0.05;
    const candHref = (candidateAttrs.href ?? '').split('?')[0];
    const locHref = locator.attrs.href.split('?')[0];
    const hrefSignal = candHref && candHref === locHref ? 1.0 : 0.0;
    weightedSum += 0.05 * hrefSignal;
  }

  let score = totalWeight > 0 ? weightedSum / totalWeight : 0;

  if (roleSignal === 0) {
    score = Math.min(score, 0.5);
  }

  if ((actionType === 'click' || actionType === 'fill') && candidate.disabled) {
    score = Math.min(score, 0.5);
  }

  return score;
}

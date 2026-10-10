import type { IndexEntry, Observation, ObservationIndex, Target } from '@browser-os/protocol';
import { BosError } from '../errors.js';
import { buildResolution, type Resolution } from './types.js';

export type QueryTarget = Extract<Target, { kind: 'query' }>;

export interface QueryCandidate {
  ref: string;
  entry: IndexEntry;
  /** 1 for an exact criterion, 0.9 for a contains match; averaged over the criteria given. */
  score: number;
}

function textOf(entry: IndexEntry): string {
  const el = entry.locator;
  return `${el.name} ${el.role} ${el.cssPath} ${Object.values(el.attrs ?? {}).join(' ')}`.toLowerCase();
}

/**
 * The deterministic query tier (action-router §5 case `query`, `structuredFilter`).
 *
 * Every criterion present is ANDed. `name` accepts exact first, then contains;
 * `css` matches the index css path (a live `querySelectorAll` needs the page
 * and belongs to the probe executor, not to this pure tier).
 */
export function structuredFilter(
  observation: Observation,
  index: ObservationIndex,
  query: QueryTarget,
): QueryCandidate[] {
  const out: QueryCandidate[] = [];

  for (const element of observation.elements) {
    const entry = index.entries.get(element.ref);
    if (!entry) continue;
    const role = element.role;
    const name = element.name;
    let points = 0;
    let criteria = 0;

    if (query.role !== undefined) {
      criteria += 1;
      if (role === query.role) points += 1;
      else continue;
    }
    if (query.name !== undefined) {
      criteria += 1;
      const exact = name.toLowerCase() === query.name.toLowerCase();
      if (exact) points += 1;
      else if (name.toLowerCase().includes(query.name.toLowerCase())) points += 0.9;
      else continue;
    }
    if (query.text !== undefined) {
      criteria += 1;
      const needle = query.text.toLowerCase();
      const haystack = `${name} ${textOf(entry)}`;
      if (haystack.includes(needle)) points += 1;
      else continue;
    }
    if (query.css !== undefined) {
      criteria += 1;
      const path = entry.locator.cssPath;
      if (path === query.css || path.endsWith(query.css)) points += 1;
      else continue;
    }

    if (criteria === 0) points = 1;
    out.push({ ref: element.ref, entry, score: points / (criteria || 1) });
  }

  return out.sort((a, b) => b.score - a.score);
}

export function resolveQuery(observation: Observation, index: ObservationIndex, query: QueryTarget): Resolution {
  const matches = structuredFilter(observation, index, query);
  const brief = matches.slice(0, 5).map((m) => ({ ref: m.ref, score: m.score }));

  if (query.nth !== undefined) {
    const picked = matches[query.nth];
    if (!picked) {
      throw new BosError('TARGET_NOT_FOUND', 'No element matches this query at that position', {
        details: { nth: query.nth, matches: matches.length, candidates: brief },
      });
    }
    return buildResolution('deterministic', observation, picked.ref, picked.entry);
  }

  const [first, ...rest] = matches;
  if (!first) {
    throw new BosError('TARGET_NOT_FOUND', 'No element matches this query', {
      details: { query: { role: query.role, name: query.name, text: query.text, css: query.css } },
    });
  }
  if (rest.length > 0) {
    throw new BosError('TARGET_AMBIGUOUS', 'More than one element matches this query; use `nth`', {
      details: { matches: matches.length, candidates: brief },
    });
  }

  return buildResolution('deterministic', observation, first.ref, first.entry);
}

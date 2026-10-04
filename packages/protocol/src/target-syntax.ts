// CLI/SDK target syntax (specs/protocol.md §5).
//
// Shared by `bos` and the SDK so both interpret `<target>` identically. Three
// shapes, in this order:
//   `@e12`                          -> ref   (needs the caller's current observation)
//   `role=button name="Sign in"`    -> query (structured, deterministic tier)
//   anything else                   -> intent (natural language, may reach the model)
//
// The catch-all is deliberate: a caller who types prose gets the intent path, and
// an unparseable `key=value` string falls back to it rather than being rejected.
// The one exception is an empty string, which is a caller bug and fails loudly.

import type { Target } from './actions.js';
import { BosError } from './errors.js';

const REF_RE = /^@(e\d+)$/;

const QUERY_VALUE_KEYS = ['role', 'name', 'text', 'css'] as const;
type QueryValueKey = (typeof QUERY_VALUE_KEYS)[number];

/** Keys are lowercase words; anything else is prose that happens to contain '='. */
const KEY_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Strips one pair of surrounding double quotes. Returns null when the value is
 * quoted on only one side: the caller's quoting was malformed, so the whole string
 * is better treated as prose than half-parsed.
 */
function unquote(raw: string): string | null {
  if (!raw.includes('"')) return raw;
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  return null;
}

/**
 * Splits on whitespace, except inside double quotes, and keeps the quotes so the
 * pair pattern can tell `name=Sign in` (two tokens, not a query) from
 * `name="Sign in"` (one). Returns null for an unterminated quote.
 */
function tokenize(input: string): string[] | null {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
      continue;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  if (inQuotes) return null;
  // The caller trims first, so the tail token is always the last thing seen —
  // pushing it unconditionally keeps this function free of an unreachable branch.
  tokens.push(current);
  return tokens;
}

function parseQuery(input: string): Target | null {
  const tokens = tokenize(input);
  if (tokens === null) return null;

  const query: { role?: string; name?: string; text?: string; css?: string; nth?: number } = {};

  for (const token of tokens) {
    const separator = token.indexOf('=');
    if (separator <= 0) return null;

    const key = token.slice(0, separator);
    if (!KEY_RE.test(key)) return null;

    const value = unquote(token.slice(separator + 1));
    if (value === null) return null;

    if (key === 'nth') {
      if (value.length === 0) return null;
      const nth = Number(value);
      if (!Number.isInteger(nth) || nth < 0) return null;
      query.nth = nth;
      continue;
    }

    if ((QUERY_VALUE_KEYS as readonly string[]).includes(key)) {
      if (value.length === 0) return null;
      query[key as QueryValueKey] = value;
      continue;
    }

    // Unknown key: this is prose that happens to contain an '=', not a query.
    return null;
  }

  return { kind: 'query', ...query };
}

/**
 * Parses a CLI/SDK target string. `lastObservationId` comes from the caller's
 * cli-state; a `ref` target is meaningless without it.
 */
export function parseTargetString(input: string, lastObservationId: string | null): Target {
  const raw = input.trim();

  if (raw.length === 0) {
    throw new BosError('INVALID_REQUEST', 'empty target string');
  }

  const refMatch = REF_RE.exec(raw);
  if (refMatch !== null && refMatch[1] !== undefined) {
    if (lastObservationId === null) {
      throw new BosError('INVALID_REQUEST', 'a ref target needs a current observation — run `bos observe` first', {
        details: { target: raw },
      });
    }
    return { kind: 'ref', ref: refMatch[1], observationId: lastObservationId };
  }

  const query = parseQuery(raw);
  if (query !== null) return query;

  return { kind: 'intent', text: unwrapQuotes(raw) };
}

/**
 * A caller who quotes a whole intent (`"the search box"`) is grouping words, the
 * way a shell does: the quotes are syntax, not part of the target text.
 */
function unwrapQuotes(input: string): string {
  if (input.length >= 2 && input.startsWith('"') && input.endsWith('"')) return input.slice(1, -1);
  return input;
}

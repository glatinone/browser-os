import { createHash } from 'node:crypto';

const HEX_RUN = /[0-9a-f]{8,}/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const ARTICLES = /\b(a|an|the)\b/g;

/**
 * Collapse a URL to its cache path template (memory §4.1):
 * pathname only, lowercased, trailing slash stripped, volatile segments
 * replaced with '*', at most 6 segments then '/**'.
 */
export function pathTemplate(url: string, paramValues: Record<string, string> = {}): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Already a path, or scheme-less input: strip query/hash by hand.
    pathname = url.split(/[?#]/, 1)[0] ?? '';
  }
  pathname = pathname.toLowerCase().replace(/\/+$/, '');
  if (pathname === '') pathname = '/';

  const paramSet = new Set(Object.values(paramValues).map((v) => decodeURIComponent(v).toLowerCase()));

  const segments = pathname
    .split('/')
    .slice(1)
    .map((raw) => {
      const decoded = safeDecode(raw).toLowerCase();
      if (decoded === '') return '';
      if (paramSet.has(decoded)) return '*';
      if (/^\d+$/.test(decoded)) return '*';
      if (UUID_RE.test(decoded)) return '*';
      if (HEX_RUN.test(decoded)) return '*';
      if (decoded.length >= 6 && /[a-z]/.test(decoded) && /\d/.test(decoded)) return '*';
      return decoded;
    });

  const truncated = segments.length > 6;
  const kept = truncated ? segments.slice(0, 6) : segments;
  const path = `/${kept.join('/')}`.replace(/\/{2,}/g, '/');
  if (path.length > 1) return truncated ? `${path}/**` : path;
  return truncated ? '/**' : '/';
}

/**
 * Normalize an intent (memory §4.2): lowercase → param values become
 * "{name}" → strip punctuation except {} → drop articles → collapse → trim.
 */
export function normalizeIntent(text: string, paramValues: Record<string, string> = {}): string {
  let out = text.toLowerCase();
  for (const [name, value] of Object.entries(paramValues)) {
    const v = value.trim();
    if (!v) continue;
    out = out.split(v.toLowerCase()).join(`{${name}}`);
  }
  out = out.replace(/[^\w\s{}]/g, ' ');
  out = out.replace(ARTICLES, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Action-cache key (memory §4.2): sha256 over origin/path/actionType/intent.
 */
export function cacheKey(opts: { origin: string; pathTemplate: string; actionType: string; intent: string }): string {
  const payload = `${opts.origin}\n${opts.pathTemplate}\n${opts.actionType}\n${opts.intent}`;
  return sha256(payload);
}

/**
 * Site-wide fallback key: the path template slot is always '*'.
 */
export function siteKey(opts: { origin: string; actionType: string; intent: string }): string {
  const payload = `${opts.origin}\n*\n${opts.actionType}\n${opts.intent}`;
  return sha256(payload);
}

/**
 * Template match (memory §4.2 lookup): exact equality, or a '/**'
 * suffix matches any URL sharing that prefix.
 */
export function urlMatches(template: string, actual: string): boolean {
  if (template === actual) return true;
  if (template.endsWith('/**')) {
    const prefix = template.slice(0, -3);
    return actual === prefix || actual.startsWith(`${prefix}/`);
  }
  return false;
}

function sha256(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

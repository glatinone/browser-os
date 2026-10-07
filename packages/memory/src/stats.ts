import type { Tier, TierAttempt } from '@browser-os/protocol';
import type { SqliteDatabase } from './migrate.js';

/** Canonical display order for the tier ladder (action-router §8). */
export const TIERS: readonly Tier[] = ['ref', 'cache', 'deterministic', 'llm', 'vision', 'human'];

export interface StatsOptions {
  /** epoch **milliseconds**; only rows at or after this instant count. */
  since: number;
  origin?: string;
  taskKey?: string;
}

export interface TierStats {
  tier: Tier;
  count: number;
  /** Share of *resolved* actions (rows with a non-null tier) that landed here. */
  pct: number;
  p50: number;
  p95: number;
}

export interface Stats {
  total: number;
  ok: number;
  successRate: number;
  /** One entry per tier, always all six, so the shape is stable. */
  tiers: TierStats[];
  cache: {
    /** Actions whose intent had a cache entry (the cache tier was consulted). */
    entries: number;
    hits: number;
    hitRate: number;
    falseHits: number;
    falseHitRate: number;
  };
  llm: { callsPerAction: number; inputTokensPerAction: number; outputTokensPerAction: number };
  /** Share of actions that needed more than one tier to resolve. */
  escalationRate: number;
}

interface RunRow {
  tier: Tier | null;
  ok: number;
  error_code: string | null;
  llm_calls: number;
  input_tokens: number;
  output_tokens: number;
  attempts_json: string;
}

/**
 * Tier metrics over `action_runs` (memory §3, action-router §8).
 *
 * Percentiles are computed in JS over the selected rows, so the query only
 * carries the columns the metrics need. Rates are raw floats in 0..1 and
 * `pct` is a raw share in 0..100; callers format them.
 */
export function stats(db: SqliteDatabase, opts: StatsOptions): Stats {
  const sinceSec = Math.floor(opts.since / 1000);
  const rows = db
    .prepare(
      `SELECT r.tier, r.ok, r.error_code, r.llm_calls, r.input_tokens, r.output_tokens, r.attempts_json
       FROM action_runs r
       LEFT JOIN tasks t ON t.id = r.task_id
       WHERE r.ts >= ?
         AND (? IS NULL OR r.origin = ?)
         AND (? IS NULL OR t.key = ?)`,
    )
    .all(sinceSec, opts.origin ?? null, opts.origin ?? null, opts.taskKey ?? null, opts.taskKey ?? null) as RunRow[];

  const parsed = rows.map((row) => ({
    ...row,
    attempts: JSON.parse(row.attempts_json) as TierAttempt[],
  }));

  const total = parsed.length;
  const okCount = parsed.filter((row) => row.ok === 1).length;
  const resolved = parsed.filter((row) => row.tier !== null).length;

  // Tier distribution + per-tier latency, from attempts[].ms.
  const tiers: TierStats[] = TIERS.map((tier) => {
    const count = parsed.filter((row) => row.tier === tier).length;
    const samples: number[] = [];
    for (const row of parsed) {
      for (const attempt of row.attempts) {
        if (attempt.tier === tier) samples.push(attempt.ms);
      }
    }
    return {
      tier,
      count,
      pct: resolved > 0 ? count / resolved : 0,
      p50: percentile(samples, 0.5),
      p95: percentile(samples, 0.95),
    };
  });

  // Cache tier: an action "had a cache entry" when the cache tier appears in
  // its attempts; a hit is an action the cache tier actually resolved.
  const withCacheEntry = parsed.filter((row) => row.attempts.some((attempt) => attempt.tier === 'cache'));
  const cacheHits = parsed.filter((row) => row.tier === 'cache' && row.ok === 1);
  const cacheResolutions = parsed.filter((row) =>
    row.attempts.some((attempt) => attempt.tier === 'cache' && attempt.ok),
  );
  const falseHits = cacheResolutions.filter((row) => {
    const failedVerification = row.ok === 0 && row.error_code === 'VERIFICATION_FAILED';
    const humanCorrection = row.attempts.some((attempt) => attempt.tier === 'human' && attempt.ok);
    return failedVerification || humanCorrection;
  });

  const llmCalls = parsed.reduce((sum, row) => sum + row.llm_calls, 0);
  const inputTokens = parsed.reduce((sum, row) => sum + row.input_tokens, 0);
  const outputTokens = parsed.reduce((sum, row) => sum + row.output_tokens, 0);

  const escalated = parsed.filter((row) => new Set(row.attempts.map((attempt) => attempt.tier)).size > 1);

  return {
    total,
    ok: okCount,
    successRate: total > 0 ? okCount / total : 0,
    tiers,
    cache: {
      entries: withCacheEntry.length,
      hits: cacheHits.length,
      hitRate: withCacheEntry.length > 0 ? cacheHits.length / withCacheEntry.length : 0,
      falseHits: falseHits.length,
      falseHitRate: cacheResolutions.length > 0 ? falseHits.length / cacheResolutions.length : 0,
    },
    llm: {
      callsPerAction: total > 0 ? llmCalls / total : 0,
      inputTokensPerAction: total > 0 ? inputTokens / total : 0,
      outputTokensPerAction: total > 0 ? outputTokens / total : 0,
    },
    escalationRate: total > 0 ? escalated.length / total : 0,
  };
}

/**
 * Nearest-rank percentile: with `n` sorted samples the p-quantile is the value
 * at index `ceil(p*n)-1`. An empty series yields 0 rather than NaN.
 */
function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[index] ?? 0;
}

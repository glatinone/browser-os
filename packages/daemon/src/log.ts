// P8-01 — request logger with masking (protocol §3; SECURITY.md S5/S7).
//
// The hard rule from the card: log *method, duration, ok/error code* — and
// NEVER params. The guarantee here is structural, not procedural: the logger's
// input type cannot carry params or `secretValues` at all, so a caller has no
// way to pass them in. A debug-level line adds no new field either — it only
// adds the JSON-RPC error code of a failed call. A canary test asserts no
// secret value can appear in the output because none can reach the formatter.

import type { Clock } from '@browser-os/protocol';
import { systemClock } from '@browser-os/protocol';

/** What one logged request line may ever contain — the complete field list. */
export interface RequestLogEntry {
  method: string;
  durationMs: number;
  ok: boolean;
  /** JSON-RPC error code; present only when `ok` is false. */
  errorCode?: number;
}

export type RequestLogLevel = 'silent' | 'info' | 'debug';

export interface RequestLoggerOptions {
  /** Where the formatted line goes. Tests inject an array; the daemon injects a file stream (P8-03). */
  sink: (line: string) => void;
  level?: RequestLogLevel;
  clock?: Clock;
}

export interface RequestLogger {
  logRequest(entry: RequestLogEntry): void;
  /** Captured level, so tests can assert what the sink would ever have seen. */
  readonly level: RequestLogLevel;
}

export function createRequestLogger(options: RequestLoggerOptions): RequestLogger {
  const level = options.level ?? 'info';
  const sink = options.sink;
  const clock = options.clock ?? systemClock;
  return {
    level,
    logRequest(entry: RequestLogEntry): void {
      if (level === 'silent') return;
      const status = entry.ok ? 'ok' : `error code=${entry.errorCode ?? 'unknown'}`;
      const line = `${clock.now()} rpc ${entry.method} ${status} ${entry.durationMs}ms`;
      sink(line);
    },
  };
}

/**
 * Guard used by tests and (later) the daemon: true when a string carries none
 * of the given secret values. Kept here so the canary helper lives next to the
 * only logger that could ever print one.
 */
export function containsNone(haystack: string, secrets: readonly string[]): boolean {
  return secrets.every((secret) => !haystack.includes(secret));
}

// The single error type for the whole runtime (data-models §2).
//
// `ErrorCode` is derived from the `ERROR_CODES` array so the union and the
// runtime list cannot drift: a new code is added in exactly one place, and tests
// can enumerate every code (for example to check the retryable defaults).

/**
 * Every code the runtime can raise (data-models §2). The union type is derived
 * from this array, so the type and the runtime list cannot drift and tests can
 * enumerate every code.
 */
export const ERROR_CODES = [
  // browser / session
  'BROWSER_NOT_FOUND', // channel executable not installed
  'BROWSER_LAUNCH_FAILED',
  'BROWSER_DISCONNECTED',
  'PROFILE_NOT_FOUND',
  'PROFILE_LOCKED', // another process owns the user-data-dir
  'SESSION_NOT_FOUND',
  'PAGE_NOT_FOUND',
  'NAVIGATION_FAILED',
  'TIMEOUT',
  // target resolution / execution
  'STALE_REF', // ref belongs to an older observation
  'TARGET_NOT_FOUND',
  'TARGET_AMBIGUOUS',
  'TARGET_NOT_INTERACTABLE', // hidden, disabled, zero-size
  'TARGET_OBSCURED', // hit-test landed on another element
  'ACTION_FAILED',
  'VERIFICATION_FAILED',
  // AI
  'LLM_DISABLED',
  'LLM_UNAVAILABLE',
  'LLM_INVALID_OUTPUT',
  'BUDGET_EXCEEDED',
  // security / human
  'PERMISSION_DENIED',
  'CONFIRMATION_REQUIRED',
  'HUMAN_REQUIRED',
  'SECURITY_CHALLENGE', // login wall, CAPTCHA, MFA detected
  // memory
  'TRAJECTORY_NOT_FOUND',
  'TRAJECTORY_STEP_FAILED',
  // protocol
  'INVALID_PROFILE_ID',
  'INVALID_REQUEST',
  'UNAUTHORIZED',
  'CANCELLED',
  'INTERNAL',
  'PROFILE_DIR_CREATE_FAILED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes whose default `retryable` is true: the action provably did nothing, or
 * the failure is transient. Everything else defaults to false — notably
 * ACTION_FAILED with effect 'unknown', which must never be retried blindly
 * (action-router §4.1).
 */
export const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set([
  'STALE_REF',
  'TARGET_OBSCURED',
  'TIMEOUT',
  'BROWSER_DISCONNECTED',
  'LLM_UNAVAILABLE',
]);

export interface BosErrorOptions {
  details?: Record<string, unknown>;
  retryable?: boolean;
  cause?: unknown;
}

export interface BosErrorJson {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
  retryable: boolean;
}

export class BosError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: BosErrorOptions = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'BosError';
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    if (opts.details !== undefined) this.details = opts.details;
  }

  toJSON(): BosErrorJson {
    const json: BosErrorJson = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details !== undefined) json.details = this.details;
    return json;
  }
}

/**
 * Structural check rather than `instanceof`, so it also recognises errors that
 * crossed a realm boundary (worker thread, vm context, another copy of the
 * package) where `instanceof` is unreliable.
 */
export function isBosError(e: unknown): e is BosError {
  if (e === null || typeof e !== 'object') return false;
  const candidate = e as { name?: unknown; code?: unknown };
  return candidate.name === 'BosError' && typeof candidate.code === 'string';
}

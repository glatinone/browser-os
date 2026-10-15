// P7-06 — trajectory replayer with healing (memory §6.2–6.3, action-router §5.4,
// SECURITY.md S9 / §6.1, integration §8).
//
// The replay algorithm of memory §6.2, step for step:
//   1. pre-flight: every `trajectory.params` entry present in the task params and
//      every `secretNames` entry resolvable — otherwise `INVALID_REQUEST` before
//      a single action runs (an unfed trajectory never touches the page).
//   2. per step: substitute `{{param}}` placeholders in URLs, check the `pre.urlPattern`
//      precondition (poll `pathTemplate(currentUrl)` every `probeIntervalMs` up to
//      `probeTimeoutMs` — SPA route changes get their grace window), then hand the
//      step to `router.execute(action, ctx, { healIntent })`.
//   3. heal detection: a step whose target was a recorded locator but which the
//      router resolved at a tier other than `cache` was repaired by the ladder
//      (deterministic/LLM/human). Its fresh locator goes into `healed`.
//   4. outcome bookkeeping goes to `TrajectoryStore.recordRun` exactly once per
//      replay (memory §6.2): success resets the streak and folds healed locators
//      into a new version; failure pushes the trajectory to `suspect`/`invalid`.
//
// S9 (SECURITY.md): every step is re-executed through the router, which always
// runs its own live risk classification. The recorded `step.risk` is only ever
// handed along as `ExecuteOptions.recordedRisk` — the option whose contract is
// `max(live, recorded)` — so a trajectory can never lower the live risk of an
// action, only raise it.
//
// SECURITY.md §6.1 / integration §8: a step that fails on a security challenge
// (`SECURITY_CHALLENGE`, or `HUMAN_REQUIRED` whose `details.reason` is a
// `ChallengeKind`) or on `PERMISSION_DENIED` fails the task but is NOT a
// trajectory failure: `recordRun` is not called, so a human login wall or a
// denied permission never burns the trajectory toward `invalid`.

import type { HealedStep, RunOutcome } from '@browser-os/memory';
import { pathTemplate, urlMatches } from '@browser-os/memory';
import type {
  ActionResult,
  BrowserAction,
  ChallengeKind,
  ExecutionContext,
  Trajectory,
  TrajectoryStep,
} from '@browser-os/protocol';
import { BosError } from '@browser-os/protocol';
import { DEFAULT_ROUTER_CONSTANTS } from '../router/constants.js';
import type { ExecuteOptions } from '../router/types.js';

/** The router surface the replayer needs (`ActionRouter` satisfies it). */
export interface ReplayRouterPort {
  execute(action: BrowserAction, ctx: ExecutionContext, opts?: ExecuteOptions): Promise<ActionResult>;
}

/** The store surface the replayer needs (`TrajectoryStore` satisfies it). */
export interface ReplayTrajectoryStorePort {
  recordRun(id: string, outcome: RunOutcome): unknown;
}

/** Minimal event surface for the `trajectory.healed` events of memory §6.2. */
export interface ReplayEventsPort {
  emit(event: {
    ts: number;
    type: 'trajectory.healed';
    data: { trajectoryId: string; step: number; newVersion: number };
  }): void;
}

export interface TrajectoryReplayerOptions {
  router: ReplayRouterPort;
  trajectories: ReplayTrajectoryStorePort;
  /** Current page URL, polled by the precondition wait (SPA routes move). */
  currentUrl: () => string | Promise<string>;
  /** Where `trajectory.healed` events go (memory §6.2); absent → no events. */
  events?: ReplayEventsPort | null;
  /** Precondition poll budget; defaults to the router's own probe constants. */
  probeTimeoutMs?: number;
  probeIntervalMs?: number;
  /** Injectable sleep so tests never wait in real time. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ReplayTaskInput {
  /** The trajectory row to replay (live or re-imported). */
  trajectory: Trajectory;
  /** Non-secret task params; must cover every `trajectory.params` name. */
  params: Record<string, string>;
}

export interface ReplaySuccess {
  ok: true;
  /** Locators the ladder repaired; `recordRun` folds them into a new version. */
  healed: HealedStep[];
  /** Every step's ActionResult, in order (tiers, latencies, LLM usage). */
  results: ActionResult[];
  /** The trajectory row as `recordRun` returned it (version/status after the run). */
  trajectory: unknown;
}

export interface ReplayFailure {
  ok: false;
  error: { code: string; message: string; details?: Record<string, unknown> };
  /** Index of the step that failed; absent for the pre-flight failure. */
  step?: number;
  healed: HealedStep[];
  results: ActionResult[];
  /** False when the failure must not count against the trajectory (§6.1). */
  recorded: boolean;
  trajectory?: unknown;
}

export type ReplayResult = ReplaySuccess | ReplayFailure;

const CHALLENGE_KINDS: ReadonlySet<string> = new Set<string>([
  'login',
  'captcha',
  'mfa',
  'passkey',
  'consent',
  'unknown',
]);

/**
 * integration §8 replayer rule: challenge-shaped failures and permission denials
 * fail the task without counting as trajectory failures.
 */
export function isNonTrajectoryFailure(
  error: { code: string; details?: Record<string, unknown> } | undefined,
): boolean {
  if (!error) return false;
  if (error.code === 'SECURITY_CHALLENGE' || error.code === 'PERMISSION_DENIED') return true;
  if (error.code === 'HUMAN_REQUIRED') {
    return CHALLENGE_KINDS.has(String((error.details as { reason?: unknown } | undefined)?.reason));
  }
  return false;
}

function hasLocatorTarget(action: BrowserAction): boolean {
  const target = 'target' in action ? (action.target as { kind?: string } | undefined) : undefined;
  return target?.kind === 'locator';
}

/** `{{name}}` → task param value, in the navigate URL and in recorded URL strings. */
export function substituteParams(action: BrowserAction, params: Record<string, string>): BrowserAction {
  const expand = (value: string): string => {
    let out = value;
    for (const [name, paramValue] of Object.entries(params)) {
      out = out.split(`{{${name}}}`).join(paramValue);
    }
    return out;
  };
  if (action.type === 'navigate') return { type: 'navigate', url: expand(action.url) };
  return action;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The replayer of memory §6.2. One instance replays many trajectories against
 * the same wired router/store; it holds no per-replay state.
 */
export class TrajectoryReplayer {
  private readonly router: ReplayRouterPort;
  private readonly trajectories: ReplayTrajectoryStorePort;
  private readonly currentUrl: () => string | Promise<string>;
  private readonly events: ReplayEventsPort | null;
  private readonly probeTimeoutMs: number;
  private readonly probeIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: TrajectoryReplayerOptions) {
    this.router = options.router;
    this.trajectories = options.trajectories;
    this.currentUrl = options.currentUrl;
    this.events = options.events ?? null;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_ROUTER_CONSTANTS.probeTimeoutMs;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_ROUTER_CONSTANTS.probeIntervalMs;
    this.sleep = options.sleep ?? realSleep;
  }

  async replay(input: ReplayTaskInput, ctx: ExecutionContext): Promise<ReplayResult> {
    const { trajectory } = input;
    const params = input.params;

    // 1. Pre-flight (memory §6.2 line 1): nothing executes on an unfed task.
    const missing = trajectory.params.filter((name) => !(name in params));
    if (missing.length > 0) {
      return this.failed({ code: 'INVALID_REQUEST', message: `missing task params: ${missing.join(', ')}` }, undefined);
    }
    for (const name of trajectory.secretNames) {
      try {
        await ctx.secrets.resolve(name);
      } catch (error) {
        // Name only, never a value (SECURITY.md §10 discipline).
        const message = error instanceof Error ? error.message : String(error);
        return this.failed({
          code: 'INVALID_REQUEST',
          message: `secret "${name}" is not resolvable: ${message}`,
        });
      }
    }

    const results: ActionResult[] = [];
    const healed: HealedStep[] = [];
    let currentUrl = await this.currentUrl();

    for (const step of trajectory.steps) {
      if (ctx.signal.aborted) {
        throw new BosError('CANCELLED', 'Replay cancelled');
      }

      // 2a. URL precondition: the recorder ran this step at `pre.urlPattern`.
      // A mismatch may just be an SPA that has not finished routing — poll
      // within the probe budget before declaring the flow broken.
      const pattern = step.pre?.urlPattern ?? '';
      if (pattern !== '' && !urlMatches(pattern, pathTemplate(currentUrl, params))) {
        const deadline = ctx.clock.now() + this.probeTimeoutMs;
        while (!urlMatches(pattern, pathTemplate(currentUrl, params)) && ctx.clock.now() < deadline) {
          await this.sleep(this.probeIntervalMs);
          currentUrl = await this.currentUrl();
        }
        if (!urlMatches(pattern, pathTemplate(currentUrl, params))) {
          return this.failStep(trajectory, step, results, healed, {
            reason: 'precondition',
            expected: pattern,
            actual: pathTemplate(currentUrl, params),
          });
        }
      }

      // 2b. Execute through the router (§5.4 healing). S9: the live ladder and
      // risk classifier always run; `recordedRisk` can only ever raise the risk.
      const action = substituteParams(step.action, params);
      const result = await this.runStep(action, ctx, step);
      results.push(result);

      if (!result.ok) {
        const error = result.error ?? { code: 'ACTION_FAILED', message: 'step failed without an error code' };
        if (isNonTrajectoryFailure(error)) {
          // §6.1: challenge / permission failures fail the task but never
          // push the trajectory toward `invalid`.
          const failure = this.failed(error, step.index);
          failure.healed = healed;
          failure.results = results;
          return failure;
        }
        return this.failStep(trajectory, step, results, healed, { cause: error }, error);
      }

      // 2c. Heal detection (memory §6.2): locator step resolved off the cache
      // tier ⇒ the ladder repaired it; remember the fresh locator.
      if (result.tier !== 'cache' && hasLocatorTarget(step.action) && result.locator) {
        healed.push({ index: step.index, locator: result.locator });
      }

      currentUrl = result.url || currentUrl;
    }

    // 3. Success bookkeeping: counters, streak reset, healed locators → v++.
    const stored = this.trajectories.recordRun(trajectory.id, { success: true, healed });
    const newVersion =
      (stored as { version?: number } | null)?.version ?? trajectory.version + (healed.length > 0 ? 1 : 0);
    if (this.events && healed.length > 0) {
      for (const fix of healed) {
        this.events.emit({
          ts: ctx.clock.now(),
          type: 'trajectory.healed',
          data: { trajectoryId: trajectory.id, step: fix.index, newVersion: newVersion ?? trajectory.version },
        });
      }
    }
    return { ok: true, healed, results, trajectory: stored };
  }

  /** One `execute` call; a thrown BosError reads back as a failed result. */
  private async runStep(action: BrowserAction, ctx: ExecutionContext, step: TrajectoryStep): Promise<ActionResult> {
    try {
      return await this.router.execute(action, ctx, {
        healIntent: step.intent,
        recordedRisk: step.risk,
      });
    } catch (error) {
      if (error instanceof BosError && error.code === 'CANCELLED') throw error;
      const code = error instanceof BosError ? error.code : 'ACTION_FAILED';
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof BosError ? (error.details as Record<string, unknown> | undefined) : undefined;
      return {
        ok: false,
        action,
        tier: null,
        driver: null,
        attempts: [],
        url: '',
        pageChanged: false,
        ms: 0,
        llm: { calls: 0, inputTokens: 0, outputTokens: 0 },
        risk: null,
        error: { code, message, ...(details ? { details } : {}) },
      };
    }
  }

  /** A genuine step failure: `recordRun(false)` runs (suspect/invalid ladder). */
  private failStep(
    trajectory: Trajectory,
    step: TrajectoryStep,
    results: ActionResult[],
    healed: HealedStep[],
    details: Record<string, unknown>,
    cause?: { code: string; message: string },
  ): ReplayFailure {
    const stored = this.trajectories.recordRun(trajectory.id, { success: false });
    const failure = this.failed(
      {
        code: 'TRAJECTORY_STEP_FAILED',
        message: cause ? `step ${step.index} failed: ${cause.message}` : `step ${step.index} failed`,
        details: { step: step.index, ...details },
      },
      step.index,
    );
    failure.healed = healed;
    failure.results = results;
    failure.recorded = true; // recordRun(false) ran: this failure counts (memory §6.2)
    failure.trajectory = stored;
    return failure;
  }

  private failed(
    error: { code: string; message: string; details?: Record<string, unknown> },
    step?: number,
  ): ReplayFailure {
    return { ok: false, error, ...(step === undefined ? {} : { step }), healed: [], results: [], recorded: false };
  }
}

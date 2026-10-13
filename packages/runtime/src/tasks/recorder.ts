import type { CreateRecordedInput } from '@browser-os/memory';
import { pathTemplate } from '@browser-os/memory';
import type {
  ActionResult,
  BrowserAction,
  ElementLocator,
  ExecutionContext,
  RiskLevel,
  Target,
  TrajectoryStep,
  ValueSource,
} from '@browser-os/protocol';
import { fieldsOf, hasTarget, isSensitiveField, MASKED_VALUE } from '@browser-os/protocol';
import type { TrajectoryRecorderPort } from '../router/types.js';

/**
 * P7-05 Trajectory recorder (memory §6.1, action-router §3.1, SECURITY.md S13).
 *
 * A recording scope is opened by `start()` and closed by `finalize(success)`.
 * Every successful action the router executes inside a task is handed to
 * `append()`, which turns the `ActionResult` into the `TrajectoryStep` of the
 * memory §6.1 table: locator target, param/secret value references, templated
 * pre/post URLs, the intent used for healing and the risk the router computed.
 *
 * The sensitive-literal guard itself lives in the router (action-router §4 step
 * F): a `fill` with a literal into a sensitive field never reaches this class,
 * because it never reaches execution. What this class still enforces is the
 * table rule "other literals are kept only if the target is not a sensitive
 * field" — a literal that somehow arrives on a sensitive target is masked here,
 * so no value can enter a trajectory through the recorder either.
 */

/** The store surface the recorder needs; `TrajectoryStore` satisfies it. */
export interface TrajectoryStorePort {
  createRecorded(input: CreateRecordedInput): unknown;
}

export interface TrajectoryRecorderOptions {
  /** Persistence for `finalize(true)` (memory §6.1: version 1, status `active`). */
  store: TrajectoryStorePort;
  /** Task key the trajectory is stored under (memory §7 `task.key`). */
  taskKey: string;
  /** Non-secret params of the task: URL templating and literal→param promotion. */
  params?: Record<string, string>;
  /** Secret names only — never values (memory §6.1). */
  secretNames?: string[];
}

function originOf(url: string | null): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/** `<role> "<name>"` — the intent a ref/query step is healed by later (memory §6.1). */
function describeElement(result: ActionResult): string | null {
  const element = result.element;
  if (!element) return null;
  return `${element.role} "${element.name}"`;
}

/**
 * Fill/select value per the §6.1 table: `param` and `secret` references ride
 * along untouched, a literal that equals a param value becomes a `param`
 * reference, any other literal survives only on a non-sensitive target.
 */
function recordedValue(action: BrowserAction, params: Record<string, string>, sensitiveTarget: boolean): ValueSource {
  if (action.type !== 'fill' && action.type !== 'select') {
    // Actions without a value (click, hover, …) keep whatever they came with.
    return (action as { value?: ValueSource }).value as ValueSource;
  }
  const value = action.value;
  if (value.kind !== 'literal') return value; // param / secret: reference only

  for (const [name, paramValue] of Object.entries(params)) {
    if (paramValue !== '' && value.value === paramValue) return { kind: 'param', name };
  }

  return sensitiveTarget ? { kind: 'literal', value: MASKED_VALUE } : value;
}

/** Param values in a URL become `{{name}}` placeholders (memory §6.1, `navigate.url`). */
export function templatizeUrl(url: string, params: Record<string, string>): string {
  let out = url;
  for (const [name, value] of Object.entries(params)) {
    if (value === '') continue;
    out = out.split(value).join(`{{${name}}}`);
  }
  return out;
}

function locatorKey(locator: ElementLocator): string {
  return [locator.role, locator.name, locator.tag, locator.cssPath, locator.framePath.join('>')].join('|');
}

export class TrajectoryRecorder implements TrajectoryRecorderPort {
  private readonly store: TrajectoryStorePort;
  private readonly taskKey: string;
  private readonly params: Record<string, string>;
  private readonly secretNames: string[];

  private recording = false;
  private steps: TrajectoryStep[] = [];
  /** URL before the step about to be appended; starts at the task's start URL. */
  private urlBefore: string | null = null;
  /** Where the recording started; persisted as `startUrl`, `origin` derived from it. */
  private startUrl: string | null = null;

  constructor(options: TrajectoryRecorderOptions) {
    this.store = options.store;
    this.taskKey = options.taskKey;
    this.params = options.params ?? {};
    this.secretNames = options.secretNames ?? [];
  }

  /** Open a recording scope; `startUrl` becomes the first step's `pre.urlPattern`. */
  start(startUrl: string | null = null): void {
    this.recording = true;
    this.steps = [];
    this.startUrl = startUrl;
    this.urlBefore = startUrl;
  }

  isRecording(): boolean {
    return this.recording;
  }

  /**
   * Append the step for one successful action (memory §6.1 table). Failed
   * actions never arrive here: the router only calls `append` from the success
   * path of `finish()`.
   */
  append(result: ActionResult, _ctx: ExecutionContext, intent: string | null, risk: RiskLevel): void {
    if (!this.recording || !result.ok) return;

    const action = result.action;
    const locator = result.locator;
    const sensitiveTarget = locator ? isSensitiveField(fieldsOf(locator)) : false;

    // Target: the resolved locator. A step a human performed manually
    // (action-router §5.3 `done`, tier `human` with an intent) keeps
    // `{kind:'intent'}` so replay resolves it through the ladder again.
    let target: Target | undefined = 'target' in action ? (action.target as Target | undefined) : undefined;
    if (intent !== null && result.tier === 'human') {
      target = { kind: 'intent', text: intent };
    } else if (locator) {
      target = { kind: 'locator', locator };
    }

    const recorded: BrowserAction =
      action.type === 'navigate'
        ? { type: 'navigate', url: templatizeUrl(action.url, this.params) }
        : target === undefined
          ? ({ ...action, value: recordedValue(action, this.params, sensitiveTarget) } as BrowserAction)
          : ({
              ...action,
              target,
              value: recordedValue(action, this.params, sensitiveTarget),
            } as BrowserAction);

    this.steps.push({
      index: this.steps.length,
      action: recorded,
      intent: intent ?? (target?.kind === 'intent' ? null : describeElement(result)),
      pre: { urlPattern: pathTemplate(this.urlBefore ?? '', this.params) },
      ...(result.pageChanged && result.url ? { post: { urlPattern: pathTemplate(result.url, this.params) } } : {}),
      risk,
    });

    this.urlBefore = result.url;
  }

  /**
   * Close the scope (memory §6.1). On success the compacted steps are persisted
   * as a fresh trajectory and returned; on failure the buffer is discarded and
   * nothing is written (S13: a failed task must not leave a trajectory behind).
   */
  finalize(success: boolean): TrajectoryStep[] | null {
    const steps = this.steps;
    this.recording = false;
    this.steps = [];
    this.urlBefore = null;

    if (!success || steps.length === 0) return null;

    const compacted = compactSteps(steps);
    const input: CreateRecordedInput = {
      taskKey: this.taskKey,
      origin: originOf(this.startUrl ?? steps[0]?.pre.urlPattern ?? null),
      startUrl: this.startUrl ?? undefined,
      params: Object.keys(this.params),
      secretNames: this.secretNames,
      steps: compacted,
    };
    this.store.createRecorded(input);
    return compacted;
  }

  /**
   * Compaction rules of memory §6.1, applied at `task.end`:
   * consecutive `fill`s on the same locator collapse to the last one, and a
   * `wait` immediately followed by a `waitFor` is dropped.
   */
}

/**
 * Memory §6.1 compaction. Indices are renumbered so the trajectory steps stay
 * 0-based and dense (the replayer indexes them by `step.index`).
 */
export function compactSteps(steps: TrajectoryStep[]): TrajectoryStep[] {
  const out: TrajectoryStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const current = steps[i]!;
    const next = steps[i + 1];

    if (current.action.type === 'wait' && next?.action.type === 'waitFor') continue;

    if (current.action.type === 'fill' && hasTarget(current.action) && current.action.target.kind === 'locator') {
      const previous = out[out.length - 1];
      if (
        previous?.action.type === 'fill' &&
        hasTarget(previous.action) &&
        previous.action.target.kind === 'locator' &&
        locatorKey(previous.action.target.locator) === locatorKey(current.action.target.locator)
      ) {
        out[out.length - 1] = { ...current, index: out.length - 1 };
        continue;
      }
    }

    out.push({ ...current, index: out.length });
  }
  return out;
}

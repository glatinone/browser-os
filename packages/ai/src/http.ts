import { BosError } from '@browser-os/protocol';

export interface HttpRequestOptions {
  timeoutMs: number;
  maxAttempts?: number;
  retryStatuses?: ReadonlySet<number>;
  signal?: AbortSignal;
}

export async function postJson<T>(
  url: string,
  init: { headers: Record<string, string>; body: unknown },
  options: HttpRequestOptions,
): Promise<{ data: T; response: Response; attempts: number }> {
  const maxAttempts = options.maxAttempts ?? 3;
  const retryStatuses = options.retryStatuses ?? new Set([429, 500, 502, 503, 504]);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    const forwardAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: init.headers,
        body: JSON.stringify(init.body),
        signal: controller.signal,
      });
      if (response.ok) {
        return { data: (await response.json()) as T, response, attempts: attempt };
      }
      if (!retryStatuses.has(response.status) || attempt === maxAttempts) {
        throw new BosError('LLM_UNAVAILABLE', `Model endpoint returned HTTP ${response.status}`, {
          retryable: true,
        });
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      await backoff(
        attempt,
        Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 5000) : undefined,
        options.signal,
      );
    } catch (error) {
      lastError = error;
      if (error instanceof BosError && !retryStatuses.has(Number(error.message.match(/HTTP (\d+)/)?.[1]))) throw error;
      if (attempt === maxAttempts) break;
      await backoff(attempt, undefined, options.signal);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }
  throw new BosError('LLM_UNAVAILABLE', 'Model endpoint unavailable after retries', {
    retryable: true,
    cause: lastError,
  });
}

async function backoff(attempt: number, retryAfter: number | undefined, signal?: AbortSignal): Promise<void> {
  const delayMs = retryAfter ?? (attempt === 1 ? 250 : 1000);
  if (delayMs <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('Aborted'));
      },
      { once: true },
    );
  });
}

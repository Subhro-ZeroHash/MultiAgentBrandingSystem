import { ProviderError } from './errors.js';

/**
 * Shared retry/timeout policy for provider calls.
 *
 * Two layers protect a generation job, and they solve different problems:
 * BullMQ already retries a failed job three times with a 10s exponential
 * backoff, which covers a provider being down for a minute. What it does *not*
 * cover is the common case of a single request losing a rate-limit race — that
 * deserves a sub-second retry inside the call rather than re-running the whole
 * pipeline. This module is that inner layer.
 *
 * The rule that matters most: only retry what can actually succeed on a retry.
 * Retrying a permanent failure wastes the job's three BullMQ attempts and turns
 * a clear error into a slow, confusing one.
 */

export interface RetryOptions {
  /** Total attempts including the first. */
  maxAttempts?: number;
  /** Base backoff, doubled per attempt before jitter. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff wait. */
  maxDelayMs?: number;
  signal?: AbortSignal;
  /** Observability hook — callers log or count from here. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
} as const;

/** HTTP statuses worth trying again. 429 is deliberately excluded here and
 *  handled by `isRetryable`, because not every 429 is transient. */
const RETRYABLE_STATUS = new Set([408, 409, 500, 502, 503, 504]);

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const e = error as { status?: unknown; code?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.code === 'number') return e.code;
  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : JSON.stringify(error ?? '');
}

/**
 * Distinguishes a rate limit you can wait out from a quota you cannot.
 *
 * Google returns 429 for both. A burst over the per-minute limit clears in
 * seconds; a project with no quota allocated reports `limit: 0` and will return
 * the same 429 forever, including its own misleading "please retry in 24s".
 * Treating the second as retryable makes a billing misconfiguration look like
 * a flaky network for three minutes before surfacing.
 */
export function isQuotaExhausted(error: unknown): boolean {
  return /limit:\s*0\b/.test(messageOf(error));
}

export function isRetryable(error: unknown): boolean {
  // An adapter that has already classified the failure wins — it knows more
  // about its provider than this generic inspection does.
  if (error instanceof ProviderError) return error.retryable;

  const status = statusOf(error);
  if (status === 429) return !isQuotaExhausted(error);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);

  // Node socket-level failures: worth one more try.
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed/i.test(
    messageOf(error),
  );
}

/**
 * Honour the provider's own guidance when it gives any. Google sends
 * `"retryDelay": "24s"` in RetryInfo; HTTP `Retry-After` is seconds.
 */
export function retryAfterMs(error: unknown): number | undefined {
  const message = messageOf(error);
  const explicit = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  if (explicit?.[1]) return Math.round(Number(explicit[1]) * 1000);

  if (typeof error === 'object' && error !== null) {
    const headers = (error as { headers?: Record<string, string> }).headers;
    const header = headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;
  }
  return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Rejects if `promise` outlives `ms`. A provider that accepts a connection and
 * then stalls would otherwise occupy a worker slot indefinitely — with
 * concurrency 2, two stalled calls halt content generation entirely.
 *
 * Note this bounds the caller's wait, not the provider's work: pass the job's
 * AbortSignal into the adapter as well so the request itself is cancelled.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new ProviderError(`${label} timed out after ${ms}ms`, 'unknown', {
                retryable: true,
              }),
            ),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs `fn`, retrying only failures that a retry could plausibly fix. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !isRetryable(error)) throw error;
      if (options.signal?.aborted) throw error;

      // Full jitter. Variant fan-out fires N identical requests at once, so a
      // fixed backoff would have them all retry in the same instant and
      // reproduce the burst that triggered the rate limit.
      const capped = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const delayMs = retryAfterMs(error) ?? Math.round(Math.random() * capped);

      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, options.signal);
    }
  }

  throw lastError;
}

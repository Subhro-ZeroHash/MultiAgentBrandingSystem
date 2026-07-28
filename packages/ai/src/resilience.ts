import { ProviderError, describeError } from './errors.js';

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

/** Walks `cause` so a status buried under a wrapper is still found. */
function statusOf(error: unknown): number | undefined {
  const seen = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth <= 5 && typeof current === 'object' && current !== null; depth++) {
    if (seen.has(current)) break;
    seen.add(current);

    const e = current as { status?: unknown; code?: unknown; cause?: unknown };
    if (typeof e.status === 'number') return e.status;
    // A string `code` is a Node errno (ECONNRESET), not an HTTP status. A
    // numeric one usually is a status — but not always: DOMException carries a
    // legacy `code` from a small enum (an abort is 20), and reading that as a
    // status made every client-side timeout look like an unrecognised, and so
    // permanent, failure. Requiring the HTTP range keeps those out.
    if (typeof e.code === 'number' && e.code >= 100 && e.code <= 599) return e.code;
    current = e.cause;
  }
  return undefined;
}

/** The whole chain, so classification sees what `fetch failed` is hiding. */
function messageOf(error: unknown): string {
  return describeError(error);
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
  // The zero must stand alone. `\b` alone also matched `limit: 0.5` and
  // `limit: 0.016666` — fractional per-second limits Google really does report
  // — reading a rate limit that clears in a second as a dead quota. Since a
  // permanent verdict now abandons the job outright, that mistake costs a
  // generation rather than a few wasted seconds.
  return /limit:\s*0(?![\d.])/.test(messageOf(error));
}

/**
 * A request the client gave up on rather than one the provider refused.
 *
 * The SDK enforces its own timeout with an AbortController, so a slow provider
 * surfaces as `DOMException: This operation was aborted`, whose name and
 * message look nothing like the socket errors below. Left unrecognised it fell
 * through to "not retryable" and abandoned the job on the first attempt.
 *
 * Retrying a deliberate cancellation would be wrong, but that case never
 * reaches here: `withRetry` checks its own `signal` before every retry.
 */
function isAbort(error: unknown): boolean {
  const name = (error as { name?: unknown })?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  return /\bthis operation was aborted\b|\baborted\b.*\(20\)/i.test(messageOf(error));
}

export function isRetryable(error: unknown): boolean {
  // An adapter that has already classified the failure wins — it knows more
  // about its provider than this generic inspection does.
  if (error instanceof ProviderError) return error.retryable;

  if (isAbort(error)) return true;

  const status = statusOf(error);
  if (status === 429) return !isQuotaExhausted(error);
  if (status !== undefined) return RETRYABLE_STATUS.has(status);

  // Node/undici socket-level failures: worth one more try. `terminated` and the
  // UND_ERR_* codes are how undici reports a connection dropped mid-response,
  // which is the common failure on image calls that hold a socket open for a
  // minute. They only appear on the `cause`, hence the chain-aware messageOf.
  return /ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|EAI_AGAIN|ENOTFOUND|UND_ERR_|socket hang up|terminated|other side closed|fetch failed/i.test(
    messageOf(error),
  );
}

/** Statuses where the request itself is the problem, so sending it again sends
 *  the same wrong request. 429 is judged separately — only a zero quota is
 *  permanent, a burst limit is not. */
const PERMANENT_STATUS = new Set([400, 401, 403, 404, 422]);

/**
 * Whether re-running the work could ever succeed — the question BullMQ needs
 * answered before spending another of the job's attempts.
 *
 * Deliberately not `!isRetryable(error)`. That function answers "is this worth
 * another attempt right now" and returns false for anything it does not
 * recognise, which would promote every unfamiliar transient — a database blip
 * mid-job, a socket error whose code is not in the list — into a hard failure.
 * This one answers the narrower "do we *know* this is permanent", so unknown
 * failures keep their retries and only recognised dead ends give them up.
 *
 * The asymmetry is the point: a wrong "permanent" costs a job that would have
 * succeeded, while a wrong "transient" costs one wasted retry.
 */
export function isPermanentFailure(error: unknown): boolean {
  // The adapter wrapped this provider call and already refused to retry it
  // internally. Its verdict is better informed than the generic inspection
  // below, which only sees whatever survived the wrapping.
  if (error instanceof ProviderError) return !error.retryable;

  // Reached when a raw provider error escapes without an adapter around it.
  if (isQuotaExhausted(error)) return true;

  const status = statusOf(error);
  if (status === undefined) return false;
  if (status === 429) return isQuotaExhausted(error);
  return PERMANENT_STATUS.has(status);
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

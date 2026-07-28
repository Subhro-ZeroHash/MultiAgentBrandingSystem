import { describe, expect, it } from 'vitest';
import { ProviderError, ProviderNotConfiguredError } from './errors.js';
import { isPermanentFailure, isQuotaExhausted, isRetryable, retryAfterMs } from './resilience.js';

/**
 * These three classifiers decide whether money gets spent again. Between them
 * they gate the in-call retry, the whole-pipeline BullMQ retry, and how long we
 * wait — so a wrong answer is either a wasted image generation or a job that
 * gives up on a failure it would have survived.
 */

/** The shape Google actually returns when a project has no allocation. Both the
 *  misleading `retryDelay` and the `limit: 0` matter to the assertions. */
const QUOTA_EXHAUSTED_BODY =
  'got status: 429. {"error":{"code":429,"message":"Quota exceeded for quota metric ' +
  "'Generate requests' and limit 'GenerateRequestsPerMinutePerProjectPerRegion' limit: 0" +
  '","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo",' +
  '"retryDelay":"24s"}]}}';

/** A burst over the per-minute limit: same status, no `limit: 0`. */
const RATE_LIMITED_BODY =
  'got status: 429. {"error":{"code":429,"message":"Resource has been exhausted ' +
  '(e.g. check quota)."}}';

const httpError = (status: number, message = `HTTP ${status}`): Error =>
  Object.assign(new Error(message), { status });

/** undici reports a dropped connection on the cause, not the top-level error. */
const socketError = (code: string): Error =>
  Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error(code), { code }),
  });

describe('isQuotaExhausted', () => {
  it('recognises a zero allocation', () => {
    expect(isQuotaExhausted(new Error(QUOTA_EXHAUSTED_BODY))).toBe(true);
  });

  it('does not confuse an ordinary rate limit for an exhausted quota', () => {
    expect(isQuotaExhausted(new Error(RATE_LIMITED_BODY))).toBe(false);
  });

  it('finds the marker through a wrapper', () => {
    const wrapped = new ProviderError('google.generate failed', 'google', {
      cause: new Error(QUOTA_EXHAUSTED_BODY),
    });
    expect(isQuotaExhausted(wrapped)).toBe(true);
  });

  it('is not fooled by a limit that merely starts with zero', () => {
    expect(isQuotaExhausted(new Error('limit: 0.5 per second'))).toBe(false);
    expect(isQuotaExhausted(new Error('limit: 05'))).toBe(false);
  });
});

describe('isRetryable', () => {
  it('trusts an adapter that already classified the failure', () => {
    // Even though a 500 would otherwise be retryable, the adapter's verdict wins.
    const decided = new ProviderError('google said no', 'google', {
      retryable: false,
      cause: httpError(500),
    });
    expect(isRetryable(decided)).toBe(false);
  });

  it.each([408, 409, 500, 502, 503, 504])('retries transient status %i', (status) => {
    expect(isRetryable(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404])('does not retry client-error status %i', (status) => {
    expect(isRetryable(httpError(status))).toBe(false);
  });

  it('splits 429 by whether the quota can recover', () => {
    expect(isRetryable(httpError(429, RATE_LIMITED_BODY))).toBe(true);
    expect(isRetryable(httpError(429, QUOTA_EXHAUSTED_BODY))).toBe(false);
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET'])(
    'retries socket-level failure %s reported on the cause',
    (code) => {
      expect(isRetryable(socketError(code))).toBe(true);
    },
  );

  it('does not retry a programming error', () => {
    expect(isRetryable(new TypeError('x is not a function'))).toBe(false);
  });

  /**
   * A client-side timeout is the most retryable failure there is, and it was
   * being read as permanent. The SDK aborts its own request when its timeout
   * fires, producing a DOMException whose legacy `code` is 20 — which
   * `statusOf` took for an HTTP status, found unrecognised, and gave up on.
   * This is what made every poster_a4 generation fail on the first attempt.
   */
  it('retries a client-side abort rather than reading its code as a status', () => {
    const abort = new DOMException('This operation was aborted', 'AbortError');
    expect(abort.code, 'precondition: the legacy code is in no HTTP range').toBe(20);
    expect(isRetryable(abort)).toBe(true);
    expect(isPermanentFailure(abort)).toBe(false);
  });

  it('retries an abort surfaced only as a message on the cause chain', () => {
    // What actually reaches the worker: the SDK's DOMException wrapped by the
    // adapter, where only the flattened message survives.
    const wrapped = new Error('google.generate: This operation was aborted (20)', {
      cause: new DOMException('This operation was aborted', 'AbortError'),
    });
    expect(isRetryable(wrapped)).toBe(true);
  });

  it('still ignores a non-HTTP numeric code without calling it retryable', () => {
    // A DOMException that is not an abort must not be swept in by the fix —
    // it simply stops being misread as a status.
    const notFound = new DOMException('node missing', 'NotFoundError');
    expect(notFound.code).toBe(8);
    expect(isRetryable(notFound)).toBe(false);
    expect(isPermanentFailure(notFound), 'unrecognised, so it keeps its retries').toBe(false);
  });
});

describe('isPermanentFailure', () => {
  /**
   * The contract that matters: this is not the inverse of `isRetryable`.
   * `isRetryable` says no to anything it does not recognise, and inverting that
   * would turn an unfamiliar transient into a job that never retries.
   */
  it.each([
    ['a programming error', new TypeError('x is not a function')],
    ['a bare string throw', 'something broke'],
    ['a thrown undefined', undefined],
    ['a plain error with no status', new Error('something went sideways')],
  ])('leaves %s retryable rather than assuming the worst', (_label, unknown) => {
    // The precondition is the point: `isRetryable` declines all of these, so an
    // inverted `isRetryable` would abandon the job. `isPermanentFailure` must not.
    expect(isRetryable(unknown), 'precondition: not recognised as retryable').toBe(false);
    expect(isPermanentFailure(unknown)).toBe(false);
  });

  it('keeps a refused connection retryable', () => {
    // undici surfaces this as `fetch failed` with the code on the cause, which
    // `isRetryable` already matches — a Redis or Postgres blip mid-job must not
    // burn the remaining attempts.
    expect(isPermanentFailure(socketError('ECONNREFUSED'))).toBe(false);
  });

  it('gives up on a quota that cannot recover', () => {
    expect(isPermanentFailure(new Error(QUOTA_EXHAUSTED_BODY))).toBe(true);
  });

  it('keeps retrying a rate limit that can', () => {
    expect(isPermanentFailure(httpError(429, RATE_LIMITED_BODY))).toBe(false);
  });

  it.each([400, 401, 403, 404, 422])('gives up on client-error status %i', (status) => {
    expect(isPermanentFailure(httpError(status))).toBe(true);
  });

  it.each([500, 502, 503, 504])('keeps retrying server-error status %i', (status) => {
    expect(isPermanentFailure(httpError(status))).toBe(false);
  });

  it("defers to the adapter's own verdict", () => {
    const permanent = new ProviderError('quota exhausted', 'google', { retryable: false });
    const transient = new ProviderError('timed out', 'google', { retryable: true });
    expect(isPermanentFailure(permanent)).toBe(true);
    expect(isPermanentFailure(transient)).toBe(false);
  });

  it('gives up when the provider is not configured at all', () => {
    expect(isPermanentFailure(new ProviderNotConfiguredError('google', 'GOOGLE_API_KEY'))).toBe(
      true,
    );
  });
});

describe('retryAfterMs', () => {
  it("uses the provider's own RetryInfo when present", () => {
    expect(retryAfterMs(new Error(QUOTA_EXHAUSTED_BODY))).toBe(24_000);
  });

  it('reads a Retry-After header in seconds', () => {
    expect(retryAfterMs(Object.assign(new Error('slow down'), { headers: { 'retry-after': '5' } }))).toBe(
      5_000,
    );
  });

  it('returns undefined when the provider gives no guidance', () => {
    expect(retryAfterMs(new Error('nope'))).toBeUndefined();
  });
});

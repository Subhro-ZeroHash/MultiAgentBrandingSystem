/**
 * Thin typed clients for the two backends. The route groups under
 * `src/app/(studio)` and `src/app/(geo)` each talk to one of these, so the two
 * workstreams share the shell without sharing data-fetching code.
 */

import type { AuthUser } from '@bmas/shared';

const CONTENT_API = process.env.NEXT_PUBLIC_CONTENT_API_URL ?? 'http://localhost:4000';
const GEO_API = process.env.NEXT_PUBLIC_GEO_API_URL ?? 'http://localhost:4100';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ---------------------------------------------------------------------------
// Auth
//
// The access token lives in memory only — never in localStorage, which any
// script on the page could read. It doesn't survive a reload; AuthProvider's
// mount effect restores it via /api/auth/refresh, which reads the httpOnly
// refresh cookie client JS can never see at all.
// ---------------------------------------------------------------------------

let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

/**
 * Dedupes concurrent refresh attempts into one call — without this, a burst
 * of requests hitting an expired access token at once would each try to
 * refresh independently. This isn't just an optimization: content-api
 * rotates the refresh token on every use, so two genuinely-concurrent calls
 * (e.g. AuthProvider's mount effect racing a page's own first data fetch,
 * both starting before either has a token yet) would have the second one
 * present an already-rotated-out token and get rejected — silently signing
 * the visitor back out from what looks like a real session. Exported so
 * AuthProvider's mount effect shares this exact guard instead of calling
 * /api/auth/refresh on its own, which is what let that race happen.
 */
let refreshingSession: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (!refreshingSession) {
    refreshingSession = fetch('/api/auth/refresh', { method: 'POST', cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return null;
        const data = (await response.json()) as { accessToken: string };
        setAccessToken(data.accessToken);
        return data.accessToken;
      })
      .catch(() => null)
      .finally(() => {
        refreshingSession = null;
      });
  }
  return refreshingSession;
}

async function request<T>(
  base: string,
  path: string,
  init?: RequestInit,
  skipAuthRetry = false,
): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init?.headers,
    },
    // Health and dashboard reads must not be served from a stale build cache.
    cache: 'no-store',
  });

  // Access tokens are short-lived by design — a 401 here is the expected,
  // routine case of one having expired mid-session, not necessarily a real
  // auth failure. Silently refresh and retry once before surfacing anything.
  if (response.status === 401 && !skipAuthRetry) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(base, path, init, true);
  }

  if (!response.ok) {
    // NestJS's default exception filter shapes the body as { message, ... } —
    // for a BadRequestException (e.g. automation-settings.service.ts's
    // auto-publish/policy check) that message is the actual, actionable
    // reason, not just "PATCH failed". Best-effort: falls back to the generic
    // message if the body isn't JSON or doesn't have that shape.
    const fallback = `${init?.method ?? 'GET'} ${path} failed`;
    const detail = await response
      .clone()
      .json()
      .then((body: unknown) =>
        typeof body === 'object' &&
        body !== null &&
        'message' in body &&
        typeof body.message === 'string'
          ? body.message
          : null,
      )
      .catch(() => null);
    throw new ApiError(detail ?? fallback, response.status);
  }

  return response.json() as Promise<T>;
}

export const contentApi = {
  get: <T>(path: string) => request<T>(CONTENT_API, path),
  post: <T>(path: string, body: unknown) =>
    request<T>(CONTENT_API, path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(CONTENT_API, path, { method: 'PATCH', body: JSON.stringify(body) }),
};

export const geoApi = {
  get: <T>(path: string) => request<T>(GEO_API, path),
  post: <T>(path: string, body: unknown) =>
    request<T>(GEO_API, path, { method: 'POST', body: JSON.stringify(body) }),
};

/** What AuthProvider calls right after a refresh to recover the user a
 *  restored access token belongs to — refresh itself returns only tokens. */
export function fetchCurrentUser(): Promise<AuthUser> {
  return contentApi.get<AuthUser>('/auth/me');
}

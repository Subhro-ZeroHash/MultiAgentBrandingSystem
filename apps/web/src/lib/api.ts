/**
 * Thin typed clients for the two backends. The route groups under
 * `src/app/(studio)` and `src/app/(geo)` each talk to one of these, so the two
 * workstreams share the shell without sharing data-fetching code.
 */

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

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    // Health and dashboard reads must not be served from a stale build cache.
    cache: 'no-store',
  });

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
  get: <T>(path: string, headers?: Record<string, string>) =>
    request<T>(CONTENT_API, path, { headers }),
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(CONTENT_API, path, { method: 'POST', body: JSON.stringify(body), headers }),
  patch: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(CONTENT_API, path, { method: 'PATCH', body: JSON.stringify(body), headers }),
};

export const geoApi = {
  get: <T>(path: string) => request<T>(GEO_API, path),
  post: <T>(path: string, body: unknown) =>
    request<T>(GEO_API, path, { method: 'POST', body: JSON.stringify(body) }),
};

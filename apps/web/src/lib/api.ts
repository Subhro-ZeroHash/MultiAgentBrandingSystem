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
    throw new ApiError(`${init?.method ?? 'GET'} ${path} failed`, response.status);
  }

  return response.json() as Promise<T>;
}

export const contentApi = {
  get: <T>(path: string) => request<T>(CONTENT_API, path),
  post: <T>(path: string, body: unknown, headers?: Record<string, string>) =>
    request<T>(CONTENT_API, path, { method: 'POST', body: JSON.stringify(body), headers }),
};

export const geoApi = {
  get: <T>(path: string) => request<T>(GEO_API, path),
  post: <T>(path: string, body: unknown) =>
    request<T>(GEO_API, path, { method: 'POST', body: JSON.stringify(body) }),
};

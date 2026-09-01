import { cookies } from 'next/headers';
import { CONTENT_API_URL, REFRESH_COOKIE_NAME, refreshCookieOptions } from '@/lib/auth-cookie';

/**
 * Mints a fresh access token from the httpOnly refresh cookie. Called both
 * on app mount (a page load has no access token anywhere client-readable to
 * restore) and by the client's own 401-triggered retry in lib/api.ts.
 *
 * content-api rotates the refresh token on every use, so the cookie is
 * rewritten here too — skipping that would mean a token that still works
 * server-side (this call succeeded) but isn't the one saved in the browser,
 * and the next refresh would fail as a replay of an already-consumed token.
 */
export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_COOKIE_NAME)?.value;
  if (!refreshToken) {
    return Response.json({ message: 'Not authenticated' }, { status: 401 });
  }

  const upstream = await fetch(`${CONTENT_API_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream) {
    return Response.json({ message: 'content-api is unreachable' }, { status: 502 });
  }

  const data: unknown = await upstream.json().catch(() => null);
  if (!upstream.ok || !data || typeof data !== 'object') {
    // The stored refresh token is dead either way (expired, revoked, or
    // already rotated by another request) — no point keeping a cookie that
    // will only fail the same way again.
    cookieStore.delete(REFRESH_COOKIE_NAME);
    return Response.json(data ?? { message: 'Session expired' }, { status: upstream.status });
  }

  const { accessToken, refreshToken: nextRefreshToken } = data as {
    accessToken: string;
    refreshToken: string;
  };
  cookieStore.set(REFRESH_COOKIE_NAME, nextRefreshToken, refreshCookieOptions());

  return Response.json({ accessToken });
}

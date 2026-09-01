import { cookies } from 'next/headers';
import { CONTENT_API_URL, REFRESH_COOKIE_NAME, refreshCookieOptions } from '@/lib/auth-cookie';

/**
 * Proxies to content-api's own /auth/login and splits the response: the
 * refresh token goes into an httpOnly cookie this route sets (client JS
 * never touches it), only the access token and user go back to the browser.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  const upstream = await fetch(`${CONTENT_API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    cache: 'no-store',
  }).catch(() => null);

  if (!upstream) {
    return Response.json({ message: 'content-api is unreachable' }, { status: 502 });
  }

  const data: unknown = await upstream.json().catch(() => null);
  if (!upstream.ok || !data || typeof data !== 'object') {
    return Response.json(data ?? { message: 'Login failed' }, { status: upstream.status });
  }

  const { user, accessToken, refreshToken } = data as {
    user: unknown;
    accessToken: string;
    refreshToken: string;
  };

  const cookieStore = await cookies();
  cookieStore.set(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());

  return Response.json({ user, accessToken });
}

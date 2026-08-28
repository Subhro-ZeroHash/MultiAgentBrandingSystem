import { cookies } from 'next/headers';
import { CONTENT_API_URL, REFRESH_COOKIE_NAME } from '@/lib/auth-cookie';

/**
 * Revokes the refresh token server-side, then clears the cookie regardless
 * of whether that call succeeded — a network blip reaching content-api must
 * not block the local sign-out the user is actually waiting on, same
 * reasoning demo-frontend's AuthContext.logout gives for the mobile app.
 */
export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  const refreshToken = cookieStore.get(REFRESH_COOKIE_NAME)?.value;

  if (refreshToken) {
    await fetch(`${CONTENT_API_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    }).catch(() => undefined);
  }

  cookieStore.delete(REFRESH_COOKIE_NAME);
  return Response.json({ ok: true });
}

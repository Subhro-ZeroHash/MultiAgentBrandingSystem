/**
 * Shared between the three /api/auth/* route handlers — the refresh token
 * lives only as an httpOnly cookie, so it's never readable by client JS
 * (unlike a plain localStorage token, which any script on the page could
 * read). Kept here rather than duplicated three times so the cookie options
 * can't quietly drift between login/refresh/logout.
 */

export const REFRESH_COOKIE_NAME = 'refresh_token';

// Matches content-api's own refresh token lifetime (REFRESH_TOKEN_TTL_MS in
// auth.service.ts) — the cookie shouldn't outlive the token it holds, or
// expire it early either.
const REFRESH_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    path: '/',
    maxAge: REFRESH_MAX_AGE_SECONDS,
  };
}

export const CONTENT_API_URL =
  process.env.CONTENT_API_URL ?? process.env.NEXT_PUBLIC_CONTENT_API_URL ?? 'http://localhost:4000';

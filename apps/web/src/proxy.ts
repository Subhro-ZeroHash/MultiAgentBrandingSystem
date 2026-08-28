import { NextResponse, type NextRequest } from 'next/server';
import { REFRESH_COOKIE_NAME } from '@/lib/auth-cookie';

/**
 * Gate at the edge: no refresh cookie, no page. This is a UX redirect, not
 * the real security boundary — presence-only, not signature-checked — and
 * that's fine, because the actual boundary is content-api's own JwtAuthGuard
 * on every data call this app makes (see lib/api.ts). A forged cookie value
 * gets a visitor past this redirect and straight into a wall of 401s from
 * the API, never real data.
 */
export function proxy(request: NextRequest): NextResponse {
  const hasSession = Boolean(request.cookies.get(REFRESH_COOKIE_NAME)?.value);
  if (!hasSession) {
    return NextResponse.redirect(new URL('/login', request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Everything except: the login page itself (would redirect-loop otherwise),
  // /api/* (the three auth routes must be reachable to sign in at all; the
  // asset proxy is deliberately public — see its own file), the Instagram
  // OAuth callback (a same-origin SameSite=Lax cookie should already survive
  // that redirect, but this avoids a confusing bounce through /login in the
  // middle of connecting an account if it somehow doesn't), and Next's
  // static/internal paths.
  matcher: ['/((?!login|api|auth/instagram|_next/static|_next/image|favicon.ico).*)'],
};

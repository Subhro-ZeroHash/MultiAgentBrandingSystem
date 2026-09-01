'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import type { AuthUser } from '@bmas/shared';
import { ApiError, fetchCurrentUser, refreshAccessToken, setAccessToken } from '@/lib/api';

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  /** True until the httpOnly refresh cookie (if any) has been checked
   *  against the API. middleware.ts already redirects a signed-out visitor
   *  to /login before any page renders, so this only covers the gap between
   *  a signed-in page loading and its access token actually being restored. */
  isInitializing: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const router = useRouter();

  // A page load has no access token anywhere client-readable — restore one
  // from the httpOnly refresh cookie, then recover the user it belongs to.
  // Failing either (no cookie, or content-api rejects the refresh token)
  // just leaves the visitor signed out; the proxy handles getting them to
  // /login, this effect doesn't need to.
  //
  // Goes through the shared refreshAccessToken() rather than calling
  // /api/auth/refresh directly: a page's own first data fetch can 401 and
  // trigger lib/api.ts's own retry-refresh before this effect finishes, and
  // since refresh tokens rotate on use, two independent un-deduped calls
  // racing here meant the loser got rejected and silently signed back out —
  // a real bug caught by testing this live, not a hypothetical.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const token = await refreshAccessToken();
        if (!token) return;
        const me = await fetchCurrentUser();
        if (!cancelled) setUser(me);
      } catch {
        setAccessToken(null);
      } finally {
        if (!cancelled) setIsInitializing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          data && typeof data === 'object' && 'message' in data && typeof data.message === 'string'
            ? data.message
            : 'Login failed';
        throw new ApiError(message, response.status);
      }
      const { user: loggedInUser, accessToken } = data as { user: AuthUser; accessToken: string };
      setAccessToken(accessToken);
      setUser(loggedInUser);
      router.replace('/');
    },
    [router],
  );

  const logout = useCallback(async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setAccessToken(null);
    setUser(null);
    router.replace('/login');
  }, [router]);

  const value = useMemo<AuthContextValue>(
    () => ({ user, isAuthenticated: !!user, isInitializing, login, logout }),
    [user, isInitializing, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}
